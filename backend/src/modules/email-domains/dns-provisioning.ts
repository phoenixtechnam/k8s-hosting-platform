import { eq } from 'drizzle-orm';
import { dnsRecords, emailDomains, domains } from '../../db/schema.js';
import { getActiveServersForDomain, getProviderForServer } from '../dns-servers/service.js';
import { canManageDnsZone } from '../dns-servers/authority.js';
import { formatDkimDnsValue } from './dkim.js';
import type { Database } from '../../db/index.js';

const MAIL_SERVER_IP = () => process.env.MAIL_SERVER_IP ?? '127.0.0.1';

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

export interface DnsRecordSpec {
  readonly recordType: string;
  readonly recordName: string;
  readonly recordValue: string;
  readonly ttl: number;
  readonly priority: number | null;
}

// Exported so the read-only "view DNS records" endpoint can reuse
// the exact same list the provisioning path writes — no drift.
export function buildEmailDnsRecordsForDisplay(
  domainName: string,
  dkimSelector: string,
  dkimPublicKey: string,
  mailServerHostname: string,
): readonly DnsRecordSpec[] {
  return buildEmailDnsRecords(domainName, dkimSelector, dkimPublicKey, mailServerHostname);
}

function buildEmailDnsRecords(
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
    },
    {
      recordType: 'A',
      recordName: `mail.${domainName}`,
      recordValue: MAIL_SERVER_IP(),
      ttl: 3600,
      priority: null,
    },
    // ─── SPF / DKIM / DMARC ────────────────────────────────
    {
      recordType: 'TXT',
      recordName: domainName,
      recordValue: 'v=spf1 mx ~all',
      ttl: 3600,
      priority: null,
    },
    {
      recordType: 'TXT',
      recordName: `${dkimSelector}._domainkey.${domainName}`,
      recordValue: formatDkimDnsValue(dkimPublicKey),
      ttl: 3600,
      priority: null,
    },
    {
      recordType: 'TXT',
      recordName: `_dmarc.${domainName}`,
      recordValue: `v=DMARC1; p=quarantine; rua=mailto:dmarc-reports@${domainName}`,
      ttl: 3600,
      priority: null,
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
    },
    {
      recordType: 'SRV',
      recordName: `_imap._tcp.${domainName}`,
      recordValue: `10 1 143 ${mailServerHostname}`,
      ttl: 3600,
      priority: 10,
    },
    {
      recordType: 'SRV',
      recordName: `_submissions._tcp.${domainName}`,
      recordValue: `0 1 465 ${mailServerHostname}`,
      ttl: 3600,
      priority: 0,
    },
    {
      recordType: 'SRV',
      recordName: `_submission._tcp.${domainName}`,
      recordValue: `10 1 587 ${mailServerHostname}`,
      ttl: 3600,
      priority: 10,
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
    },
    {
      recordType: 'CNAME',
      recordName: `autodiscover.${domainName}`,
      recordValue: mailServerHostname,
      ttl: 3600,
      priority: null,
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
      recordValue: `v=STSv1; id=${Date.now()}`,
      ttl: 3600,
      priority: null,
    },
    {
      recordType: 'CNAME',
      recordName: `mta-sts.${domainName}`,
      recordValue: mailServerHostname,
      ttl: 3600,
      priority: null,
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
): Promise<void> {
  const records = buildEmailDnsRecords(domainName, dkimSelector, dkimPublicKey, mailServerHostname);

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
