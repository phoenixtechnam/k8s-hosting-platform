/**
 * Phase 2b: per-client custom webmail hostname.
 *
 * Creates / deletes a Kubernetes Ingress + cert-manager Certificate so the
 * shared Roundcube deployment in the `mail` namespace is reachable at a
 * client-specific hostname like `webmail.client-a.com`.
 *
 * Single hostname per client (unique constraint on client_id) for MVP.
 * Phase 2c will add multi-hostname support, ownership verification,
 * and DNS auto-provisioning via the existing dns-servers adapter.
 */

import crypto from 'crypto';
import { eq, and } from 'drizzle-orm';
import { webmailDomains, clients } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { getClusterIssuerName, isAutoTlsEnabled } from '../tls-settings/service.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { CreateWebmailDomainInput } from '@k8s-hosting/api-contracts';

const MAIL_NAMESPACE = 'mail';
const ROUNDCUBE_SERVICE_NAME = 'roundcube';
const ROUNDCUBE_SERVICE_PORT = 80;

// Minimal logger shape so this module can be unit-tested without pulling in
// a full Fastify instance. Any compatible pino/bunyan logger works.
export interface WebmailLogger {
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

const noopLogger: WebmailLogger = { warn: () => {}, error: () => {} };

/**
 * Derive a safe, collision-resistant k8s resource name from a hostname.
 *
 * Strategy: take a 41-char slug of the hostname for human readability, then
 * append a short sha256 hash so two hostnames that share the same 41-char
 * prefix get distinct names. Total length: 8 (prefix) + 41 (slug) + 1 + 8
 * (hash) = 58 ≤ 63 (RFC 1123 label max).
 *
 * Without the hash, the slice could silently produce identical names for two
 * different clients' hostnames, causing one client's Ingress to overwrite
 * the other's on the 409 replace path.
 */
function slugForHostname(hostname: string): string {
  const hash = crypto.createHash('sha256').update(hostname).digest('hex').slice(0, 8);
  const safe = hostname
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 41)
    .replace(/-+$/, ''); // re-strip trailing hyphens after slice
  return `${safe}-${hash}`;
}

function ingressNameFor(hostname: string): string {
  return `webmail-${slugForHostname(hostname)}`;
}

function certificateNameFor(hostname: string): string {
  // Distinct from the secret name to avoid future confusion: `kubectl get
  // certificate` and `kubectl get secret` show different names, and any
  // tooling that filters by name won't accidentally match both.
  return `webmail-${slugForHostname(hostname)}-cert`;
}

function tlsSecretNameFor(hostname: string): string {
  return `webmail-${slugForHostname(hostname)}-tls`;
}

function k8sStatusCode(err: unknown): number | undefined {
  // Prefer structured fields, fall back to the legacy message-string parser.
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

function isPgUniqueViolation(err: unknown): boolean {
  // Postgres error code 23505 = unique_violation. Drizzle passes through the
  // underlying pg error, which has a `code` property (string, e.g. "23505").
  const e = err as { code?: string };
  return typeof e?.code === 'string' && e.code === '23505';
}

// ─── k8s resource builders ────────────────────────────────────────────────

function buildIngress(hostname: string, clusterIssuer: string | null) {
  const annotations: Record<string, string> = {
    'app.kubernetes.io/managed-by': 'k8s-hosting-platform',
    'app.kubernetes.io/component': 'webmail-custom-domain',
  };
  if (clusterIssuer) {
    annotations['cert-manager.io/cluster-issuer'] = clusterIssuer;
  }

  return {
    metadata: {
      name: ingressNameFor(hostname),
      namespace: MAIL_NAMESPACE,
      annotations,
      labels: {
        'app.kubernetes.io/component': 'webmail-custom-domain',
        'app.kubernetes.io/part-of': 'hosting-platform',
      },
    },
    spec: {
      ingressClassName: 'nginx',
      rules: [
        {
          host: hostname,
          http: {
            paths: [
              {
                path: '/',
                pathType: 'Prefix' as const,
                backend: {
                  service: {
                    name: ROUNDCUBE_SERVICE_NAME,
                    port: { number: ROUNDCUBE_SERVICE_PORT },
                  },
                },
              },
            ],
          },
        },
      ],
      ...(clusterIssuer
        ? {
            tls: [
              {
                hosts: [hostname],
                secretName: tlsSecretNameFor(hostname),
              },
            ],
          }
        : {}),
    },
  };
}

function buildCertificate(hostname: string, clusterIssuer: string) {
  return {
    apiVersion: 'cert-manager.io/v1',
    kind: 'Certificate',
    metadata: {
      name: certificateNameFor(hostname),
      namespace: MAIL_NAMESPACE,
      labels: {
        'app.kubernetes.io/component': 'webmail-custom-domain',
        'app.kubernetes.io/part-of': 'hosting-platform',
      },
    },
    spec: {
      secretName: tlsSecretNameFor(hostname),
      dnsNames: [hostname],
      issuerRef: {
        name: clusterIssuer,
        kind: 'ClusterIssuer',
        group: 'cert-manager.io',
      },
    },
  };
}

// ─── Service layer ────────────────────────────────────────────────────────

async function verifyClient(db: Database, clientId: string): Promise<void> {
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!client) {
    throw new ApiError('CLIENT_NOT_FOUND', `Client '${clientId}' not found`, 404);
  }
}

