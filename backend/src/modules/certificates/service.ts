/**
 * Unified cert-manager Certificate provisioning.
 *
 * Phase 2c replaced two overlapping cert code paths (annotation-driven
 * from `domains/k8s-ingress.ts` + explicit `ssl-certs/cert-manager.ts
 * provisionCertificate`) with this single module. It is the only place
 * in the backend that creates, updates, or deletes cert-manager
 * Certificate CRs. Callers:
 *
 *   - domains/service.ts createDomain/updateDomain/deleteDomain
 *   - ingress-routes/routes.ts createRoute/deleteRoute
 *   - email-domains/service.ts enableEmail/disableEmail (for webmail)
 *
 * Strategy — see docs/06-features/TLS_CERTIFICATE_STRATEGY.md for the
 * full write-up. Summary:
 *
 *   - dnsMode=primary + PowerDNS + production → wildcard DNS-01 cert
 *     covering [<domain>, *.<domain>], shared secret
 *   - everything else → per-hostname HTTP-01 cert (one per ingress
 *     route), existing secret-per-hostname layout preserved
 *   - dev environment → local-ca-issuer (self-signed), no ACME
 *
 * All Certificate CRs live in the client's kubernetesNamespace so that
 * the Ingress that references them can find the TLS secret (cert-manager
 * secrets are namespace-scoped).
 */

import { eq } from 'drizzle-orm';
import { domains, clients } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { isAutoTlsEnabled, getClusterIssuerName } from '../tls-settings/service.js';
import { getActiveServersForDomain } from '../dns-servers/service.js';
import {
  selectIssuerForDomain,
  type CertEnvironment,
  type ConfiguredIssuers,
} from './issuer-selector.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

export interface CertLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

const noopLogger: CertLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ─── Naming helpers ───────────────────────────────────────────────────────

/**
 * Convert a hostname to a DNS-1123 safe slug, max 50 chars, no trailing
 * hyphens. Matches the legacy ssl-certs/cert-manager.ts domainToSecretName
 * algorithm so existing secrets keep their names and don't need migration.
 */
function slugify(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/\*/g, 'wildcard') // wildcard certs include * in dnsNames
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, ''); // re-strip after slice
}

export function certificateNameFor(domainName: string, wildcard: boolean): string {
  const base = slugify(domainName);
  const suffix = wildcard ? '-wildcard-cert' : '-cert';
  // Ensure the total length stays within k8s DNS-1123 label limit (63)
  const maxBase = 63 - suffix.length;
  return `${base.slice(0, maxBase)}${suffix}`;
}

export function tlsSecretNameFor(domainName: string, wildcard: boolean): string {
  const base = slugify(domainName);
  const suffix = wildcard ? '-wildcard-tls' : '-tls';
  const maxBase = 63 - suffix.length;
  return `${base.slice(0, maxBase)}${suffix}`;
}

// ─── Issuer configuration ─────────────────────────────────────────────────

function getEnvironment(): CertEnvironment {
  const raw = process.env.CERT_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development';
  if (raw === 'production' || raw === 'staging') return raw;
  return 'development';
}

/**
 * Default ClusterIssuer names, matching the manifests in
 * k8s/base/cert-manager/ and k8s/overlays/dev/cert-manager/. Can be
 * overridden per-issuer via env vars for custom cluster setups.
 */
function getConfiguredIssuers(): ConfiguredIssuers {
  return {
    letsencryptProdHttp01:
      process.env.CERT_ISSUER_PROD_HTTP01 ?? 'letsencrypt-prod-http01',
    letsencryptStagingHttp01:
      process.env.CERT_ISSUER_STAGING_HTTP01 ?? 'letsencrypt-staging-http01',
    letsencryptProdDns01Powerdns:
      process.env.CERT_ISSUER_PROD_DNS01_POWERDNS ?? 'letsencrypt-prod-dns01-powerdns',
    localCaIssuer:
      process.env.CERT_ISSUER_LOCAL_CA ?? 'local-ca-issuer',
    fallbackIssuer:
      process.env.CERT_ISSUER_FALLBACK ?? 'letsencrypt-prod-http01',
  };
}

