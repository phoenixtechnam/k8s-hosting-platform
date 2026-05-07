import { eq } from 'drizzle-orm';
import crypto from 'crypto';
import { dnsRecords, emailDomains, domains } from '../../db/schema.js';
import { getActiveServersForDomain, getProviderForServer } from '../dns-servers/service.js';
import { canManageDnsZone } from '../dns-servers/authority.js';
import { formatDkimDnsValue } from './dkim.js';
import type { Database } from '../../db/index.js';

// Round-4 Phase 1: multi-step fallback so deployments only need to
// set the one env var they already have. INGRESS_DEFAULT_IPV4 is
// already wired into docker-compose.local.yml for the local stack
// and should be the canonical platform ingress IP in production.
// 127.0.0.1 is a last-resort dev fallback — a WARN fires the first
// time a record is built so operators see it in logs.
//
// Review HIGH-1 fix: an empty string in a Docker Compose / systemd
// env file (e.g. `MAIL_SERVER_IP=`) is functionally undefined, NOT
// a valid override. Normalize blank values to undefined before the
// truthiness gate so the fallback chain progresses correctly.
let mailServerIpWarned = false;
const normalizeEnv = (v: string | undefined): string | undefined => {
  if (v === undefined) return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};
const MAIL_SERVER_IP = (): string => {
  const explicit = normalizeEnv(process.env.MAIL_SERVER_IP);
  if (explicit) return explicit;
  const ingressIp = normalizeEnv(process.env.INGRESS_DEFAULT_IPV4);
  if (ingressIp) return ingressIp;
  if (!mailServerIpWarned) {
    console.warn(
      '[email-dns] Neither MAIL_SERVER_IP nor INGRESS_DEFAULT_IPV4 is set — '
      + 'falling back to 127.0.0.1 for mail.<domain> and webmail.<domain> A records. '
      + 'This is almost certainly wrong in production.',
    );
    mailServerIpWarned = true;
  }
  return '127.0.0.1';
};

// mtaStsPolicyId() helper removed 2026-05-06 along with the MTA-STS
// records — see the comment block where the records were dropped.

export async function syncRecordToProviders(
  db: Database,
  domainId: string,
  domainName: string,
  action: 'create' | 'delete',
  record: { type: string; name: string; content: string; ttl?: number; priority?: number | null; id?: string },
  encryptionKey: string,
) {
  try {
    // Phase 2c: only push records when the platform has authority over the
    // zone. Previously this silently tried to write and swallowed errors,
    // which made debugging cname-mode domains confusing (the email provider
    // row was marked provisioned=1 even though nothing hit DNS).
    const [domain] = await db
      .select({ dnsMode: domains.dnsMode })
      .from(domains)
      .where(eq(domains.id, domainId));
    if (!domain) return;

    const servers = await getActiveServersForDomain(db, domainId);
    const canManage = canManageDnsZone({
      dnsMode: domain.dnsMode as 'primary' | 'cname' | 'secondary',
      activeServers: servers.map((s) => ({
        id: s.id,
        providerType: s.providerType,
        enabled: s.enabled,
        role: s.role,
      })),
    });
    if (!canManage) {
      console.info(
        `[email-dns] Skipping ${action} of ${record.type} '${record.name}' — platform is not authoritative for '${domainName}' (dnsMode=${domain.dnsMode})`,
      );
      return;
    }

    for (const server of servers) {
      try {
        const provider = getProviderForServer(server, encryptionKey);
        if (action === 'create') {
          await provider.createRecord(domainName, {
            type: record.type,
            name: record.name,
            content: record.content,
            ttl: record.ttl ?? 3600,
            priority: record.priority ?? undefined,
          });
        } else if (action === 'delete' && record.id) {
          await provider.deleteRecord(domainName, `${record.name}|${record.type}|${record.content}`);
        }
      } catch { /* DNS sync failure shouldn't block — log and continue */ }
    }
  } catch { /* no servers configured */ }
}

export type DnsRecordPurpose =
  | 'mx'
  | 'mail_host'
  | 'spf'
  | 'dkim'
  | 'dmarc'
  | 'srv'
  | 'autoconfig'
  | 'mta_sts'
  | 'webmail';

