import { eq, and, like, desc, asc, lt, gt, sql } from 'drizzle-orm';
import { domains } from '../../db/schema.js';
import { domainNotFound, duplicateEntry } from '../../shared/errors.js';
import { encodeCursor, decodeCursor } from '../../shared/pagination.js';
import { getClientById } from '../clients/service.js';
import { getActiveServers, getProviderForServer } from '../dns-servers/service.js';
import type { Database } from '../../db/index.js';
import type { CreateDomainInput, UpdateDomainInput } from './schema.js';
import type { PaginationMeta } from '../../shared/response.js';

export async function createDomain(db: Database, clientId: string, input: CreateDomainInput) {
  // Verify client exists
  await getClientById(db, clientId);

  // Check for duplicate domain name
  const [existing] = await db.select().from(domains).where(eq(domains.domainName, input.domain_name));
  if (existing) {
    throw duplicateEntry('domain', input.domain_name);
  }

  const id = crypto.randomUUID();
  await db.insert(domains).values({
    id,
    clientId,
    domainName: input.domain_name,
    dnsMode: input.dns_mode,
    workloadId: input.workload_id ?? null,
    status: 'pending',
  });

  const [created] = await db.select().from(domains).where(eq(domains.id, id));

  // Auto-provision DNS zone on all active DNS servers
  const encryptionKey = process.env.OIDC_ENCRYPTION_KEY ?? '0'.repeat(64);
  try {
    const activeServers = await getActiveServers(db);
    for (const server of activeServers) {
      try {
        const provider = getProviderForServer(server, encryptionKey);
        const zoneKind = (server.zoneDefaultKind as 'Native' | 'Master') ?? 'Native';
        await provider.createZone(input.domain_name, zoneKind);
      } catch {
        // DNS provisioning failure shouldn't block domain creation — log and continue
      }
    }
  } catch {
    // No DNS servers configured — that's fine
  }

  return created;
}

export async function getDomainById(db: Database, clientId: string, domainId: string) {
  const [domain] = await db
    .select()
    .from(domains)
    .where(and(eq(domains.id, domainId), eq(domains.clientId, clientId)));
  if (!domain) throw domainNotFound(domainId);
  return domain;
}

export async function listAllDomains(
  db: Database,
  params: { limit: number; cursor?: string; sort: { field: string; direction: 'asc' | 'desc' }; search?: string },
): Promise<{ data: typeof domains.$inferSelect[]; pagination: PaginationMeta }> {
  const { limit, cursor, sort, search } = params;

  const conditions = [];
  if (search) {
    conditions.push(like(domains.domainName, `%${search}%`));
  }

  if (cursor) {
    const decoded = decodeCursor(cursor);
    conditions.push(
      sort.direction === 'desc' ? lt(domains.createdAt, new Date(decoded.sort)) : gt(domains.createdAt, new Date(decoded.sort)),
    );
  }

  const orderBy = sort.direction === 'desc' ? desc(domains.createdAt) : asc(domains.createdAt);
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select()
    .from(domains)
    .where(where)
    .orderBy(orderBy)
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const data = rows.slice(0, limit);

  let nextCursor: string | null = null;
  if (hasMore && data.length > 0) {
    const last = data[data.length - 1];
    nextCursor = encodeCursor({
      resource: 'domain',
      sort: last.createdAt.toISOString(),
      id: last.id,
    });
  }

  const countConditions = [];
  if (search) {
    countConditions.push(like(domains.domainName, `%${search}%`));
  }
  const countWhere = countConditions.length > 0 ? and(...countConditions) : undefined;
  const [countResult] = await db.select({ count: sql<number>`count(*)` }).from(domains).where(countWhere);

  return {
    data,
    pagination: {
      cursor: nextCursor,
      has_more: hasMore,
      page_size: data.length,
      total_count: Number(countResult?.count ?? 0),
    },
  };
}

export async function listDomains(
  db: Database,
  clientId: string,
  params: { limit: number; cursor?: string; sort: { field: string; direction: 'asc' | 'desc' }; search?: string },
): Promise<{ data: typeof domains.$inferSelect[]; pagination: PaginationMeta }> {
  const { limit, cursor, sort, search } = params;

  const conditions = [eq(domains.clientId, clientId)];
  if (search) {
    conditions.push(like(domains.domainName, `%${search}%`));
  }

  if (cursor) {
    const decoded = decodeCursor(cursor);
    conditions.push(
      sort.direction === 'desc' ? lt(domains.createdAt, new Date(decoded.sort)) : gt(domains.createdAt, new Date(decoded.sort)),
    );
  }

  const orderBy = sort.direction === 'desc' ? desc(domains.createdAt) : asc(domains.createdAt);
  const where = and(...conditions);

  const rows = await db
    .select()
    .from(domains)
    .where(where)
    .orderBy(orderBy)
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const data = rows.slice(0, limit);

  let nextCursor: string | null = null;
  if (hasMore && data.length > 0) {
    const last = data[data.length - 1];
    nextCursor = encodeCursor({
      resource: 'domain',
      sort: last.createdAt.toISOString(),
      id: last.id,
    });
  }

  const [countResult] = await db.select({ count: sql<number>`count(*)` }).from(domains).where(where);

  return {
    data,
    pagination: {
      cursor: nextCursor,
      has_more: hasMore,
      page_size: data.length,
      total_count: Number(countResult?.count ?? 0),
    },
  };
}

export async function updateDomain(db: Database, clientId: string, domainId: string, input: UpdateDomainInput) {
  await getDomainById(db, clientId, domainId);

  const updateValues: Record<string, unknown> = {};
  if (input.dns_mode !== undefined) updateValues.dnsMode = input.dns_mode;
  if (input.ssl_auto_renew !== undefined) updateValues.sslAutoRenew = input.ssl_auto_renew ? 1 : 0;
  if (input.status !== undefined) updateValues.status = input.status;
  if (input.workload_id !== undefined) updateValues.workloadId = input.workload_id;

  if (Object.keys(updateValues).length > 0) {
    await db.update(domains).set(updateValues).where(eq(domains.id, domainId));
  }

  return getDomainById(db, clientId, domainId);
}

export async function deleteDomain(db: Database, clientId: string, domainId: string) {
  await getDomainById(db, clientId, domainId);
  await db.delete(domains).where(eq(domains.id, domainId));
}