export async function listWebmailDomains(db: Database, clientId: string) {
  await verifyClient(db, clientId);
  return db
    .select()
    .from(webmailDomains)
    .where(eq(webmailDomains.clientId, clientId));
}

export async function getWebmailDomain(db: Database, clientId: string, id: string) {
  const [row] = await db
    .select()
    .from(webmailDomains)
    .where(and(eq(webmailDomains.id, id), eq(webmailDomains.clientId, clientId)));

  if (!row) {
    throw new ApiError('WEBMAIL_DOMAIN_NOT_FOUND', `Webmail domain '${id}' not found`, 404);
  }
  return row;
}

/**
 * Return the *active* webmail domain for a client, or undefined.
 *
 * Filters at the query level so callers can't accidentally use a `failed` or
 * `deleting` row for SSO URL construction. If you need the full row
 * regardless of status (e.g. for admin UI), use listWebmailDomains().
 */
export async function getWebmailDomainForClient(db: Database, clientId: string) {
  const [row] = await db
    .select()
    .from(webmailDomains)
    .where(
      and(
        eq(webmailDomains.clientId, clientId),
        eq(webmailDomains.status, 'active'),
      ),
    );
  return row;
}

export async function createWebmailDomain(
  db: Database,
  clientId: string,
  input: CreateWebmailDomainInput,
  k8s: K8sClients | undefined,
  logger: WebmailLogger = noopLogger,
) {
  await verifyClient(db, clientId);

  // Enforce 1-per-client. We also have a pre-flight check, but the unique
  // index is the real safety net — the check is only for a friendly error.
  const existingRows = await db
    .select()
    .from(webmailDomains)
    .where(eq(webmailDomains.clientId, clientId));
  if (existingRows.length > 0) {
    const existing = existingRows[0];
    throw new ApiError(
      'WEBMAIL_DOMAIN_LIMIT_REACHED',
      `Client already has a webmail domain (${existing.hostname}). Delete it first.`,
      409,
      { existing_id: existing.id },
    );
  }

  // Hostname uniqueness across all clients
  const [hostnameTaken] = await db
    .select({ id: webmailDomains.id })
    .from(webmailDomains)
    .where(eq(webmailDomains.hostname, input.hostname));
  if (hostnameTaken) {
    throw new ApiError(
      'DUPLICATE_ENTRY',
      `Hostname '${input.hostname}' is already in use`,
      409,
      { resource: 'webmail_domain', hostname: input.hostname },
    );
  }

  const id = crypto.randomUUID();

  // The check → insert sequence is not atomic. A concurrent request for the
  // same hostname or same client can slip through and hit the unique index.
  // Catch that and convert to the same friendly 409.
  try {
    await db.insert(webmailDomains).values({
      id,
      clientId,
      hostname: input.hostname,
      status: 'pending',
    });
  } catch (err) {
    if (isPgUniqueViolation(err)) {
      throw new ApiError(
        'DUPLICATE_ENTRY',
        `Hostname '${input.hostname}' or client webmail slot is already in use`,
        409,
        { resource: 'webmail_domain', hostname: input.hostname },
      );
    }
    throw err;
  }

  // Provision k8s resources (best effort — flag the row on failure)
  let ingressOk = false;
  let certOk = false;

  // Graceful no-k8s mode: leave the row in 'pending' so an operator (or a
  // retry job) can finish provisioning later. 'failed' would imply an error
  // that never happened.
  if (!k8s) {
    logger.warn(
      { hostname: input.hostname, id },
      'webmail_domain created without k8s client — leaving row in pending',
    );
    return requireCreatedRow(db, id);
  }

  const autoTls = await isAutoTlsEnabled(db);
  const clusterIssuer = autoTls ? await getClusterIssuerName(db) : null;

  try {
    const body = buildIngress(input.hostname, clusterIssuer);
    try {
      await k8s.networking.createNamespacedIngress({ namespace: MAIL_NAMESPACE, body });
    } catch (err) {
      if (isK8s409(err)) {
        await k8s.networking.replaceNamespacedIngress({
          name: body.metadata.name,
          namespace: MAIL_NAMESPACE,
          body,
        });
      } else {
        throw err;
      }
    }
    ingressOk = true;
  } catch (ingressErr) {
    // Roll back the DB row so we don't leak orphaned config. If the rollback
    // itself throws, log it but still surface the original Ingress error to
    // the caller — the caller needs the root cause, not the rollback hiccup.
    try {
      await db.delete(webmailDomains).where(eq(webmailDomains.id, id));
    } catch (rollbackErr) {
      logger.error(
        { rollbackErr, id, hostname: input.hostname },
        'Failed to roll back webmail_domains row after Ingress create failure',
      );
    }
    throw new ApiError(
      'PROVISIONING_FAILED',
      `Failed to create Ingress for '${input.hostname}': ${(ingressErr as Error).message}`,
      502,
      { hostname: input.hostname },
    );
  }

  if (clusterIssuer) {
    try {
      const certBody = buildCertificate(input.hostname, clusterIssuer);
      try {
        await k8s.custom.createNamespacedCustomObject({
          group: 'cert-manager.io',
          version: 'v1',
          namespace: MAIL_NAMESPACE,
          plural: 'certificates',
          body: certBody,
        });
      } catch (err) {
        if (!isK8s409(err)) throw err;
        // Already exists — leave it alone
      }
      certOk = true;
    } catch (certErr) {
      // Cert failure is non-fatal — the Ingress still works for HTTP, and
      // cert-manager will retry on its own if the Certificate object exists.
      // Log loudly so an operator can investigate.
      logger.warn(
        { certErr, hostname: input.hostname, id },
        'cert-manager Certificate creation failed — webmail domain will serve HTTP only until resolved',
      );
    }
  }

  await db
    .update(webmailDomains)
    .set({
      status: ingressOk ? 'active' : 'failed',
      ingressProvisioned: ingressOk ? 1 : 0,
      certificateProvisioned: certOk ? 1 : 0,
    })
    .where(eq(webmailDomains.id, id));

  return requireCreatedRow(db, id);
}