export interface DnsRecordSpec {
  readonly recordType: string;
  readonly recordName: string;
  readonly recordValue: string;
  readonly ttl: number;
  readonly priority: number | null;
  // Round-3: purpose lets the UI group/label records and the
  // update handler identify which record(s) correspond to a
  // particular email-domain feature (e.g. webmail).
  readonly purpose: DnsRecordPurpose;
}

// Exported so the read-only "view DNS records" endpoint can reuse
// the exact same list the provisioning path writes — no drift.
export function buildEmailDnsRecordsForDisplay(
  domainName: string,
  dkimSelector: string,
  dkimPublicKey: string,
  mailServerHostname: string,
  options: { readonly webmailEnabled?: boolean } = {},
): readonly DnsRecordSpec[] {
  return buildEmailDnsRecords(
    domainName,
    dkimSelector,
    dkimPublicKey,
    mailServerHostname,
    options,
  );
}

function buildEmailDnsRecords(
  domainName: string,
  dkimSelector: string,
  dkimPublicKey: string,
  mailServerHostname: string,
  options: { readonly webmailEnabled?: boolean } = {},
): readonly DnsRecordSpec[] {
  const webmailRecord: DnsRecordSpec | null = options.webmailEnabled
    ? {
      recordType: 'A',
      recordName: `webmail.${domainName}`,
      recordValue: MAIL_SERVER_IP(),
      ttl: 3600,
      priority: null,
      purpose: 'webmail',
    }
    : null;

  const base: readonly DnsRecordSpec[] = buildBaseRecords(
    domainName,
    dkimSelector,
    dkimPublicKey,
    mailServerHostname,
  );
  return webmailRecord ? [...base, webmailRecord] : base;
}

