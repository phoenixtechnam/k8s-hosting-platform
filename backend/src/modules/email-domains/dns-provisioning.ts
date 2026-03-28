import { eq, and } from 'drizzle-orm';
import { dnsRecords, emailDomains } from '../../db/schema.js';
import { getActiveServers, getProviderForServer } from '../dns-servers/service.js';
import { formatDkimDnsValue } from './dkim.js';
import type { Database } from '../../db/index.js';

const MAIL_SERVER_IP = () => process.env.MAIL_SERVER_IP ?? '127.0.0.1';

async function syncRecordToProviders(
  db: Database,
  domainName: string,
  action: 'create' | 'delete',
  record: { type: string; name: string; content: string; ttl?: number; priority?: number | null; id?: string },
  encryptionKey: string,
) {
  try {
    const servers = await getActiveServers(db);
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

interface DnsRecordSpec {
  readonly recordType: string;
  readonly recordName: string;
  readonly recordValue: string;
  readonly ttl: number;
  readonly priority: number | null;
}

function buildEmailDnsRecords(
  domainName: string,
  dkimSelector: string,
  dkimPublicKey: string,
): readonly DnsRecordSpec[] {
  return [
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
  ];
}

export async function provisionEmailDns(
  db: Database,
  domainId: string,
  domainName: string,
  dkimSelector: string,
  dkimPublicKey: string,
  encryptionKey: string,
): Promise<void> {
  const records = buildEmailDnsRecords(domainName, dkimSelector, dkimPublicKey);

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

    await syncRecordToProviders(db, domainName, 'create', {
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