// ─── k8s error helpers ────────────────────────────────────────────────────

function k8sStatusCode(err: unknown): number | undefined {
  const e = err as { statusCode?: number; response?: { statusCode?: number }; code?: number };
  if (typeof e?.statusCode === 'number') return e.statusCode;
  if (typeof e?.response?.statusCode === 'number') return e.response.statusCode;
  if (typeof e?.code === 'number') return e.code;
  if (err instanceof Error) {
    const m = err.message.match(/HTTP-Code:\s*(\d{3})/);
    if (m) return parseInt(m[1], 10);
  }
  return undefined;
}

function isK8s404(err: unknown): boolean {
  return k8sStatusCode(err) === 404;
}

function isK8s409(err: unknown): boolean {
  return k8sStatusCode(err) === 409;
}

// ─── Certificate CR builder ───────────────────────────────────────────────

function buildCertificateResource(params: {
  readonly name: string;
  readonly namespace: string;
  readonly secretName: string;
  readonly dnsNames: readonly string[];
  readonly issuerName: string;
}) {
  return {
    apiVersion: 'cert-manager.io/v1',
    kind: 'Certificate',
    metadata: {
      name: params.name,
      namespace: params.namespace,
      labels: {
        'app.kubernetes.io/part-of': 'hosting-platform',
        'app.kubernetes.io/managed-by': 'k8s-hosting-platform',
        'app.kubernetes.io/component': 'tls-cert',
      },
    },
    spec: {
      secretName: params.secretName,
      dnsNames: [...params.dnsNames],
      issuerRef: {
        name: params.issuerName,
        kind: 'ClusterIssuer',
        group: 'cert-manager.io',
      },
      duration: '2160h', // 90 days (Let's Encrypt max)
      renewBefore: '360h', // 15 days before expiry
    },
  };
}

// ─── Public API ───────────────────────────────────────────────────────────

export interface EnsureCertificateResult {
  readonly skipped: boolean;
  readonly reason?: string;
  readonly issuerName?: string;
  readonly certificateName?: string;
  readonly secretName?: string;
  readonly dnsNames?: readonly string[];
  readonly wildcard?: boolean;
}

/**
 * Ensure a TLS certificate exists for the given domain.
 *
 * Idempotent: safe to call repeatedly. If the Certificate CR already
 * exists, it's replaced (not left stale), so changes to the selector
 * logic (e.g. wildcard → non-wildcard) propagate on next reconcile.
 *
 * Behaviour matrix:
 *   - auto-TLS disabled → no-op, returns { skipped: true }
 *   - no k8s client → no-op, returns { skipped: true }
 *   - otherwise → create/replace Certificate CR in the client namespace
 */
