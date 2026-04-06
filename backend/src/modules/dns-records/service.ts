import { eq, and } from 'drizzle-orm';
import { dnsRecords, domains } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { getActiveServers, getActiveServersForDomain, getProviderForServer } from '../dns-servers/service.js';
import type { Database } from '../../db/index.js';
import type { CreateDnsRecordInput, UpdateDnsRecordInput } from './schema.js';
import type { DnsRecord as DnsRecordRow } from '../../db/schema.js';

const encryptionKey = () => process.env.OIDC_ENCRYPTION_KEY ?? '0'.repeat(64) /* Dev-only fallback — production requires OIDC_ENCRYPTION_KEY env var */;

export async function syncRecordToProviders(
  db: Database,
  domainName: string,
  action: 'create' | 'update' | 'delete',
  record: { type: string; name: string; content: string; ttl?: number; priority?: number | null; id?: string },
  domainId?: string,
) {
  try {
    // Use domain-scoped servers when domainId is available, otherwise fall back to all active servers
    const servers = domainId
      ? await getActiveServersForDomain(db, domainId)
      : await getActiveServers(db);

    for (const server of servers) {
      try {
        const provider = getProviderForServer(server, encryptionKey());
        if (action === 'create' || action === 'update') {
          await provider.createRecord(domainName, { type: record.type, name: record.name, content: record.content, ttl: record.ttl ?? 3600, priority: record.priority ?? undefined });
        } else if (action === 'delete' && record.id) {
          await provider.deleteRecord(domainName, `${record.name}|${record.type}|${record.content}`);
        }
      } catch (err) {
        console.warn(`[dns-sync] Failed to ${action} record on ${server.displayName}:`, err instanceof Error ? err.message : String(err));
      }
    }
  } catch (err) {
    console.warn('[dns-sync] Failed to get active DNS servers:', err instanceof Error ? err.message : String(err));
  }
}

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

export async function listDnsRecords(db: Database, clientId: string, domainId: string) {
  await verifyDomainOwnership(db, clientId, domainId);

  return db
    .select()
    .from(dnsRecords)
    .where(eq(dnsRecords.domainId, domainId));
}

export async function createDnsRecord(
  db: Database,
  clientId: string,
  domainId: string,
  input: CreateDnsRecordInput,
) {
  await verifyDomainOwnership(db, clientId, domainId);

  const id = crypto.randomUUID();

  await db.insert(dnsRecords).values({
    id,
    domainId,
    recordType: input.record_type,
    recordName: input.record_name ?? null,
    recordValue: input.record_value,
    ttl: input.ttl ?? 3600,
    priority: input.priority ?? null,
    weight: input.weight ?? null,
    port: input.port ?? null,
  });

  const [created] = await db
    .select()
    .from(dnsRecords)
    .where(eq(dnsRecords.id, id));

  // Sync to external DNS servers (domain-scoped)
  const [domain] = await db.select().from(domains).where(eq(domains.id, domainId));
  if (domain) {
    await syncRecordToProviders(db, domain.domainName, 'create', {
      type: input.record_type, name: input.record_name ?? '@', content: input.record_value,
      ttl: input.ttl, priority: input.priority,
    }, domainId);
  }

  return created;
}

export async function updateDnsRecord(
  db: Database,
  clientId: string,
  domainId: string,
  recordId: string,
  input: UpdateDnsRecordInput,
) {
  await verifyDomainOwnership(db, clientId, domainId);

  const [record] = await db
    .select()
    .from(dnsRecords)
    .where(and(eq(dnsRecords.id, recordId), eq(dnsRecords.domainId, domainId)));

  if (!record) {
    throw new ApiError('DNS_RECORD_NOT_FOUND', `DNS record '${recordId}' not found`, 404);
  }

  const updateValues: Record<string, unknown> = {};
  if (input.record_value !== undefined) updateValues.recordValue = input.record_value;
  if (input.ttl !== undefined) updateValues.ttl = input.ttl;
  if (input.priority !== undefined) updateValues.priority = input.priority;
  if (input.weight !== undefined) updateValues.weight = input.weight;
  if (input.port !== undefined) updateValues.port = input.port;

  if (Object.keys(updateValues).length > 0) {
    await db
      .update(dnsRecords)
      .set(updateValues)
      .where(eq(dnsRecords.id, recordId));
  }

  const [updated] = await db
    .select()
    .from(dnsRecords)
    .where(eq(dnsRecords.id, recordId));

  // Sync updated record to external DNS servers (domain-scoped)
  const [domain] = await db.select().from(domains).where(eq(domains.id, domainId));
  if (domain && updated) {
    await syncRecordToProviders(db, domain.domainName, 'update', {
      type: updated.recordType,
      name: updated.recordName ?? '@',
      content: updated.recordValue ?? '',
      ttl: updated.ttl,
      priority: updated.priority,
      id: recordId,
    }, domainId);
  }

  return updated;
}

export async function deleteDnsRecord(
  db: Database,
  clientId: string,
  domainId: string,
  recordId: string,
) {
  await verifyDomainOwnership(db, clientId, domainId);

  const [record] = await db
    .select()
    .from(dnsRecords)
    .where(and(eq(dnsRecords.id, recordId), eq(dnsRecords.domainId, domainId)));

  if (!record) {
    throw new ApiError('DNS_RECORD_NOT_FOUND', `DNS record '${recordId}' not found`, 404);
  }

  await db.delete(dnsRecords).where(eq(dnsRecords.id, recordId));

  // Sync deletion to external DNS servers (domain-scoped)
  const [domain] = await db.select().from(domains).where(eq(domains.id, domainId));
  if (domain && record.recordType && record.recordValue) {
    await syncRecordToProviders(db, domain.domainName, 'delete', {
      type: record.recordType, name: record.recordName ?? '@', content: record.recordValue ?? '',
      id: recordId,
    }, domainId);
  }
}

export async function syncRecordsFromProvider(
  db: Database,
  clientId: string,
  domainId: string,
): Promise<DnsRecordRow[]> {
  await verifyDomainOwnership(db, clientId, domainId);

  const [domainRow] = await db.select().from(domains).where(eq(domains.id, domainId));
  if (!domainRow) {
    throw new ApiError('DOMAIN_NOT_FOUND', 'Domain not found', 404);
  }

  // Use domain-scoped servers
  const servers = await getActiveServersForDomain(db, domainId);
  if (servers.length === 0) {
    // Fall back to all active servers for backward compat
    const allServers = await getActiveServers(db);
    if (allServers.length === 0) {
      throw new ApiError('NO_DNS_SERVERS', 'No DNS servers configured', 400);
    }
    servers.push(...allServers);
  }

  const provider = getProviderForServer(servers[0], encryptionKey());
  const remoteRecords = await provider.listRecords(domainRow.domainName);

  // Delete all existing local records for this domain
  await db.delete(dnsRecords).where(eq(dnsRecords.domainId, domainId));

  // Insert remote records
  for (const r of remoteRecords) {
    await db.insert(dnsRecords).values({
      id: crypto.randomUUID(),
      domainId,
      recordType: r.type as typeof dnsRecords.$inferInsert['recordType'],
      recordName: r.name,
      recordValue: r.content,
      ttl: r.ttl ?? 3600,
      priority: r.priority ?? null,
    });
  }

  // Return updated list
  return db.select().from(dnsRecords).where(eq(dnsRecords.domainId, domainId));
}