function buildBaseRecords(
  domainName: string,
  dkimSelector: string,
  dkimPublicKey: string,
  mailServerHostname: string,
): readonly DnsRecordSpec[] {
  return [
    // ─── Core receiving records ────────────────────────────
    // MX target is the platform mail-server hostname directly (e.g.
    // mail.platformdomain.com), NOT a per-client mail.<domainName>
    // alias. Reasons:
    //   1. Stalwart's TLS cert covers mail.${PLATFORM_DOMAIN} (single
    //      SAN) — sending MTAs validate SNI against the cert, so
    //      pointing at a per-client hostname triggers a TLS-mismatch
    //      reject by strict receivers (Gmail, Microsoft).
    //   2. MTA-STS is impossible without a cert that covers the
    //      MX-target hostname — sticking with the platform hostname
    //      keeps that path open.
    //   3. One less DNS record per client (no per-client mail.A).
    {
      recordType: 'MX',
      recordName: domainName,
      recordValue: mailServerHostname,
      ttl: 3600,
      priority: 10,
      purpose: 'mx',
    },
    // ─── SPF / DKIM / DMARC ────────────────────────────────
    {
      recordType: 'TXT',
      recordName: domainName,
      recordValue: 'v=spf1 mx ~all',
      ttl: 3600,
      priority: null,
      purpose: 'spf',
    },
    {
      recordType: 'TXT',
      recordName: `${dkimSelector}._domainkey.${domainName}`,
      recordValue: formatDkimDnsValue(dkimPublicKey),
      ttl: 3600,
      priority: null,
      purpose: 'dkim',
    },
    {
      recordType: 'TXT',
      recordName: `_dmarc.${domainName}`,
      recordValue: `v=DMARC1; p=quarantine; rua=mailto:dmarc-reports@${domainName}`,
      ttl: 3600,
      priority: null,
      purpose: 'dmarc',
    },
    // ─── Phase 3.C.2: SRV records for mail client autodiscovery ─────
    // Thunderbird and Apple Mail probe SRV records before resorting
    // to guesses. Port + priority + weight per RFC 6186.
    {
      recordType: 'SRV',
      recordName: `_imaps._tcp.${domainName}`,
      recordValue: `0 1 993 ${mailServerHostname}`,
      ttl: 3600,
      priority: 0,
      purpose: 'srv',
    },
    {
      recordType: 'SRV',
      recordName: `_imap._tcp.${domainName}`,
      recordValue: `10 1 143 ${mailServerHostname}`,
      ttl: 3600,
      priority: 10,
      purpose: 'srv',
    },
    {
      recordType: 'SRV',
      recordName: `_submissions._tcp.${domainName}`,
      recordValue: `0 1 465 ${mailServerHostname}`,
      ttl: 3600,
      priority: 0,
      purpose: 'srv',
    },
    {
      recordType: 'SRV',
      recordName: `_submission._tcp.${domainName}`,
      recordValue: `10 1 587 ${mailServerHostname}`,
      ttl: 3600,
      priority: 10,
      purpose: 'srv',
    },
    // ─── autoconfig / autodiscover CNAMEs (REMOVED 2026-05-06) ──────
    // Previously this block created CNAMEs autoconfig.<domain> and
    // autodiscover.<domain> → platform mail hostname. The intent was
    // to let Thunderbird/Outlook discovery probes find the mail
    // server. The reality:
    //
    //   - Thunderbird probes https://autoconfig.<domain>/...
    //   - The TLS handshake's SNI = autoconfig.<domain>, but the
    //     server (Stalwart) only has a cert for the single SAN
    //     mail.${PLATFORM_DOMAIN} → cert mismatch → handshake fails
    //   - Same for autodiscover (Outlook).
    //
    // Per-client cert provisioning to fix this is significant infra
    // work (cert-manager Cert CR per client, DNS automation, lifecycle
    // hooks). It's out of scope for the TLS-bootstrap rewrite. SRV
    // records (above) are the cheap-but-effective layer that covers
    // Thunderbird, K-9, FairEmail, Mailspring, partial Apple Mail
    // without any cert issues. Outlook autodiscover support becomes
    // a separate follow-up phase if/when customer demand justifies
    // the per-client cert provisioning.
    //
    // The TXT/CNAME entries previously written for these records will
    // be removed from PowerDNS the next time the domain is
    // re-provisioned via the existing diff-and-reconcile path.
    // ─── MTA-STS records (REMOVED 2026-05-06) ───────────────────────
    // Same cert-mismatch problem as the autoconfig CNAMEs above:
    // MTA-STS spec (RFC 8461) requires the policy file to be served
    // over HTTPS at mta-sts.<domain>/.well-known/mta-sts.txt with a
    // cert that validates against mta-sts.<domain>. Stalwart's single-
    // SAN cert (mail.${PLATFORM_DOMAIN}) doesn't cover mta-sts.<client>
    // → policy fetch fails → strict-mode MTAs reject delivery,
    // testing-mode MTAs downgrade.
    //
    // The previously-advertised _mta-sts.<domain> TXT + mta-sts.<domain>
    // CNAME are dropped together. _mta-sts TXT alone advertises a
    // policy that can't be fetched, which is worse than no policy
    // (misleading vs. silent). Both records will be removed from
    // PowerDNS the next time the domain is re-provisioned.
    //
    // Re-introducing MTA-STS requires per-client cert provisioning
    // (cert-manager Cert CR per client domain covering at least
    // mta-sts.<client>). Same precondition as Outlook autodiscover —
    // tracked as a separate phase.
  ];
}

export async function provisionEmailDns(
  db: Database,
  domainId: string,
  domainName: string,
  dkimSelector: string,
  dkimPublicKey: string,
  encryptionKey: string,
  mailServerHostname: string,
  options: { readonly webmailEnabled?: boolean } = {},
): Promise<void> {
  const records = buildEmailDnsRecords(
    domainName,
    dkimSelector,
    dkimPublicKey,
    mailServerHostname,
    options,
  );

  for (const rec of records) {
    const id = crypto.randomUUID();
    await db.insert(dnsRecords).values({
      id,
      domainId,
      recordType: rec.recordType as 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'SRV' | 'NS',
      recordName: rec.recordName,
      recordValue: rec.recordValue,
      ttl: rec.ttl,
      priority: rec.priority,
    });

    await syncRecordToProviders(db, domainId, domainName, 'create', {
      type: rec.recordType,
      name: rec.recordName,
      content: rec.recordValue,
      ttl: rec.ttl,
      priority: rec.priority,
    }, encryptionKey);
  }

  await db
    .update(emailDomains)
    .set({
      mxProvisioned: 1,
      spfProvisioned: 1,
      dkimProvisioned: 1,
      dmarcProvisioned: 1,
    })
    .where(eq(emailDomains.domainId, domainId));
}

