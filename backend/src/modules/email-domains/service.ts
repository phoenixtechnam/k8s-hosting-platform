import { eq, and, sql } from 'drizzle-orm';
import { emailDomains, domains, mailboxes, clients } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { generateDkimKeyPair } from './dkim.js';
import { encrypt } from '../oidc/crypto.js';
import { provisionEmailDns, deprovisionEmailDns } from './dns-provisioning.js';
import type { Database } from '../../db/index.js';
import type { EnableEmailDomainInput, UpdateEmailDomainInput } from '@k8s-hosting/api-contracts';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

async function verifyDomainOwnership(db: Database, clientId: string, domainId: string) {
  const [domain] = await db
    .select()
    .from(domains)
    .where(and(eq(domains.id, domainId), eq(domains.clientId, clientId)));

  if (!domain) {
    throw new ApiError('DOMAIN_NOT_FOUND', `Domain '${domainId}' not found for client`, 404);
  }
  return domain;
}

export async function enableEmailForDomain(
  db: Database,
  clientId: string,
  domainId: string,
  input: EnableEmailDomainInput,
  encryptionKey: string,
) {
  const domain = await verifyDomainOwnership(db, clientId, domainId);

  // Check if already enabled (idempotent)
  const [existing] = await db
    .select()
    .from(emailDomains)
    .where(eq(emailDomains.domainId, domainId));

  if (existing) {
    return { ...existing, domainName: domain.domainName };
  }

  // Generate DKIM key pair
  const { privateKey, publicKey } = generateDkimKeyPair();
  const dkimPrivateKeyEncrypted = encrypt(privateKey, encryptionKey);
  const dkimSelector = 'default';

  const id = crypto.randomUUID();

  await db.insert(emailDomains).values({
    id,
    domainId,
    clientId,
    enabled: 1,
    dkimSelector,
    dkimPrivateKeyEncrypted,
    dkimPublicKey: publicKey,
    maxMailboxes: input.max_mailboxes ?? 50,
    maxQuotaMb: input.max_quota_mb ?? 10240,
    catchAllAddress: input.catch_all_address ?? null,
  });

  // Provision DNS records
  await provisionEmailDns(db, domainId, domain.domainName, dkimSelector, publicKey, encryptionKey);

  const [created] = await db
    .select()
    .from(emailDomains)
    .where(eq(emailDomains.id, id));

  return { ...created, domainName: domain.domainName };
}

export async function disableEmailForDomain(
  db: Database,
  clientId: string,
  domainId: string,
) {
  await verifyDomainOwnership(db, clientId, domainId);

  const [existing] = await db
    .select()
    .from(emailDomains)
    .where(and(eq(emailDomains.domainId, domainId), eq(emailDomains.clientId, clientId)));

  if (!existing) {
    throw new ApiError('EMAIL_DOMAIN_NOT_FOUND', `Email is not enabled for domain '${domainId}'`, 404);
  }

  await db.delete(emailDomains).where(eq(emailDomains.id, existing.id));
  await deprovisionEmailDns(db, domainId);
}

