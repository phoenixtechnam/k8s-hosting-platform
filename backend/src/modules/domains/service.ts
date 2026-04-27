import { eq, and, like, desc, asc, lt, gt, sql, inArray } from 'drizzle-orm';
import { domains, dnsRecords, emailDomains, mailboxes, emailAliases, ingressRoutes, sslCertificates } from '../../db/schema.js';
import { domainNotFound, duplicateEntry } from '../../shared/errors.js';
import { ApiError } from '../../shared/errors.js';
import { encodeCursor, decodeCursor } from '../../shared/pagination.js';
import { getClientById } from '../clients/service.js';
import { getActiveServersForDomain, getProviderForServer, getDefaultGroup, getPrimaryServersForGroup, getActiveServers, getProviderGroupById } from '../dns-servers/service.js';
import { reconcileIngress } from './k8s-ingress.js';
import { deleteDomainCertificate, ensureDomainCertificate } from '../certificates/service.js';
import { createRoute } from '../ingress-routes/service.js';
import { removeWebmailIngress } from '../email-domains/service.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { Database } from '../../db/index.js';
import type { CreateDomainInput, UpdateDomainInput } from './schema.js';
import type { PaginationMeta } from '../../shared/response.js';

const EXPIRING_THRESHOLD_DAYS = 30;