// Round-3: idempotently publish / unpublish the webmail.<domain> A
// record. Used by updateEmailDomain when webmail_enabled flips.
// Returns true if a DB row was inserted/deleted.
export async function publishWebmailDnsRecord(
  db: Database,
  domainId: string,
  domainName: string,
  encryptionKey: string,
): Promise<boolean> {
  const hostname = `webmail.${domainName}`;
  const value = MAIL_SERVER_IP();

  // Idempotent insert — if the record already exists, leave it.
  const existing = await db
    .select()
    .from(dnsRecords)
    .where(eq(dnsRecords.domainId, domainId));
  const alreadyHasWebmail = existing.some(
    (r) => r.recordType === 'A' && r.recordName === hostname,
  );
  if (alreadyHasWebmail) return false;

  const id = crypto.randomUUID();
  await db.insert(dnsRecords).values({
    id,
    domainId,
    recordType: 'A',
    recordName: hostname,
    recordValue: value,
    ttl: 3600,
    priority: null,
  });

  await syncRecordToProviders(
    db,
    domainId,
    domainName,
    'create',
    { type: 'A', name: hostname, content: value, ttl: 3600, priority: null },
    encryptionKey,
  );
  return true;
}

export async function unpublishWebmailDnsRecord(
  db: Database,
  domainId: string,
  domainName: string,
  encryptionKey: string,
): Promise<boolean> {
  const hostname = `webmail.${domainName}`;
  const rows = await db
    .select()
    .from(dnsRecords)
    .where(eq(dnsRecords.domainId, domainId));
  const matches = rows.filter(
    (r) => r.recordType === 'A' && r.recordName === hostname,
  );
  if (matches.length === 0) return false;

  for (const m of matches) {
    await db.delete(dnsRecords).where(eq(dnsRecords.id, m.id));
    await syncRecordToProviders(
      db,
      domainId,
      domainName,
      'delete',
      {
        type: 'A',
        name: hostname,
        content: m.recordValue ?? '',
        ttl: 3600,
        priority: null,
        id: m.id,
      },
      encryptionKey,
    );
  }
  return true;
}

export async function deprovisionEmailDns(
  db: Database,
  domainId: string,
): Promise<void> {
  // Find all email-related DNS records for this domain. The filter
  // below picks them by (type, name-pattern, value-prefix) — so a
  // generic recordType allowlist is unnecessary.
  const allRecords = await db
    .select()
    .from(dnsRecords)
    .where(eq(dnsRecords.domainId, domainId));

  const emailRecords = allRecords.filter((r) => {
    if (r.recordType === 'MX') return true;
    if (r.recordType === 'A' && r.recordName?.startsWith('mail.')) return true;
    if (r.recordType === 'SRV') {
      // Catches all four mail-discovery SRV records by name prefix
      // (_imaps._tcp / _imap._tcp / _submissions._tcp / _submission._tcp).
      const name = r.recordName ?? '';
      return /^_(imaps?|submissions?)\._tcp\./.test(name);
    }
    if (r.recordType === 'CNAME') {
      // Legacy autoconfig / autodiscover / mta-sts CNAMEs created by
      // earlier provisioning code (removed 2026-05-06). Cleanup
      // catches them so re-provisioning leaves no orphans in PowerDNS.
      const name = r.recordName ?? '';
      return /^(autoconfig|autodiscover|mta-sts)\./.test(name);
    }
    if (r.recordType === 'TXT') {
      const val = r.recordValue ?? '';
      return (
        val.startsWith('v=spf1') ||
        val.startsWith('v=DKIM1') ||
        val.startsWith('v=DMARC1') ||
        val.startsWith('v=STSv1')
      );
    }
    return false;
  });

  for (const record of emailRecords) {
    await db.delete(dnsRecords).where(eq(dnsRecords.id, record.id));
  }
}