export async function getEmailDomain(
  db: Database,
  clientId: string,
  domainId: string,
) {
  await verifyDomainOwnership(db, clientId, domainId);

  const [emailDomain] = await db
    .select({
      id: emailDomains.id,
      domainId: emailDomains.domainId,
      clientId: emailDomains.clientId,
      domainName: domains.domainName,
      enabled: emailDomains.enabled,
      webmailEnabled: emailDomains.webmailEnabled,
      dkimSelector: emailDomains.dkimSelector,
      dkimPublicKey: emailDomains.dkimPublicKey,
      maxMailboxes: emailDomains.maxMailboxes,
      maxQuotaMb: emailDomains.maxQuotaMb,
      catchAllAddress: emailDomains.catchAllAddress,
      mxProvisioned: emailDomains.mxProvisioned,
      spfProvisioned: emailDomains.spfProvisioned,
      dkimProvisioned: emailDomains.dkimProvisioned,
      dmarcProvisioned: emailDomains.dmarcProvisioned,
      spamThresholdJunk: emailDomains.spamThresholdJunk,
      spamThresholdReject: emailDomains.spamThresholdReject,
      createdAt: emailDomains.createdAt,
      updatedAt: emailDomains.updatedAt,
    })
    .from(emailDomains)
    .innerJoin(domains, eq(emailDomains.domainId, domains.id))
    .where(and(eq(emailDomains.domainId, domainId), eq(emailDomains.clientId, clientId)));

  if (!emailDomain) {
    throw new ApiError('EMAIL_DOMAIN_NOT_FOUND', `Email is not enabled for domain '${domainId}'`, 404);
  }

  // Get mailbox count
  const [mailboxCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(mailboxes)
    .where(eq(mailboxes.emailDomainId, emailDomain.id));

  return { ...emailDomain, mailboxCount: mailboxCount?.count ?? 0 };
}

export async function listEmailDomains(
  db: Database,
  clientId: string,
) {
  const results = await db
    .select({
      id: emailDomains.id,
      domainId: emailDomains.domainId,
      clientId: emailDomains.clientId,
      domainName: domains.domainName,
      enabled: emailDomains.enabled,
      webmailEnabled: emailDomains.webmailEnabled,
      dkimSelector: emailDomains.dkimSelector,
      dkimPublicKey: emailDomains.dkimPublicKey,
      maxMailboxes: emailDomains.maxMailboxes,
      maxQuotaMb: emailDomains.maxQuotaMb,
      catchAllAddress: emailDomains.catchAllAddress,
      mxProvisioned: emailDomains.mxProvisioned,
      spfProvisioned: emailDomains.spfProvisioned,
      dkimProvisioned: emailDomains.dkimProvisioned,
      dmarcProvisioned: emailDomains.dmarcProvisioned,
      spamThresholdJunk: emailDomains.spamThresholdJunk,
      spamThresholdReject: emailDomains.spamThresholdReject,
      createdAt: emailDomains.createdAt,
      updatedAt: emailDomains.updatedAt,
      mailboxCount: sql<number>`(SELECT count(*) FROM mailboxes WHERE mailboxes.email_domain_id = ${emailDomains.id})`,
    })
    .from(emailDomains)
    .innerJoin(domains, eq(emailDomains.domainId, domains.id))
    .where(eq(emailDomains.clientId, clientId));

  return results;
}

export async function listAllEmailDomains(db: Database) {
  const results = await db
    .select({
      id: emailDomains.id,
      domainId: emailDomains.domainId,
      clientId: emailDomains.clientId,
      domainName: domains.domainName,
      enabled: emailDomains.enabled,
      webmailEnabled: emailDomains.webmailEnabled,
      dkimSelector: emailDomains.dkimSelector,
      dkimPublicKey: emailDomains.dkimPublicKey,
      maxMailboxes: emailDomains.maxMailboxes,
      maxQuotaMb: emailDomains.maxQuotaMb,
      catchAllAddress: emailDomains.catchAllAddress,
      mxProvisioned: emailDomains.mxProvisioned,
      spfProvisioned: emailDomains.spfProvisioned,
      dkimProvisioned: emailDomains.dkimProvisioned,
      dmarcProvisioned: emailDomains.dmarcProvisioned,
      spamThresholdJunk: emailDomains.spamThresholdJunk,
      spamThresholdReject: emailDomains.spamThresholdReject,
      createdAt: emailDomains.createdAt,
      updatedAt: emailDomains.updatedAt,
      mailboxCount: sql<number>`(SELECT count(*) FROM mailboxes WHERE mailboxes.email_domain_id = ${emailDomains.id})`,
    })
    .from(emailDomains)
    .innerJoin(domains, eq(emailDomains.domainId, domains.id));

  return results;
}

export async function updateEmailDomain(
  db: Database,
  clientId: string,
  domainId: string,
  input: UpdateEmailDomainInput,
) {
  await verifyDomainOwnership(db, clientId, domainId);

  const [existing] = await db
    .select()
    .from(emailDomains)
    .where(and(eq(emailDomains.domainId, domainId), eq(emailDomains.clientId, clientId)));

  if (!existing) {
    throw new ApiError('EMAIL_DOMAIN_NOT_FOUND', `Email is not enabled for domain '${domainId}'`, 404);
  }

  const updateValues: Record<string, unknown> = {};
  if (input.enabled !== undefined) updateValues.enabled = input.enabled ? 1 : 0;
  if (input.webmail_enabled !== undefined) updateValues.webmailEnabled = input.webmail_enabled ? 1 : 0;
  if (input.max_mailboxes !== undefined) updateValues.maxMailboxes = input.max_mailboxes;
  if (input.max_quota_mb !== undefined) updateValues.maxQuotaMb = input.max_quota_mb;
  if (input.catch_all_address !== undefined) updateValues.catchAllAddress = input.catch_all_address;
  if (input.spam_threshold_junk !== undefined) updateValues.spamThresholdJunk = String(input.spam_threshold_junk);
  if (input.spam_threshold_reject !== undefined) updateValues.spamThresholdReject = String(input.spam_threshold_reject);

  if (Object.keys(updateValues).length > 0) {
    await db
      .update(emailDomains)
      .set(updateValues)
      .where(eq(emailDomains.id, existing.id));
  }

  const [updated] = await db
    .select()
    .from(emailDomains)
    .where(eq(emailDomains.id, existing.id));

  return updated;
}

// ─── Phase 2c.5: Derived webmail URL + Ingress provisioning ─────────────

/**
 * Resolve the webmail base URL for a mailbox via its email domain.
 *
 * Returns `https://webmail.<domain>` when:
 *   - The mailbox exists and belongs to an email domain
 *   - That email domain has webmail_enabled=1
 *   - The underlying domain row resolves
 *
 * Returns undefined otherwise, letting the caller fall back to the
 * platform default (webmail-settings.default_webmail_url) or the
 * WEBMAIL_URL env var.
 */
export async function getDerivedWebmailUrlForMailbox(
  db: Database,
  mailboxId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({
      webmailEnabled: emailDomains.webmailEnabled,
      domainName: domains.domainName,
    })
    .from(mailboxes)
    .innerJoin(emailDomains, eq(mailboxes.emailDomainId, emailDomains.id))
    .innerJoin(domains, eq(emailDomains.domainId, domains.id))
    .where(eq(mailboxes.id, mailboxId));

  if (!row || row.webmailEnabled !== 1 || !row.domainName) {
    return undefined;
  }
  return `https://webmail.${row.domainName}`;
}

/**
 * Ensure a webmail.<domain> Ingress + ExternalName Service exist in
 * the client's namespace, pointing at the shared Roundcube Service in
 * the `mail` namespace.
 *
 * Called by enableEmailForDomain and updateEmailDomain (when
 * webmail_enabled is toggled on). Idempotent on 409 (replace).
 */
export async function ensureWebmailIngress(
  db: Database,
  k8s: K8sClients | undefined,
  emailDomainId: string,
): Promise<{ ingressCreated: boolean; reason?: string }> {
  if (!k8s) return { ingressCreated: false, reason: 'no k8s client' };

  const [row] = await db
    .select({
      emailDomainId: emailDomains.id,
      domainId: emailDomains.domainId,
      clientId: emailDomains.clientId,
      webmailEnabled: emailDomains.webmailEnabled,
      domainName: domains.domainName,
    })
    .from(emailDomains)
    .innerJoin(domains, eq(emailDomains.domainId, domains.id))
    .where(eq(emailDomains.id, emailDomainId));

  if (!row) return { ingressCreated: false, reason: 'email_domain not found' };
  if (row.webmailEnabled !== 1) {
    return { ingressCreated: false, reason: 'webmail_enabled=false' };
  }

  const [client] = await db.select().from(clients).where(eq(clients.id, row.clientId));
  if (!client) return { ingressCreated: false, reason: 'client not found' };
  const namespace = client.kubernetesNamespace;
  const hostname = `webmail.${row.domainName}`;

  // Ingress name: stable per hostname, sanitized for DNS-1123
  const safeName = hostname.replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 50);
  const ingressName = `${safeName}-ingress`;
  const externalSvcName = `${safeName}-upstream`;

  // Step 1: ensure the ExternalName service that points at the shared
  // Roundcube service in the mail namespace
  const externalSvcBody = {
    metadata: {
      name: externalSvcName,
      namespace,
      labels: {
        'app.kubernetes.io/part-of': 'hosting-platform',
        'app.kubernetes.io/component': 'webmail-upstream',
        'app.kubernetes.io/managed-by': 'k8s-hosting-platform',
      },
    },
    spec: {
      type: 'ExternalName',
      externalName: 'roundcube.mail.svc.cluster.local',
      ports: [{ port: 80, targetPort: 80, protocol: 'TCP', name: 'http' }],
    },
  };

  try {
    await k8s.core.createNamespacedService({ namespace, body: externalSvcBody });
  } catch (err: unknown) {
    const statusCode = (err as { statusCode?: number })?.statusCode;
    if (statusCode !== 409) throw err;
    await k8s.core.replaceNamespacedService({
      name: externalSvcName,
      namespace,
      body: externalSvcBody,
    });
  }

  // Step 2: ensure the Ingress rule for webmail.<domain>
  //
  // Cert secret name is resolved by the certificates module inside
  // domains/k8s-ingress.ts during its reconcile pass — we don't
  // duplicate that logic here. For the webmail Ingress we create a
  // dedicated Ingress separate from the platform's {namespace}-ingress
  // because webmail lives on a different hostname pattern and we want
  // it reconciled independently.
  //
  // Use ensureRouteCertificate to get the right secret name.
  const { ensureRouteCertificate } = await import('../certificates/service.js');
  const certResult = await ensureRouteCertificate(db, k8s, row.domainId, hostname).catch(() => null);

  const tls = certResult && !certResult.skipped && certResult.secretName
    ? [{ hosts: [hostname], secretName: certResult.secretName }]
    : undefined;

  const ingressBody = {
    metadata: {
      name: ingressName,
      namespace,
      labels: {
        'app.kubernetes.io/part-of': 'hosting-platform',
        'app.kubernetes.io/component': 'webmail',
        'app.kubernetes.io/managed-by': 'k8s-hosting-platform',
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
                  service: { name: externalSvcName, port: { number: 80 } },
                },
              },
            ],
          },
        },
      ],
      ...(tls ? { tls } : {}),
    },
  };

  try {
    await k8s.networking.createNamespacedIngress({ namespace, body: ingressBody });
  } catch (err: unknown) {
    const statusCode = (err as { statusCode?: number })?.statusCode;
    if (statusCode !== 409) throw err;
    await k8s.networking.replaceNamespacedIngress({
      name: ingressName,
      namespace,
      body: ingressBody,
    });
  }

  return { ingressCreated: true };
}