export async function ensureDomainCertificate(
  db: Database,
  k8s: K8sClients | undefined,
  domainId: string,
  logger: CertLogger = noopLogger,
): Promise<EnsureCertificateResult> {
  if (!(await isAutoTlsEnabled(db))) {
    logger.info({ domainId }, 'ensureDomainCertificate: auto-TLS disabled, skipping');
    return { skipped: true, reason: 'auto-TLS disabled' };
  }

  if (!k8s) {
    logger.warn({ domainId }, 'ensureDomainCertificate: no k8s client, skipping');
    return { skipped: true, reason: 'no k8s client' };
  }

  const [domain] = await db.select().from(domains).where(eq(domains.id, domainId));
  if (!domain) {
    throw new ApiError('DOMAIN_NOT_FOUND', `Domain '${domainId}' not found`, 404);
  }

  const [client] = await db.select().from(clients).where(eq(clients.id, domain.clientId));
  if (!client) {
    throw new ApiError('CLIENT_NOT_FOUND', `Client '${domain.clientId}' not found`, 404);
  }
  const namespace = client.kubernetesNamespace;

  // Resolve DNS authority inputs
  const activeServers = await getActiveServersForDomain(db, domainId);
  const environment = getEnvironment();
  const issuers = getConfiguredIssuers();

  // For customer domains we always try to issue a wildcard if possible —
  // it covers apex, all existing subdomains, and anything we add in the
  // future (webmail, mail, autodiscover, …) with one cert.
  const selection = selectIssuerForDomain({
    dnsMode: domain.dnsMode as 'primary' | 'cname' | 'secondary',
    activeServers: activeServers.map((s) => ({
      id: s.id,
      providerType: s.providerType,
      enabled: s.enabled,
      role: s.role,
    })),
    wildcardRequested: true,
    environment,
    issuers,
  });

  // Verify the configured fallback issuer exists (safety check — a
  // mistyped env var would otherwise result in a permanently Pending
  // Certificate CR). We just log a warning if we can't look it up;
  // cert-manager will still surface the real error at reconcile time.
  const defaultIssuerFromDb = await getClusterIssuerName(db).catch(() => null);
  if (defaultIssuerFromDb && defaultIssuerFromDb !== selection.issuerName) {
    logger.info(
      { selected: selection.issuerName, default: defaultIssuerFromDb, domain: domain.domainName },
      'ensureDomainCertificate: selected issuer differs from tls-settings default — using selector choice',
    );
  }

  const wildcard = selection.wildcardCapable && selection.challengeType !== 'http01';
  const dnsNames = wildcard
    ? [domain.domainName, `*.${domain.domainName}`]
    : [domain.domainName];

  const certName = certificateNameFor(domain.domainName, wildcard);
  const secretName = tlsSecretNameFor(domain.domainName, wildcard);

  const body = buildCertificateResource({
    name: certName,
    namespace,
    secretName,
    dnsNames,
    issuerName: selection.issuerName,
  });

  try {
    await k8s.custom.createNamespacedCustomObject({
      group: 'cert-manager.io',
      version: 'v1',
      namespace,
      plural: 'certificates',
      body,
    });
  } catch (err) {
    if (isK8s409(err)) {
      // Already exists — replace to reflect any spec changes
      try {
        await k8s.custom.replaceNamespacedCustomObject({
          group: 'cert-manager.io',
          version: 'v1',
          namespace,
          plural: 'certificates',
          name: certName,
          body,
        });
      } catch (replaceErr) {
        logger.error(
          { replaceErr, domain: domain.domainName, certName },
          'ensureDomainCertificate: replace failed',
        );
        throw new ApiError(
          'CERT_PROVISIONING_FAILED',
          `Failed to replace Certificate for '${domain.domainName}': ${(replaceErr as Error).message}`,
          502,
          { domain: domain.domainName },
        );
      }
    } else {
      logger.error(
        { err, domain: domain.domainName, certName },
        'ensureDomainCertificate: create failed',
      );
      throw new ApiError(
        'CERT_PROVISIONING_FAILED',
        `Failed to create Certificate for '${domain.domainName}': ${(err as Error).message}`,
        502,
        { domain: domain.domainName },
      );
    }
  }

  logger.info(
    { domain: domain.domainName, issuer: selection.issuerName, wildcard, dnsNames },
    'ensureDomainCertificate: Certificate ensured',
  );

  return {
    skipped: false,
    issuerName: selection.issuerName,
    certificateName: certName,
    secretName,
    dnsNames,
    wildcard,
  };
}

/**
 * Delete the Certificate CR and TLS Secret for a domain. Idempotent.
 *
 * Called when a customer domain is deleted. Safe on 404 (already gone).
 * Tries BOTH the wildcard and non-wildcard cert names so stale certs
 * from before a dnsMode transition also get cleaned up.
 */
