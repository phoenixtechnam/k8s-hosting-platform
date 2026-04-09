import { eq, and, sql } from 'drizzle-orm';
import { emailDomains, domains, mailboxes, clients, emailAliases, emailDkimKeys, dnsRecords } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { generateDkimKeyPair } from './dkim.js';
import { encrypt } from '../oidc/crypto.js';
import { provisionEmailDns, deprovisionEmailDns } from './dns-provisioning.js';
import { getMailServerHostname } from '../webmail-settings/service.js';
import { notifyClientEmailBootstrapped } from '../notifications/events.js';
import type { EmailDomainDisablePreview, WebmailStatus } from '@k8s-hosting/api-contracts';
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
    // max_mailboxes + max_quota_mb removed in migration 0019.
    // Mailbox count is now capped at the plan level via
    // hosting_plans.max_mailboxes + clients.max_mailboxes_override.
    catchAllAddress: input.catch_all_address ?? null,
  });

  // Provision DNS records (Phase 3.C.2: includes SRV + autoconfig +
  // MTA-STS records; the mail server hostname comes from the platform
  // setting mail_server_hostname). Round-3: webmail_enabled defaults
  // to 1 on new email domains, so we also publish the
  // webmail.<domain> A record in the same batch.
  const mailServerHostname = await getMailServerHostname(db);
  await provisionEmailDns(
    db,
    domainId,
    domain.domainName,
    dkimSelector,
    publicKey,
    encryptionKey,
    mailServerHostname,
    { webmailEnabled: true },
  );

  const [created] = await db
    .select()
    .from(emailDomains)
    .where(eq(emailDomains.id, id));

  // Phase 3 round-2: notify client admins that email is now live.
  // Fire-and-forget; a failure here cannot roll back the enable.
  void notifyClientEmailBootstrapped(db, clientId, {
    emailDomainId: id,
    domainName: domain.domainName,
  });

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