/** Enrich domain rows with TLS cert summary from ssl_certificates. */
async function enrichWithCertInfo(
  db: Database,
  rows: (typeof domains.$inferSelect)[],
): Promise<(typeof domains.$inferSelect & {
  tlsCertStatus: 'active' | 'expiring' | 'expired' | 'pending' | 'none';
  tlsCertIssuer: string | null;
  tlsCertExpiresAt: string | null;
  tlsCertWildcard: boolean;
})[]> {
  if (rows.length === 0) return [];
  const domainIds = rows.map((r) => r.id);
  const certs = await db
    .select({
      domainId: sslCertificates.domainId,
      issuer: sslCertificates.issuer,
      subject: sslCertificates.subject,
      expiresAt: sslCertificates.expiresAt,
    })
    .from(sslCertificates)
    .where(inArray(sslCertificates.domainId, domainIds));

  const certMap = new Map(certs.map((c) => [c.domainId, c]));
  const now = new Date();
  const expiringThreshold = new Date(now.getTime() + EXPIRING_THRESHOLD_DAYS * 24 * 60 * 60 * 1000);

  return rows.map((row) => {
    const cert = certMap.get(row.id);
    if (!cert) {
      return {
        ...row,
        tlsCertStatus: row.sslAutoRenew ? 'pending' as const : 'none' as const,
        tlsCertIssuer: null,
        tlsCertExpiresAt: null,
        tlsCertWildcard: false,
      };
    }
    const expired = cert.expiresAt ? cert.expiresAt < now : false;
    const expiring = cert.expiresAt ? !expired && cert.expiresAt < expiringThreshold : false;
    const isWildcard = cert.subject ? cert.subject.startsWith('*.') : false;
    return {
      ...row,
      tlsCertStatus: (expired ? 'expired' : expiring ? 'expiring' : 'active') as 'active' | 'expiring' | 'expired',
      tlsCertIssuer: cert.issuer ?? null,
      tlsCertExpiresAt: cert.expiresAt ? cert.expiresAt.toISOString() : null,
      tlsCertWildcard: isWildcard,
    };
  });
}
import type { DomainDeletePreview } from '@k8s-hosting/api-contracts';

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

    // Replace auto-created NS records with group's configured nameservers
    if (dnsGroupId) {
      const group = await getProviderGroupById(db, dnsGroupId);
      if (group.nsHostnames && group.nsHostnames.length > 0) {
        for (const server of activeServers) {
          try {
            const provider = getProviderForServer(server, encryptionKey);
            if (provider.replaceNsRecords) {
              await provider.replaceNsRecords(input.domain_name, group.nsHostnames);
            }
          } catch (err) {
            console.warn(`[dns] Failed to set NS records on ${server.displayName}:`, err instanceof Error ? err.message : String(err));
          }
        }
      }
    }

    // Pull all records from DNS server into local DB (captures SOA, NS, etc.)
    if (created) {
      try {
        const { syncRecordsFromProvider } = await import('../dns-records/service.js');
        await syncRecordsFromProvider(db, clientId, created.id);
      } catch {
        // Non-blocking — records can be synced later via Sync Records
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
      } catch (err) {
        // Ingress reconciliation failure shouldn't block domain creation
        // BUT must be logged — silent swallowing was the root cause of
        // "domain shows OK in API but Ingress missing in K8s" bugs that
        // had operators add domains via UI and hit 404 + fake cert.
        console.warn(`[domains.createDomain] reconcileIngress failed for ${client.kubernetesNamespace} (domain=${input.domain_name}): ${(err as Error).message}`);
      }
    }
  }

  // Auto-provision TLS certificate via cert-manager
  if (k8s) {
    try {
      await ensureDomainCertificate(db, k8s, id);
    } catch (err) {
      // Non-blocking — cert can be provisioned later via reconciler
      console.warn(`[domains.createDomain] ensureDomainCertificate failed for ${input.domain_name}: ${(err as Error).message}`);
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

  const enriched = await enrichWithCertInfo(db, data);
  return {
    data: enriched,
    pagination: {
      cursor: nextCursor,
      has_more: hasMore,
      page_size: enriched.length,
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

  const enriched = await enrichWithCertInfo(db, data);
  return {
    data: enriched,
    pagination: {
      cursor: nextCursor,
      has_more: hasMore,
      page_size: enriched.length,
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
      } catch (err) {
        console.warn(`[domains.updateDomain] reconcileIngress failed for ${client.kubernetesNamespace}: ${(err as Error).message}`);
      }
    }
  }

  // Phase 2c: if dnsMode changed, the cert strategy may have changed
  // too (e.g. primary → cname flips a wildcard DNS-01 cert back to a
  // per-hostname HTTP-01 cert). Re-run the domain cert ensurer so the
  // new issuer is picked up on the next reconcile.
  if (k8s && input.dns_mode !== undefined) {
    try {
      await ensureDomainCertificate(db, k8s, domainId);
    } catch (err) {
      console.warn(`[domains.updateDomain] ensureDomainCertificate failed: ${(err as Error).message}`);
    }
  }

  return getDomainById(db, clientId, domainId);
}

export interface DeleteDomainResult {
  readonly deleted: {
    readonly emailDomains: number;
    readonly mailboxes: number;
    readonly aliases: number;
    readonly dnsRecords: number;
    readonly ingressRoutes: number;
  };
}

export async function deleteDomain(
  db: Database,
  clientId: string,
  domainId: string,
  k8s?: K8sClients,
): Promise<DeleteDomainResult> {
  const domainRow = await getDomainById(db, clientId, domainId);

  // Resolve DNS servers BEFORE deleting the domain (need dnsGroupId which is on the domain row)
  const encryptionKey = process.env.OIDC_ENCRYPTION_KEY ?? '0'.repeat(64);
  let dnsServersToClean: Awaited<ReturnType<typeof getActiveServersForDomain>> = [];
  try {
    dnsServersToClean = await getActiveServersForDomain(db, domainId);
  } catch { /* no servers */ }

  // Phase 3 round-3: capture cascade counts BEFORE the delete so we
  // can return them to the caller for audit logging and UI feedback.
  // The FK cascades from migration 0020 handle the actual row removal
  // atomically when we delete the domains row below.
  const edRows = await db
    .select({ id: emailDomains.id })
    .from(emailDomains)
    .where(eq(emailDomains.domainId, domainId));
  const edIds = edRows.map((r) => r.id);

  const mailboxCount = edIds.length > 0
    ? Number(
      (await db
        .select({ count: sql<number>`count(*)` })
        .from(mailboxes)
        .where(inArray(mailboxes.emailDomainId, edIds)))[0]?.count ?? 0,
    )
    : 0;
  const aliasCount = edIds.length > 0
    ? Number(
      (await db
        .select({ count: sql<number>`count(*)` })
        .from(emailAliases)
        .where(inArray(emailAliases.emailDomainId, edIds)))[0]?.count ?? 0,
    )
    : 0;
  const dnsRecordCount = Number(
    (await db
      .select({ count: sql<number>`count(*)` })
      .from(dnsRecords)
      .where(eq(dnsRecords.domainId, domainId)))[0]?.count ?? 0,
  );
  const ingressRouteCount = Number(
    (await db
      .select({ count: sql<number>`count(*)` })
      .from(ingressRoutes)
      .where(eq(ingressRoutes.domainId, domainId)))[0]?.count ?? 0,
  );

  // Phase 3 round-3: tear down the per-email-domain webmail Ingress
  // for every email_domains row BEFORE the FK cascade nukes the DB
  // row. removeWebmailIngress reads the DB to resolve the hostname
  // and namespace, so it must run while the rows still exist.
  if (k8s) {
    for (const edId of edIds) {
      try {
        await removeWebmailIngress(db, k8s, edId);
      } catch (err) {
        console.warn(
          `[domains] removeWebmailIngress failed for ${edId}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  // Phase 2c: delete TLS cert before the domain row — deleteDomainCertificate
  // reads the domain to resolve the client namespace and cert name.
  if (k8s) {
    try {
      await deleteDomainCertificate(db, k8s, domainId);
    } catch {
      // Non-blocking — logged inside the cert module
    }
  }

  // Delete domain from DB. Migration 0020 added ON DELETE CASCADE for
  // email_domains, mailboxes, email_aliases, dns_records, and
  // ingress_routes → domains, so all child rows disappear atomically.
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

  return {
    deleted: {
      emailDomains: edIds.length,
      mailboxes: mailboxCount,
      aliases: aliasCount,
      dnsRecords: dnsRecordCount,
      ingressRoutes: ingressRouteCount,
    },
  };
}

// Phase 3 round-3: dynamic delete preview. Returns the exact set of
// resources that deleteDomain would remove, with enough detail for
// the UI to list each one by name. Pure read — no side effects.
// Review HIGH-3: the DomainDeletePreview type is the single source of
// truth in @k8s-hosting/api-contracts; see packages/api-contracts/src/domains.ts.
export async function getDomainDeletePreview(
  db: Database,
  clientId: string,
  domainId: string,
): Promise<DomainDeletePreview> {
  const domainRow = await getDomainById(db, clientId, domainId);

  // DNS records for this domain
  const dnsRecordRows = await db
    .select({
      id: dnsRecords.id,
      type: dnsRecords.recordType,
      name: dnsRecords.recordName,
    })
    .from(dnsRecords)
    .where(eq(dnsRecords.domainId, domainId));

  // Email domain (0 or 1 due to unique index on domainId)
  const [edRow] = await db
    .select({
      id: emailDomains.id,
      webmailEnabled: emailDomains.webmailEnabled,
    })
    .from(emailDomains)
    .where(eq(emailDomains.domainId, domainId));

  let emailDomainInfo: DomainDeletePreview['emailDomain'] = null;
  if (edRow) {
    const mailboxRows = await db
      .select({ id: mailboxes.id, fullAddress: mailboxes.fullAddress })
      .from(mailboxes)
      .where(eq(mailboxes.emailDomainId, edRow.id));
    const aliasRows = await db
      .select({ id: emailAliases.id, sourceAddress: emailAliases.sourceAddress })
      .from(emailAliases)
      .where(eq(emailAliases.emailDomainId, edRow.id));
    emailDomainInfo = {
      id: edRow.id,
      webmailEnabled: Boolean(edRow.webmailEnabled),
      mailboxes: mailboxRows,
      aliases: aliasRows,
    };
  }

  // Ingress routes for this domain
  const routeRows = await db
    .select({ id: ingressRoutes.id, hostname: ingressRoutes.hostname })
    .from(ingressRoutes)
    .where(eq(ingressRoutes.domainId, domainId));

  const webmailIngressHostname = emailDomainInfo && emailDomainInfo.webmailEnabled
    ? `webmail.${domainRow.domainName}`
    : null;

  return {
    domainName: domainRow.domainName,
    dnsRecords: dnsRecordRows,
    emailDomain: emailDomainInfo,
    ingressRoutes: routeRows,
    webmailIngressHostname,
  };
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
    const synced = await db.select().from(dnsRecords).where(eq(dnsRecords.domainId, domainId));
    console.log(`[dns-migrate] Synced ${synced.length} records from source provider for ${domainRow.domainName}`);
  } catch (err) {
    console.warn(`[dns-migrate] Failed to sync from source provider:`, err instanceof Error ? err.message : String(err));
  }

  // Get current records (now includes synced NS/SOA from provider)
  const records = await db.select().from(dnsRecords).where(eq(dnsRecords.domainId, domainId));
  console.log(`[dns-migrate] ${records.length} records to push to target for ${domainRow.domainName}`);

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

  // Replace auto-created NS records with target group's configured nameservers
  const targetGroup = await getProviderGroupById(db, targetGroupId);
  if (targetGroup.nsHostnames && targetGroup.nsHostnames.length > 0) {
    for (const server of targetServers) {
      try {
        const provider = getProviderForServer(server, encryptionKey);
        if (provider.replaceNsRecords) {
          await provider.replaceNsRecords(domainRow.domainName, targetGroup.nsHostnames);
        }
      } catch (err) {
        console.warn(`[dns-migrate] Failed to set NS records on ${server.displayName}:`, err instanceof Error ? err.message : String(err));
      }
    }
  }

  // Step 2: Sync all records to target group — track failures
  let pushFailures = 0;
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
      } catch (err) {
        pushFailures++;
        console.warn(`[dns-migrate] Failed to push ${record.recordType} ${record.recordName} to ${server.displayName}:`, err instanceof Error ? err.message : String(err));
      }
    }
  }

  // If ALL record pushes failed, abort — don't delete the old zone
  if (records.length > 0 && pushFailures === records.length * targetServers.length) {
    throw new ApiError('MIGRATION_FAILED', `Migration aborted: all ${pushFailures} record pushes to the target group failed. The old zone has been preserved. Check that the target group has a working DNS server.`, 500);
  }

  // Step 3: Update domain.dnsGroupId
  await db.update(domains).set({ dnsGroupId: targetGroupId }).where(eq(domains.id, domainId));
  console.log(`[dns-migrate] Updated ${domainRow.domainName} to group ${targetGroupId} (${pushFailures} push failures)`);

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