/**
 * Delete the webmail Ingress + ExternalName Service for an email domain.
 * Called when webmail_enabled flips false or the email domain is
 * disabled entirely. Idempotent on 404.
 */
export async function removeWebmailIngress(
  db: Database,
  k8s: K8sClients | undefined,
  emailDomainId: string,
): Promise<void> {
  if (!k8s) return;

  const [row] = await db
    .select({
      clientId: emailDomains.clientId,
      domainName: domains.domainName,
    })
    .from(emailDomains)
    .innerJoin(domains, eq(emailDomains.domainId, domains.id))
    .where(eq(emailDomains.id, emailDomainId));

  if (!row) return;

  const [client] = await db.select().from(clients).where(eq(clients.id, row.clientId));
  if (!client) return;
  const namespace = client.kubernetesNamespace;
  const hostname = `webmail.${row.domainName}`;
  const safeName = hostname.replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 50);
  const ingressName = `${safeName}-ingress`;
  const externalSvcName = `${safeName}-upstream`;

  try {
    await k8s.networking.deleteNamespacedIngress({ name: ingressName, namespace });
  } catch (err: unknown) {
    const statusCode = (err as { statusCode?: number })?.statusCode;
    if (statusCode !== 404) throw err;
  }

  try {
    await k8s.core.deleteNamespacedService({ name: externalSvcName, namespace });
  } catch (err: unknown) {
    const statusCode = (err as { statusCode?: number })?.statusCode;
    if (statusCode !== 404) throw err;
  }
}