// Round-4 Phase 1: authoritative disable preview. Returns the exact
// list of resources that `disableEmailForDomain` + the FK cascade
// from migration 0020 will remove for this email domain. Pure read —
// no side effects. Reused by the client-panel disable confirmation
// modal so users see mailbox addresses, alias sources, DNS records,
// DKIM keys, and the webmail hostname by name BEFORE they confirm.
export async function getEmailDomainDisablePreview(
  db: Database,
  clientId: string,
  domainId: string,
): Promise<EmailDomainDisablePreview> {
  await verifyDomainOwnership(db, clientId, domainId);

  const [ed] = await db
    .select({
      id: emailDomains.id,
      webmailEnabled: emailDomains.webmailEnabled,
      domainName: domains.domainName,
    })
    .from(emailDomains)
    .innerJoin(domains, eq(emailDomains.domainId, domains.id))
    .where(and(eq(emailDomains.domainId, domainId), eq(emailDomains.clientId, clientId)));

  if (!ed) {
    throw new ApiError('EMAIL_DOMAIN_NOT_FOUND', `Email is not enabled for domain '${domainId}'`, 404);
  }

  const mailboxRows = await db
    .select({ id: mailboxes.id, fullAddress: mailboxes.fullAddress })
    .from(mailboxes)
    .where(eq(mailboxes.emailDomainId, ed.id));

  const aliasRows = await db
    .select({ id: emailAliases.id, sourceAddress: emailAliases.sourceAddress })
    .from(emailAliases)
    .where(eq(emailAliases.emailDomainId, ed.id));

  const dkimRows = await db
    .select({
      id: emailDkimKeys.id,
      selector: emailDkimKeys.selector,
      status: emailDkimKeys.status,
    })
    .from(emailDkimKeys)
    .where(eq(emailDkimKeys.emailDomainId, ed.id));

  // DNS records that disableEmailForDomain → deprovisionEmailDns
  // would remove. deprovisionEmailDns targets MX + A 'mail.*' + TXT
  // SPF/DKIM/DMARC entries. We enumerate here using the same filter
  // so the preview matches the actual deletion behaviour.
  const allDnsRows = await db
    .select({
      id: dnsRecords.id,
      type: dnsRecords.recordType,
      name: dnsRecords.recordName,
      value: dnsRecords.recordValue,
    })
    .from(dnsRecords)
    .where(eq(dnsRecords.domainId, domainId));

  const emailDnsRows = allDnsRows.filter((r) => {
    if (r.type === 'MX') return true;
    if (r.type === 'A' && (r.name?.startsWith('mail.') || r.name?.startsWith('webmail.'))) return true;
    if (r.type === 'TXT') {
      const v = r.value ?? '';
      return (
        v.startsWith('v=spf1')
        || v.startsWith('v=DKIM1')
        || v.startsWith('v=DMARC1')
        || v.startsWith('v=STSv1')
      );
    }
    // SRV / CNAME autoconfig / mta-sts records were published by
    // provisionEmailDns but deprovisionEmailDns does not currently
    // remove them. Skip them in the preview so we don't lie.
    return false;
  });

  // Map purpose heuristically from the record shape so the UI can
  // label rows without re-running buildEmailDnsRecordsForDisplay.
  const purposeFor = (type: string, name: string | null, value: string | null): string | null => {
    if (type === 'MX') return 'mx';
    if (type === 'A' && name?.startsWith('mail.')) return 'mail_host';
    if (type === 'A' && name?.startsWith('webmail.')) return 'webmail';
    if (type === 'TXT') {
      const v = value ?? '';
      if (v.startsWith('v=spf1')) return 'spf';
      if (v.startsWith('v=DKIM1')) return 'dkim';
      if (v.startsWith('v=DMARC1')) return 'dmarc';
      if (v.startsWith('v=STSv1')) return 'mta_sts';
    }
    return null;
  };

  return {
    emailDomainId: ed.id,
    domainName: ed.domainName,
    mailboxes: mailboxRows,
    aliases: aliasRows,
    dnsRecords: emailDnsRows.map((r) => ({
      id: r.id,
      type: r.type,
      name: r.name,
      purpose: purposeFor(r.type, r.name, r.value),
    })),
    dkimKeys: dkimRows,
    webmailHostname: ed.webmailEnabled === 1 ? `webmail.${ed.domainName}` : null,
  };
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
      dnsMode: domains.dnsMode,
      enabled: emailDomains.enabled,
      webmailEnabled: emailDomains.webmailEnabled,
      // Round-4 Phase 2: webmail provisioning status fields.
      webmailStatus: emailDomains.webmailStatus,
      webmailStatusMessage: emailDomains.webmailStatusMessage,
      webmailStatusUpdatedAt: emailDomains.webmailStatusUpdatedAt,
      dkimSelector: emailDomains.dkimSelector,
      dkimPublicKey: emailDomains.dkimPublicKey,
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

/**
 * Return the list of DNS records the operator should see for this
 * email domain, using the SAME builder that the provisioning path
 * uses — so there's zero drift between what gets written to DNS in
 * primary mode and what's displayed in the UI for cname/secondary
 * mode. The response includes a `manualRequired` flag so the UI
 * knows whether to nag the operator to publish them manually.
 */
export async function getEmailDomainDnsRecords(
  db: Database,
  clientId: string,
  domainId: string,
): Promise<{
  readonly dnsMode: string;
  readonly manualRequired: boolean;
  readonly mailServerHostname: string;
  readonly records: readonly {
    readonly type: string;
    readonly name: string;
    readonly value: string;
    readonly ttl: number;
    readonly priority: number | null;
    readonly purpose: string;
  }[];
}> {
  const ed = await getEmailDomain(db, clientId, domainId);

  // Import lazily so dns-provisioning is only loaded when the route
  // is actually hit — keeps the module's import cycle flat.
  const { buildEmailDnsRecordsForDisplay } = await import('./dns-provisioning.js');
  const mailServerHostname = await getMailServerHostname(db);

  const specs = buildEmailDnsRecordsForDisplay(
    ed.domainName,
    ed.dkimSelector,
    ed.dkimPublicKey ?? '',
    mailServerHostname,
    { webmailEnabled: ed.webmailEnabled === 1 },
  );

  return {
    dnsMode: (ed.dnsMode as string) ?? 'cname',
    // primary mode: the platform writes DNS itself; UI shows records
    // for reference but doesn't nag. cname/secondary: the operator
    // MUST publish the records at their own DNS provider.
    manualRequired: ed.dnsMode !== 'primary',
    mailServerHostname,
    records: specs.map((s) => ({
      type: s.recordType,
      name: s.recordName,
      value: s.recordValue,
      ttl: s.ttl,
      priority: s.priority,
      purpose: s.purpose,
    })),
  };
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
      // Round-4 Phase 2: webmail status fields.
      webmailStatus: emailDomains.webmailStatus,
      webmailStatusMessage: emailDomains.webmailStatusMessage,
      webmailStatusUpdatedAt: emailDomains.webmailStatusUpdatedAt,
      dkimSelector: emailDomains.dkimSelector,
      dkimPublicKey: emailDomains.dkimPublicKey,
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
  // Round-3 review HIGH-1: caller must supply the encryption key
  // explicitly (same pattern as enableEmailForDomain). Falling back
  // to process.env silently hides misconfigured test environments.
  encryptionKey?: string,
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
  // max_mailboxes + max_quota_mb removed in migration 0019 —
  // plan-based limits now come from hosting_plans.max_mailboxes.
  if (input.catch_all_address !== undefined) updateValues.catchAllAddress = input.catch_all_address;
  if (input.spam_threshold_junk !== undefined) updateValues.spamThresholdJunk = String(input.spam_threshold_junk);
  if (input.spam_threshold_reject !== undefined) updateValues.spamThresholdReject = String(input.spam_threshold_reject);

  if (Object.keys(updateValues).length > 0) {
    await db
      .update(emailDomains)
      .set(updateValues)
      .where(eq(emailDomains.id, existing.id));
  }

  // Round-3: if webmail_enabled flipped, publish or unpublish the
  // webmail.<domain> DNS record alongside the ingress lifecycle.
  // The k8s Ingress is handled by the route-layer caller (which has
  // the k8s client handle) via ensureWebmailIngress /
  // removeWebmailIngress. We only own the DNS record mutation here.
  if (
    input.webmail_enabled !== undefined
    && Boolean(existing.webmailEnabled) !== Boolean(input.webmail_enabled)
  ) {
    try {
      const [domainRow] = await db
        .select({ domainName: domains.domainName })
        .from(domains)
        .where(eq(domains.id, existing.domainId));
      if (domainRow) {
        // Review HIGH-1: use the caller-supplied key. Fall back to
        // the env var (with dev-only zero-key) so the route handler
        // and tests that do not supply a key still behave.
        const effectiveKey = encryptionKey ?? process.env.OIDC_ENCRYPTION_KEY ?? '0'.repeat(64);
        const { publishWebmailDnsRecord, unpublishWebmailDnsRecord } = await import('./dns-provisioning.js');
        if (input.webmail_enabled) {
          await publishWebmailDnsRecord(db, existing.domainId, domainRow.domainName, effectiveKey);
        } else {
          await unpublishWebmailDnsRecord(db, existing.domainId, domainRow.domainName, effectiveKey);
        }
      }
    } catch (err) {
      console.warn(
        `[email-domains] webmail DNS sync failed for ${domainId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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

// Round-4 Phase 2: webmail provisioning lifecycle status writer.
// Centralizes the column updates so every transition path looks
// the same and we never accidentally leave a row in 'pending'.
//
// Review HIGH-1: type is the canonical one from
// @k8s-hosting/api-contracts so the backend and frontend cannot
// drift on lifecycle values.
async function setWebmailStatus(
  db: Database,
  emailDomainId: string,
  status: WebmailStatus,
  message: string | null = null,
): Promise<void> {
  await db
    .update(emailDomains)
    .set({
      webmailStatus: status,
      webmailStatusMessage: message,
      webmailStatusUpdatedAt: new Date(),
    })
    .where(eq(emailDomains.id, emailDomainId));
}

/**
 * Ensure a webmail.<domain> Ingress + ExternalName Service exist in
 * the client's namespace, pointing at the shared Roundcube Service in
 * the `mail` namespace.
 *
 * Called by enableEmailForDomain and updateEmailDomain (when
 * webmail_enabled is toggled on). Idempotent on 409 (replace).
 *
 * Round-4 Phase 2: writes the webmail_status column at every
 * transition (pending → ready / ready_no_tls / failed) so the UI
 * can render an accurate badge instead of relying on the
 * fire-and-forget notification.
 */
export async function ensureWebmailIngress(
  db: Database,
  k8s: K8sClients | undefined,
  emailDomainId: string,
): Promise<{ ingressCreated: boolean; reason?: string; status: WebmailStatus }> {
  if (!k8s) return { ingressCreated: false, reason: 'no k8s client', status: 'failed' };

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

  if (!row) return { ingressCreated: false, reason: 'email_domain not found', status: 'failed' };
  if (row.webmailEnabled !== 1) {
    // Review HIGH-3: this branch is a contract violation by the
    // caller — `ensureWebmailIngress` should never be invoked when
    // webmail is disabled. Returning a `'pending'` status would
    // mislead callers about the actual DB state. Return whatever
    // the row currently holds (read-back) so the response is
    // consistent with the row.
    const [current] = await db
      .select({ webmailStatus: emailDomains.webmailStatus })
      .from(emailDomains)
      .where(eq(emailDomains.id, row.emailDomainId));
    return {
      ingressCreated: false,
      reason: 'webmail_enabled=false',
      status: (current?.webmailStatus ?? 'failed') as WebmailStatus,
    };
  }

  // Mark pending at the start so the UI sees the transition.
  await setWebmailStatus(db, row.emailDomainId, 'pending');

  const [client] = await db.select().from(clients).where(eq(clients.id, row.clientId));
  if (!client) {
    await setWebmailStatus(db, row.emailDomainId, 'failed', 'client row not found');
    return { ingressCreated: false, reason: 'client not found', status: 'failed' };
  }
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
    if (statusCode !== 409) {
      const msg = err instanceof Error ? err.message : String(err);
      await setWebmailStatus(db, row.emailDomainId, 'failed', `ExternalName service create failed: ${msg}`);
      throw err;
    }
    try {
      await k8s.core.replaceNamespacedService({
        name: externalSvcName,
        namespace,
        body: externalSvcBody,
      });
    } catch (replaceErr) {
      const msg = replaceErr instanceof Error ? replaceErr.message : String(replaceErr);
      await setWebmailStatus(db, row.emailDomainId, 'failed', `ExternalName service replace failed: ${msg}`);
      throw replaceErr;
    }
  }

  // Step 2: ensure the Ingress rule for webmail.<domain>
  //
  // Use ensureRouteCertificate to get the right secret name. Round-3
  // round-2 surfaced cert failures as a client-facing notification.
  // Round-4 Phase 2: cert failure is no longer a "failed" outcome —
  // the Ingress is still created without TLS and is reachable on
  // plain HTTP. Status becomes 'ready_no_tls' and the cert
  // reconciler can flip it to 'ready' once cert-manager catches up.
  const { ensureRouteCertificate } = await import('../certificates/service.js');
  let certResult: Awaited<ReturnType<typeof ensureRouteCertificate>> | null = null;
  let certError: string | null = null;
  try {
    certResult = await ensureRouteCertificate(db, k8s, row.domainId, hostname);
  } catch (err) {
    certError = err instanceof Error ? err.message : String(err);
    console.warn(
      `[email-domains] ensureRouteCertificate failed for ${hostname}: ${certError}`,
    );
  }

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
    if (statusCode !== 409) {
      const msg = err instanceof Error ? err.message : String(err);
      await setWebmailStatus(db, row.emailDomainId, 'failed', `Ingress create failed: ${msg}`);
      throw err;
    }
    try {
      await k8s.networking.replaceNamespacedIngress({
        name: ingressName,
        namespace,
        body: ingressBody,
      });
    } catch (replaceErr) {
      const msg = replaceErr instanceof Error ? replaceErr.message : String(replaceErr);
      await setWebmailStatus(db, row.emailDomainId, 'failed', `Ingress replace failed: ${msg}`);
      throw replaceErr;
    }
  }

  // Final status: ready (with TLS) or ready_no_tls (cert pending/failed).
  const finalStatus: WebmailStatus = tls ? 'ready' : 'ready_no_tls';
  const finalMessage = certError
    ? `Ingress is serving HTTP but TLS certificate is not yet issued: ${certError}`
    : null;
  await setWebmailStatus(db, row.emailDomainId, finalStatus, finalMessage);

  return { ingressCreated: true, status: finalStatus };
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