async function requireCreatedRow(db: Database, id: string) {
  const [created] = await db
    .select()
    .from(webmailDomains)
    .where(eq(webmailDomains.id, id));
  if (!created) {
    throw new ApiError(
      'INTERNAL_ERROR',
      'webmail_domain row disappeared after create',
      500,
      { id },
    );
  }
  return created;
}

export async function deleteWebmailDomain(
  db: Database,
  clientId: string,
  id: string,
  k8s: K8sClients | undefined,
  logger: WebmailLogger = noopLogger,
) {
  const row = await getWebmailDomain(db, clientId, id);

  // Track k8s teardown errors but keep going — we want to delete the cert
  // and secret even if the ingress delete failed, so operators aren't left
  // with orphans in the mail namespace.
  const k8sErrors: string[] = [];

  if (k8s) {
    // Delete Ingress (404 = already gone, fine)
    try {
      await k8s.networking.deleteNamespacedIngress({
        name: ingressNameFor(row.hostname),
        namespace: MAIL_NAMESPACE,
      });
    } catch (err) {
      if (!isK8s404(err)) {
        k8sErrors.push(`ingress: ${(err as Error).message}`);
        logger.warn(
          { err, hostname: row.hostname, id },
          'Failed to delete Ingress for webmail_domain',
        );
      }
    }

    // Delete Certificate
    try {
      await k8s.custom.deleteNamespacedCustomObject({
        group: 'cert-manager.io',
        version: 'v1',
        namespace: MAIL_NAMESPACE,
        plural: 'certificates',
        name: certificateNameFor(row.hostname),
      });
    } catch (err) {
      if (!isK8s404(err)) {
        k8sErrors.push(`certificate: ${(err as Error).message}`);
        logger.warn(
          { err, hostname: row.hostname, id },
          'Failed to delete cert-manager Certificate for webmail_domain',
        );
      }
    }

    // Delete the cert-manager-managed TLS secret too (distinct name from cert)
    try {
      await k8s.core.deleteNamespacedSecret({
        name: tlsSecretNameFor(row.hostname),
        namespace: MAIL_NAMESPACE,
      });
    } catch (err) {
      if (!isK8s404(err)) {
        k8sErrors.push(`secret: ${(err as Error).message}`);
        logger.warn(
          { err, hostname: row.hostname, id },
          'Failed to delete TLS secret for webmail_domain',
        );
      }
    }
  }

  // If any teardown step failed, mark the row as 'deleting' and throw so the
  // caller knows state is inconsistent. An operator can call DELETE again —
  // or resolve the k8s issue — and retry. We intentionally do NOT delete the
  // DB row in this path, so the hostname stays reserved until k8s is clean.
  if (k8sErrors.length > 0) {
    try {
      await db
        .update(webmailDomains)
        .set({ status: 'deleting' })
        .where(eq(webmailDomains.id, id));
    } catch (updateErr) {
      logger.error(
        { updateErr, id },
        'Failed to mark webmail_domain row as deleting after partial k8s teardown',
      );
    }
    throw new ApiError(
      'DEPROVISIONING_FAILED',
      `Failed to delete k8s resources for '${row.hostname}': ${k8sErrors.join('; ')}`,
      502,
      { hostname: row.hostname, failures: k8sErrors },
    );
  }

  await db.delete(webmailDomains).where(eq(webmailDomains.id, id));
}
