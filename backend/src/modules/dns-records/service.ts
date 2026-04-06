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

export interface DnsRecordDiffEntry {
  readonly type: string;
  readonly name: string;
  readonly local: { value: string; ttl: number; id: string } | null;
  readonly remote: { value: string; ttl: number } | null;
  readonly status: 'in_sync' | 'conflict' | 'local_only' | 'remote_only';
}

export async function diffRecordsWithProvider(
  db: Database,
  clientId: string,
  domainId: string,
): Promise<DnsRecordDiffEntry[]> {
  await verifyDomainOwnership(db, clientId, domainId);

  const [domainRow] = await db.select().from(domains).where(eq(domains.id, domainId));
  if (!domainRow) throw new ApiError('DOMAIN_NOT_FOUND', 'Domain not found', 404);

  // Get local records
  const localRecords = await db.select().from(dnsRecords).where(eq(dnsRecords.domainId, domainId));

  // Get remote records from provider
  const servers = await getActiveServersForDomain(db, domainId);
  if (servers.length === 0) {
    const allServers = await getActiveServers(db);
    if (allServers.length === 0) throw new ApiError('NO_DNS_SERVERS', 'No DNS servers configured', 400);
    servers.push(...allServers);
  }

  const provider = getProviderForServer(servers[0], encryptionKey());
  let remoteRecords: Awaited<ReturnType<typeof provider.listRecords>>;
  try {
    remoteRecords = await provider.listRecords(domainRow.domainName);
  } catch {
    throw new ApiError('DNS_PROVIDER_ERROR', 'Failed to fetch records from DNS server', 503);
  }

  // Normalize names for comparison
  const domainFqdn = domainRow.domainName.endsWith('.') ? domainRow.domainName : `${domainRow.domainName}.`;

  function normalizeRecordName(name: string | null | undefined): string {
    if (!name || name === '@') return '@';
    const n = name.endsWith('.') ? name : `${name}.`;
    // Strip the domain suffix to get relative name
    if (n === domainFqdn) return '@';
    if (n.endsWith(`.${domainFqdn}`)) return n.slice(0, -(domainFqdn.length + 1));
    return name;
  }

  // Normalize value for comparison (strip TXT quotes, trailing dots on CNAME/NS/MX targets)
  function normalizeValue(value: string): string {
    let v = value;
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    return v;
  }

  // Build maps keyed by "type|normalizedName|normalizedValue"
  const localMap = new Map<string, typeof localRecords[0]>();
  for (const r of localRecords) {
    const key = `${r.recordType}|${normalizeRecordName(r.recordName)}|${normalizeValue(r.recordValue ?? '')}`;
    localMap.set(key, r);
  }

  const remoteMap = new Map<string, { type: string; name: string; content: string; ttl: number }>();
  for (const r of remoteRecords) {
    const key = `${r.type}|${normalizeRecordName(r.name)}|${normalizeValue(r.content)}`;
    remoteMap.set(key, r);
  }

  // Compute diff
  const diff: DnsRecordDiffEntry[] = [];
  const seen = new Set<string>();

  // Check local records against remote
  for (const [key, local] of localMap) {
    seen.add(key);
    const remote = remoteMap.get(key);
    if (remote) {
      diff.push({
        type: local.recordType,
        name: normalizeRecordName(local.recordName),
        local: { value: local.recordValue ?? '', ttl: local.ttl, id: local.id },
        remote: { value: remote.content, ttl: remote.ttl },
        status: 'in_sync',
      });
    } else {
      // Check if there's a remote with same type+name but different value (conflict)
      const typeNamePrefix = key.split('|').slice(0, 2).join('|');
      const conflicting = Array.from(remoteMap.entries()).find(([k]) => k.startsWith(typeNamePrefix + '|') && !seen.has(k));
      if (conflicting) {
        seen.add(conflicting[0]);
        diff.push({
          type: local.recordType,
          name: normalizeRecordName(local.recordName),
          local: { value: local.recordValue ?? '', ttl: local.ttl, id: local.id },
          remote: { value: conflicting[1].content, ttl: conflicting[1].ttl },
          status: 'conflict',
        });
      } else {
        diff.push({
          type: local.recordType,
          name: normalizeRecordName(local.recordName),
          local: { value: local.recordValue ?? '', ttl: local.ttl, id: local.id },
          remote: null,
          status: 'local_only',
        });
      }
    }
  }

  // Check remote records not yet seen (remote_only)
  for (const [key, remote] of remoteMap) {
    if (!seen.has(key)) {
      diff.push({
        type: remote.type,
        name: normalizeRecordName(remote.name),
        local: null,
        remote: { value: remote.content, ttl: remote.ttl },
        status: 'remote_only',
      });
    }
  }

  // Sort: conflicts first, then remote_only, then local_only, then in_sync
  const statusOrder = { conflict: 0, remote_only: 1, local_only: 2, in_sync: 3 };
  diff.sort((a, b) => statusOrder[a.status] - statusOrder[b.status] || a.type.localeCompare(b.type) || a.name.localeCompare(b.name));

  return diff;
}

export async function createDnsRecordLocalOnly(db: Database, clientId: string, domainId: string, input: CreateDnsRecordInput) {
  await verifyDomainOwnership(db, clientId, domainId);
  const id = crypto.randomUUID();
  await db.insert(dnsRecords).values({
    id,
    domainId,
    recordType: input.record_type as typeof dnsRecords.$inferInsert['recordType'],
    recordName: input.record_name ?? null,
    recordValue: input.record_value,
    ttl: input.ttl ?? 3600,
    priority: input.priority ?? null,
    weight: input.weight ?? null,
    port: input.port ?? null,
  });
  const [created] = await db.select().from(dnsRecords).where(eq(dnsRecords.id, id));
  return created;
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
