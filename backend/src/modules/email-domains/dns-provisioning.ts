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

/**
 * MEDIUM-2: deterministic MTA-STS policy ID derived from the domain
 * name. Collisions across different domains are astronomically
 * unlikely (16-hex-char hash prefix) and the result is 100%
 * reproducible, so every call to buildBaseRecords returns the same
 * value for the same domain.
 */
function mtaStsPolicyId(domainName: string): string {
  return crypto.createHash('sha256').update(domainName).digest('hex').slice(0, 16);
}

async function syncRecordToProviders(
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
    {
      recordType: 'MX',
      recordName: domainName,
      recordValue: `mail.${domainName}`,
      ttl: 3600,
      priority: 10,
      purpose: 'mx',
    },
    {
      recordType: 'A',
      recordName: `mail.${domainName}`,
      recordValue: MAIL_SERVER_IP(),
      ttl: 3600,
      priority: null,
      purpose: 'mail_host',
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
    // ─── Phase 3.C.2: autoconfig / autodiscover CNAME records ───────
    // Thunderbird tries https://autoconfig.<domain>/mail/config-v1.1.xml
    // Outlook tries https://autodiscover.<domain>/Autodiscover/Autodiscover.xml
    // Both CNAME to the platform's mail hostname, which runs the
    // public email-autodiscover routes from Phase 3.C.1.
    {
      recordType: 'CNAME',
      recordName: `autoconfig.${domainName}`,
      recordValue: mailServerHostname,
      ttl: 3600,
      priority: null,
      purpose: 'autoconfig',
    },
    {
      recordType: 'CNAME',
      recordName: `autodiscover.${domainName}`,
      recordValue: mailServerHostname,
      ttl: 3600,
      priority: null,
      purpose: 'autoconfig',
    },
    // ─── Phase 3.C.2: MTA-STS policy discovery ──────────────────────
    // Mail servers look up _mta-sts.<domain> TXT for the policy ID,
    // then fetch https://mta-sts.<domain>/.well-known/mta-sts.txt
    // for the actual policy. We CNAME mta-sts.<domain> to the
    // platform autodiscover host so the policy file is served from
    // the email-autodiscover routes.
    {
      recordType: 'TXT',
      recordName: `_mta-sts.${domainName}`,
      // Review round-3 MEDIUM-2: derive a stable policy ID from the
      // domain name instead of Date.now(), so the value is the same
      // on every call to this builder. MTA-STS clients treat a
      // changed id= as a policy update and re-fetch; using a
      // deterministic ID avoids spurious re-fetches and makes the
      // DNS records view consistent with what was published.
      recordValue: `v=STSv1; id=${mtaStsPolicyId(domainName)}`,
      ttl: 3600,
      priority: null,
      purpose: 'mta_sts',
    },
    {
      recordType: 'CNAME',
      recordName: `mta-sts.${domainName}`,
      recordValue: mailServerHostname,
      ttl: 3600,
      priority: null,
      purpose: 'mta_sts',
    },
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
  // Find all email-related DNS records for this domain
  const emailRecordTypes = ['MX', 'TXT'];
  const allRecords = await db
    .select()
    .from(dnsRecords)
    .where(eq(dnsRecords.domainId, domainId));

  const emailRecords = allRecords.filter((r) => {
    if (r.recordType === 'MX') return true;
    if (r.recordType === 'A' && r.recordName?.startsWith('mail.')) return true;
    if (r.recordType === 'TXT') {
      const val = r.recordValue ?? '';
      return (
        val.startsWith('v=spf1') ||
        val.startsWith('v=DKIM1') ||
        val.startsWith('v=DMARC1')
      );
    }
    return false;
  });

  for (const record of emailRecords) {
    await db.delete(dnsRecords).where(eq(dnsRecords.id, record.id));
  }
}