export async function deleteDomainCertificate(
  db: Database,
  k8s: K8sClients | undefined,
  domainId: string,
  logger: CertLogger = noopLogger,
): Promise<void> {
  if (!k8s) {
    logger.warn({ domainId }, 'deleteDomainCertificate: no k8s client, skipping');
    return;
  }

  const [domain] = await db.select().from(domains).where(eq(domains.id, domainId));
  if (!domain) {
    logger.info({ domainId }, 'deleteDomainCertificate: domain not found, no-op');
    return;
  }

  const [client] = await db.select().from(clients).where(eq(clients.id, domain.clientId));
  if (!client) {
    logger.info({ domainId }, 'deleteDomainCertificate: client not found, no-op');
    return;
  }
  const namespace = client.kubernetesNamespace;

  // Delete both wildcard and non-wildcard variants since we may be in
  // the middle of a dnsMode transition where both previously existed.
  const names: ReadonlyArray<{ cert: string; secret: string }> = [
    {
      cert: certificateNameFor(domain.domainName, true),
      secret: tlsSecretNameFor(domain.domainName, true),
    },
    {
      cert: certificateNameFor(domain.domainName, false),
      secret: tlsSecretNameFor(domain.domainName, false),
    },
  ];

  for (const { cert, secret } of names) {
    try {
      await k8s.custom.deleteNamespacedCustomObject({
        group: 'cert-manager.io',
        version: 'v1',
        namespace,
        plural: 'certificates',
        name: cert,
      });
    } catch (err) {
      if (!isK8s404(err)) {
        logger.warn(
          { err, domain: domain.domainName, cert },
          'deleteDomainCertificate: Certificate delete failed (non-404)',
        );
      }
    }

    try {
      await k8s.core.deleteNamespacedSecret({
        namespace,
        name: secret,
      });
    } catch (err) {
      if (!isK8s404(err)) {
        logger.warn(
          { err, domain: domain.domainName, secret },
          'deleteDomainCertificate: Secret delete failed (non-404)',
        );
      }
    }
  }

  logger.info({ domain: domain.domainName }, 'deleteDomainCertificate: cleanup complete');
}

/**
 * Re-run ensureDomainCertificate for every domain belonging to a client.
 *
 * Used when something changes that affects issuer selection for all of
 * the client's domains — for example, a new DNS provider is added to
 * their group, or an operator flips auto-TLS on/off.
 */
export async function recomputeAllCertificatesForClient(
  db: Database,
  k8s: K8sClients | undefined,
  clientId: string,
  logger: CertLogger = noopLogger,
): Promise<void> {
  const rows = await db
    .select({ id: domains.id, domainName: domains.domainName })
    .from(domains)
    .where(eq(domains.clientId, clientId));
  for (const row of rows) {
    try {
      await ensureDomainCertificate(db, k8s, row.id, logger);
    } catch (err) {
      logger.error(
        { err, domainId: row.id, domain: row.domainName },
        'recomputeAllCertificatesForClient: ensureDomainCertificate failed',
      );
    }
  }
}

// ─── Per-hostname certificate provisioning ───────────────────────────────

/**
 * Check whether a hostname is covered by a domain's wildcard cert.
 *
 * A wildcard cert `*.acme.com` covers immediate subdomains (one label
 * deep) of `acme.com`. It does NOT cover `acme.com` itself (that's why
 * we also include the apex as a second SAN) and does NOT cover
 * deeper hostnames like `foo.bar.acme.com`.
 */
export function hostnameIsCoveredByDomainCert(
  hostname: string,
  domainName: string,
  wildcard: boolean,
): boolean {
  const lowerHost = hostname.toLowerCase();
  const lowerDomain = domainName.toLowerCase();
  if (lowerHost === lowerDomain) return true;
  if (!wildcard) return false;
  const suffix = `.${lowerDomain}`;
  if (!lowerHost.endsWith(suffix)) return false;
  // Single-label subdomain only (wildcards are not recursive per RFC 6125)
  const prefix = lowerHost.slice(0, -suffix.length);
  return prefix.length > 0 && !prefix.includes('.');
}

export interface EnsureRouteCertificateResult {
  readonly skipped: boolean;
  readonly reason?: string;
  readonly secretName?: string;
  readonly sharedWithDomain?: boolean; // true if reusing the domain-level cert
  readonly issuerName?: string;
}

/**
 * Ensure a TLS cert exists for a specific ingress-route hostname.
 *
 * Strategy:
 *   1. Call ensureDomainCertificate for the owning domain first — if
 *      that produces a wildcard cert that covers this hostname, we're
 *      done and return the shared secret name.
 *   2. If the hostname isn't covered by the domain cert (e.g. not in
 *      wildcard mode, or the hostname is too deep), create a
 *      per-hostname Certificate CR alongside the domain cert.
 */
