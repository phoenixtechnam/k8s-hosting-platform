import { eq, and, like, desc, asc, lt, gt, sql } from 'drizzle-orm';
import { domains, dnsRecords } from '../../db/schema.js';
import { domainNotFound, duplicateEntry } from '../../shared/errors.js';
import { ApiError } from '../../shared/errors.js';
import { encodeCursor, decodeCursor } from '../../shared/pagination.js';
import { getClientById } from '../clients/service.js';
import { getActiveServersForDomain, getProviderForServer, getDefaultGroup, getPrimaryServersForGroup, getActiveServers, getProviderGroupById } from '../dns-servers/service.js';
import { reconcileIngress } from './k8s-ingress.js';
import { createRoute } from '../ingress-routes/service.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { Database } from '../../db/index.js';
import type { CreateDomainInput, UpdateDomainInput } from './schema.js';
import type { PaginationMeta } from '../../shared/response.js';

export async function createDomain(db: Database, clientId: string, input: CreateDomainInput & { master_ip?: string; dns_group_id?: string }, k8s?: K8sClients) {
  // Verify client exists
  await getClientById(db, clientId);

  // Secondary DNS mode requires master_ip
  if (input.dns_mode === 'secondary' && !input.master_ip) {
    throw new ApiError(
      'MISSING_REQUIRED_FIELD',
      'master_ip is required when dns_mode is secondary',
      400,
      { field: 'master_ip' },
    );
  }

  // Check for duplicate domain name
  const [existing] = await db.select().from(domains).where(eq(domains.domainName, input.domain_name));
  if (existing) {
    throw duplicateEntry('domain', input.domain_name);
  }

  // Resolve DNS group: use provided, or fall back to default
  let dnsGroupId = input.dns_group_id ?? null;
  if (!dnsGroupId) {
    const defaultGroup = await getDefaultGroup(db);
    if (defaultGroup) {
      dnsGroupId = defaultGroup.id;
    }
  }

  // Validate group exists if provided
  if (dnsGroupId) {
    await getProviderGroupById(db, dnsGroupId);
  }

  const id = crypto.randomUUID();
  await db.insert(domains).values({
    id,
    clientId,
    domainName: input.domain_name,
    dnsMode: input.dns_mode,
    masterIp: input.dns_mode === 'secondary' ? (input.master_ip ?? null) : null,
    deploymentId: input.deployment_id ?? null,
    dnsGroupId,
    status: 'pending',
  });

  const [created] = await db.select().from(domains).where(eq(domains.id, id));

  // Auto-provision DNS zone on the domain's group servers (or all active if no group)
  const encryptionKey = process.env.OIDC_ENCRYPTION_KEY ?? '0'.repeat(64) /* Dev-only fallback — production requires OIDC_ENCRYPTION_KEY env var */;
  try {
    const activeServers = await getActiveServersForDomain(db, id);
    for (const server of activeServers) {
      try {
        const provider = getProviderForServer(server, encryptionKey);
        if (input.dns_mode === 'secondary' && input.master_ip && provider.createSlaveZone) {
          await provider.createSlaveZone(input.domain_name, input.master_ip);
        } else {
          const zoneKind = (server.zoneDefaultKind as 'Native' | 'Master') ?? 'Native';
          await provider.createZone(input.domain_name, zoneKind);
        }
      } catch {
        // DNS provisioning failure shouldn't block domain creation — log and continue
      }
    }
  } catch {
    // No DNS servers configured — that's fine
  }

  // Auto-create ingress route if workload was selected
  if (input.deployment_id && created) {
    try {
      await createRoute(db, created.id, clientId, input.domain_name, input.deployment_id);
    } catch {
      // Route creation failure shouldn't block domain creation
    }
  }

  // Reconcile Ingress in k8s
  if (k8s) {
    const client = await getClientById(db, clientId);
    if (client.kubernetesNamespace) {
      try {
        await reconcileIngress(db, k8s, clientId, client.kubernetesNamespace);
      } catch {
        // Ingress reconciliation failure shouldn't block domain creation
      }
    }
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

export async function updateDomain(db: Database, clientId: string, domainId: string, input: UpdateDomainInput & { dns_group_id?: string | null }, k8s?: K8sClients) {
  await getDomainById(db, clientId, domainId);

  const updateValues: Record<string, unknown> = {};
  if (input.dns_mode !== undefined) updateValues.dnsMode = input.dns_mode;
  if (input.ssl_auto_renew !== undefined) updateValues.sslAutoRenew = input.ssl_auto_renew ? 1 : 0;
  if (input.status !== undefined) updateValues.status = input.status;
  if (input.deployment_id !== undefined) updateValues.deploymentId = input.deployment_id;
  if (input.dns_group_id !== undefined) updateValues.dnsGroupId = input.dns_group_id;

  if (Object.keys(updateValues).length > 0) {
    await db.update(domains).set(updateValues).where(eq(domains.id, domainId));
  }

  // Reconcile Ingress if workload mapping or DNS mode changed
  if (k8s && (input.deployment_id !== undefined || input.dns_mode !== undefined)) {
    const client = await getClientById(db, clientId);
    if (client.kubernetesNamespace) {
      try {
        await reconcileIngress(db, k8s, clientId, client.kubernetesNamespace);
      } catch {
        // Non-blocking
      }
    }
  }

  return getDomainById(db, clientId, domainId);
}

export async function deleteDomain(db: Database, clientId: string, domainId: string, k8s?: K8sClients) {
  const domainRow = await getDomainById(db, clientId, domainId);

  // Resolve DNS servers BEFORE deleting the domain (need dnsGroupId which is on the domain row)
  const encryptionKey = process.env.OIDC_ENCRYPTION_KEY ?? '0'.repeat(64);
  let dnsServersToClean: Awaited<ReturnType<typeof getActiveServersForDomain>> = [];
  try {
    dnsServersToClean = await getActiveServersForDomain(db, domainId);
  } catch { /* no servers */ }

  // Delete domain from DB
  await db.delete(domains).where(eq(domains.id, domainId));

  // Delete zone from DNS servers
  for (const server of dnsServersToClean) {
    try {
      const provider = getProviderForServer(server, encryptionKey);
      await provider.deleteZone(domainRow.domainName);
      console.log(`[dns] Deleted zone ${domainRow.domainName} from ${server.displayName}`);
    } catch (err) {
      console.warn(`[dns] Failed to delete zone ${domainRow.domainName} from ${server.displayName}:`, err instanceof Error ? err.message : String(err));
    }
  }

  // Reconcile Ingress after domain removal
  if (k8s) {
    const client = await getClientById(db, clientId);
    if (client.kubernetesNamespace) {
      try {
        await reconcileIngress(db, k8s, clientId, client.kubernetesNamespace);
      } catch {
        // Non-blocking
      }
    }
  }
}

/**
 * Migrate a domain's DNS from one provider group to another.
 * Flow:
 * 1. Get domain + current records from local DB
 * 2. Create zone on target group's servers
 * 3. Sync all records to target group
 * 4. Update domain.dnsGroupId
 * 5. Delete zone from old group's servers
 * 6. Return success
 */
export async function migrateDomainDns(
  db: Database,
  clientId: string,
  domainId: string,
  targetGroupId: string,
) {
  const domainRow = await getDomainById(db, clientId, domainId);
  const encryptionKey = process.env.OIDC_ENCRYPTION_KEY ?? '0'.repeat(64);

  // Validate target group exists
  await getProviderGroupById(db, targetGroupId);

  // Sync records from old provider into local DB first (captures NS, SOA, etc.)
  try {
    const { syncRecordsFromProvider } = await import('../dns-records/service.js');
    await syncRecordsFromProvider(db, clientId, domainId);
  } catch {
    // Sync may fail if old provider is down — use whatever's in the local DB
  }

  // Get current records (now includes synced NS/SOA from provider)
  const records = await db.select().from(dnsRecords).where(eq(dnsRecords.domainId, domainId));

  // Determine old group servers
  const oldGroupId = domainRow.dnsGroupId;
  const oldServers = oldGroupId
    ? await getPrimaryServersForGroup(db, oldGroupId)
    : await getActiveServers(db);

  // Get target group servers
  const targetServers = await getPrimaryServersForGroup(db, targetGroupId);
  if (targetServers.length === 0) {
    throw new ApiError('NO_TARGET_SERVERS', 'Target group has no primary servers', 400);
  }

  // Step 1: Create zone on target group's servers
  for (const server of targetServers) {
    try {
      const provider = getProviderForServer(server, encryptionKey);
      const zoneKind = (server.zoneDefaultKind as 'Native' | 'Master') ?? 'Native';
      await provider.createZone(domainRow.domainName, zoneKind);
    } catch {
      // Zone may already exist — continue
    }
  }

  // Step 2: Sync all records to target group
  for (const record of records) {
    for (const server of targetServers) {
      try {
        const provider = getProviderForServer(server, encryptionKey);
        await provider.createRecord(domainRow.domainName, {
          type: record.recordType,
          name: record.recordName ?? '@',
          content: record.recordValue ?? '',
          ttl: record.ttl ?? 3600,
          priority: record.priority ?? undefined,
        });
      } catch {
        // Record sync failure — log and continue
      }
    }
  }

  // Step 3: Update domain.dnsGroupId
  await db.update(domains).set({ dnsGroupId: targetGroupId }).where(eq(domains.id, domainId));

  // Step 4: Delete zone from old group's servers
  for (const server of oldServers) {
    try {
      const provider = getProviderForServer(server, encryptionKey);
      await provider.deleteZone(domainRow.domainName);
      console.log(`[dns-migrate] Deleted zone ${domainRow.domainName} from ${server.displayName}`);
    } catch (err) {
      console.warn(`[dns-migrate] Failed to delete zone from ${server.displayName}:`, err instanceof Error ? err.message : String(err));
    }
  }

  return getDomainById(db, clientId, domainId);
}