export async function ensureRouteCertificate(
  db: Database,
  k8s: K8sClients | undefined,
  domainId: string,
  hostname: string,
  logger: CertLogger = noopLogger,
): Promise<EnsureRouteCertificateResult> {
  if (!(await isAutoTlsEnabled(db))) {
    return { skipped: true, reason: 'auto-TLS disabled' };
  }
  if (!k8s) {
    return { skipped: true, reason: 'no k8s client' };
  }

  const [domain] = await db.select().from(domains).where(eq(domains.id, domainId));
  if (!domain) {
    throw new ApiError('DOMAIN_NOT_FOUND', `Domain '${domainId}' not found`, 404);
  }

  const [client] = await db.select().from(clients).where(eq(clients.id, domain.clientId));
  if (!client) {
    throw new ApiError('CLIENT_NOT_FOUND', `Client '${domain.clientId}' not found`, 404);
  }
  const namespace = client.kubernetesNamespace;

  // Step 1: ensure the domain-level cert. If it produces a wildcard or
  // matches the hostname as apex, we can reuse its secret.
  const domainCert = await ensureDomainCertificate(db, k8s, domainId, logger);
  if (
    !domainCert.skipped &&
    domainCert.secretName &&
    hostnameIsCoveredByDomainCert(hostname, domain.domainName, domainCert.wildcard === true)
  ) {
    return {
      skipped: false,
      secretName: domainCert.secretName,
      sharedWithDomain: true,
      issuerName: domainCert.issuerName,
    };
  }

  // Step 2: hostname not covered — create a per-hostname cert. Use the
  // same issuer the domain cert used (typically the HTTP-01 issuer;
  // DNS-01 wildcards would have been covered above).
  const activeServers = await getActiveServersForDomain(db, domainId);
  const environment = getEnvironment();
  const issuers = getConfiguredIssuers();
  const selection = selectIssuerForDomain({
    dnsMode: domain.dnsMode as 'primary' | 'cname' | 'secondary',
    activeServers: activeServers.map((s) => ({
      id: s.id,
      providerType: s.providerType,
      enabled: s.enabled,
      role: s.role,
    })),
    wildcardRequested: false, // per-hostname cert — no wildcard here
    environment,
    issuers,
  });

  const certName = certificateNameFor(hostname, false);
  const secretName = tlsSecretNameFor(hostname, false);

  const body = buildCertificateResource({
    name: certName,
    namespace,
    secretName,
    dnsNames: [hostname],
    issuerName: selection.issuerName,
  });

  try {
    await k8s.custom.createNamespacedCustomObject({
      group: 'cert-manager.io',
      version: 'v1',
      namespace,
      plural: 'certificates',
      body,
    });
  } catch (err) {
    if (isK8s409(err)) {
      try {
        await k8s.custom.replaceNamespacedCustomObject({
          group: 'cert-manager.io',
          version: 'v1',
          namespace,
          plural: 'certificates',
          name: certName,
          body,
        });
      } catch (replaceErr) {
        logger.error(
          { replaceErr, hostname, certName },
          'ensureRouteCertificate: replace failed',
        );
        throw new ApiError(
          'CERT_PROVISIONING_FAILED',
          `Failed to replace Certificate for '${hostname}': ${(replaceErr as Error).message}`,
          502,
          { hostname },
        );
      }
    } else {
      logger.error(
        { err, hostname, certName },
        'ensureRouteCertificate: create failed',
      );
      throw new ApiError(
        'CERT_PROVISIONING_FAILED',
        `Failed to create Certificate for '${hostname}': ${(err as Error).message}`,
        502,
        { hostname },
      );
    }
  }

  logger.info(
    { hostname, issuer: selection.issuerName },
    'ensureRouteCertificate: per-hostname Certificate ensured',
  );

  return {
    skipped: false,
    secretName,
    sharedWithDomain: false,
    issuerName: selection.issuerName,
  };
}
