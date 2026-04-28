import { eq, like, and, sql, desc, asc, lt, gt } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import { clients, domains, deployments, cronJobs, users, hostingPlans, clusterNodes } from '../../db/schema.js';
import { clientNotFound } from '../../shared/errors.js';
import { ApiError } from '../../shared/errors.js';
import { encodeCursor, decodeCursor } from '../../shared/pagination.js';
import type { Database } from '../../db/index.js';
import type { CreateClientInput, UpdateClientInput } from './schema.js';
import type { PaginationMeta } from '../../shared/response.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

function generateNamespace(companyName: string): string {
  return `client-${companyName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 50)}-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * M5: validate that a worker pin request references a real,
 * tenant-capable node. Used by both createClient and updateClient to
 * match the safety already enforced by the tenant-migration
 * endpoint. Returns the value unchanged on success; throws
 * INVALID_FIELD_VALUE otherwise. null / undefined pass through
 * untouched (means "default scheduler").
 */
async function validateWorkerPin(db: Database, value: string | null | undefined): Promise<string | null | undefined> {
  if (value == null || value === '') return value;
  const [node] = await db.select().from(clusterNodes).where(eq(clusterNodes.name, value)).limit(1);
  if (!node) {
    throw new ApiError('INVALID_FIELD_VALUE', `Unknown worker node '${value}'`, 400, { field: 'worker_node_name' });
  }
  if (!node.canHostClientWorkloads) {
    throw new ApiError(
      'INVALID_FIELD_VALUE',
      `Node '${value}' does not host client workloads (canHostClientWorkloads=false)`,
      400,
      { field: 'worker_node_name' },
    );
  }
  return value;
}

export async function createClient(db: Database, input: CreateClientInput, createdBy: string) {
  const id = crypto.randomUUID();
  const namespace = generateNamespace(input.company_name);

  // Validate worker pin early so the error surfaces before we touch
  // k8s or write the client row.
  await validateWorkerPin(db, input.worker_node_name);

  // Resolve the default timezone: explicit input wins, otherwise fall back
  // to the platform default configured in System Settings. Lazy import to
  // avoid a circular dep with system-settings/service.
  let timezone: string | null = input.timezone ?? null;
  if (!timezone) {
    try {
      const { getSettings } = await import('../system-settings/service.js');
      const settings = await getSettings(db);
      timezone = settings.timezone ?? 'UTC';
    } catch {
      timezone = 'UTC';
    }
  }

  await db.insert(clients).values({
    id,
    regionId: input.region_id,
    companyName: input.company_name,
    companyEmail: input.company_email,
    contactEmail: input.contact_email ?? null,
    status: 'pending',
    kubernetesNamespace: namespace,
    planId: input.plan_id,
    createdBy,
    timezone,
    // M5: optional worker pin. When unset, the scheduler picks at
    // first-deploy time; admins can still re-assign later via PATCH.
    workerNodeName: input.worker_node_name ?? null,
    // M7: default storage tier is 'local' (cheap, 1 replica). Admin
    // can flip to 'ha' at create or later; flipping after provisioning
    // only changes the intent — the PVC keeps its original SC until
    // a storage-migration flow moves the data (future work).
    storageTier: input.storage_tier ?? 'local',
    subscriptionExpiresAt: input.subscription_expires_at ? new Date(input.subscription_expires_at) : null,
  });

  const [created] = await db.select().from(clients).where(eq(clients.id, id));

  // Auto-create client_admin user with generated password
  const generatedPassword = generateStrongPassword();
  const passwordHash = await bcrypt.hash(generatedPassword, 12);
  const clientUserId = crypto.randomUUID();

  await db.insert(users).values({
    id: clientUserId,
    email: input.company_email,
    passwordHash,
    fullName: input.company_name,
    roleName: 'client_admin',
    panel: 'client',
    clientId: id,
    status: 'active',
    emailVerifiedAt: new Date(),
  }).onConflictDoUpdate({ target: users.email, set: { clientId: sql`excluded.client_id` } });

  return { ...created, _generatedPassword: generatedPassword, _clientUserId: clientUserId };
}

function generateStrongPassword(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%&*';
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

export async function getClientById(db: Database, id: string) {
  const [client] = await db.select().from(clients).where(eq(clients.id, id));
  if (!client) throw clientNotFound(id);
  return client;
}

/**
 * Surface PVC node placement for the Storage Lifecycle card. Walks
 * the client's PVCs, joins each to its Longhorn Volume CR, then to
 * the running replicas. Returns one row per PVC with the list of
 * node IDs hosting a healthy replica.
 *
 * Best-effort: a missing Longhorn CRD (dev cluster) or transient
 * API blip yields an empty replicas list rather than failing the
 * whole request — the UI shows "—" in that case.
 */
export async function getClientStoragePlacement(
  db: Database,
  id: string,
  k8s: K8sClients,
): Promise<{
  pvcs: Array<{
    namespace: string;
    pvcName: string;
    volumeName: string;
    sizeBytes: number;
    /** Filesystem-level usage from kubelet stats/summary — real user-data
     *  bytes ignoring ext4 metadata + Longhorn block overhead. 0 if no
     *  pod currently mounts the PVC (no kubelet to report it). */
    usedBytes: number;
    /** Longhorn Volume.status.actualSize — block-level allocation
     *  including ~230 MiB of ext4 reserved blocks on a 10 GiB volume. */
    allocatedBytes: number;
    state: string | null;
    robustness: string | null;
    replicaNodes: string[];
  }>;
}> {
  const [client] = await db.select().from(clients).where(eq(clients.id, id));
  if (!client) throw clientNotFound(id);
  if (!client.kubernetesNamespace) {
    return { pvcs: [] };
  }

  const namespace = client.kubernetesNamespace;
  const pvcsResp = await k8s.core.listNamespacedPersistentVolumeClaim({ namespace })
    .catch(() => ({ items: [] as Array<{ metadata?: { name?: string }; spec?: { volumeName?: string } }> }));

  // Group running replicas by volume name, single LIST cluster-wide.
  const replicaNodesByVolume = new Map<string, string[]>();
  let volumeIndex: Map<string, { state: string | null; robustness: string | null; sizeBytes: number; allocatedBytes: number }> = new Map();
  try {
    interface LhReplica {
      spec?: { volumeName?: string; nodeID?: string };
      status?: { currentState?: string };
    }
    interface LhVolume {
      metadata?: { name?: string };
      spec?: { size?: string };
      status?: { state?: string; robustness?: string; actualSize?: string | number };
    }
    const [reps, vols] = await Promise.all([
      k8s.custom.listNamespacedCustomObject({
        group: 'longhorn.io', version: 'v1beta2',
        namespace: 'longhorn-system', plural: 'replicas',
      } as unknown as Parameters<typeof k8s.custom.listNamespacedCustomObject>[0]) as Promise<{ items?: LhReplica[] }>,
      k8s.custom.listNamespacedCustomObject({
        group: 'longhorn.io', version: 'v1beta2',
        namespace: 'longhorn-system', plural: 'volumes',
      } as unknown as Parameters<typeof k8s.custom.listNamespacedCustomObject>[0]) as Promise<{ items?: LhVolume[] }>,
    ]);
    for (const r of reps.items ?? []) {
      if (r.status?.currentState !== 'running') continue;
      const v = r.spec?.volumeName;
      const n = r.spec?.nodeID;
      if (!v || !n) continue;
      const arr = replicaNodesByVolume.get(v) ?? [];
      arr.push(n);
      replicaNodesByVolume.set(v, arr);
    }
    volumeIndex = new Map((vols.items ?? []).map((v) => [
      v.metadata?.name ?? '',
      {
        state: v.status?.state ?? null,
        robustness: v.status?.robustness ?? null,
        sizeBytes: Number(v.spec?.size ?? '0') || 0,
        // Block-level allocation including ext4 reserved blocks +
        // Longhorn snapshot blocks. Empty 10 GiB volumes report
        // ~230 MiB. Fresh detached volumes report 0.
        allocatedBytes: Number(v.status?.actualSize ?? '0') || 0,
      },
    ]));
  } catch (err) {
    console.warn('[clients/storage-placement] longhorn list failed:', (err as Error).message);
  }

  // Filesystem-level usage from kubelet stats/summary. The Longhorn
  // actualSize includes ext4 metadata + reserved blocks (~230 MiB on
  // a 10 GiB empty PVC); the operator wants to see the user-file size,
  // which only kubelet reports. Walk pods in this namespace, map each
  // to its node, hit /api/v1/nodes/{node}/proxy/stats/summary once per
  // node, and pull usedBytes from the matching pvcRef entry.
  const usedBytesByPvc = new Map<string, number>();
  try {
    const podsResp = await k8s.core.listNamespacedPod({ namespace })
      .catch(() => ({ items: [] as Array<{ spec?: { nodeName?: string } }> }));
    const nodes = new Set<string>();
    for (const p of (podsResp.items ?? [])) {
      const n = (p as { spec?: { nodeName?: string } }).spec?.nodeName;
      if (n) nodes.add(n);
    }
    if (nodes.size > 0) {
      const k8sNode = await import('@kubernetes/client-node');
      const kc = new k8sNode.KubeConfig();
      kc.loadFromCluster();
      const cluster = kc.getCurrentCluster();
      if (cluster) {
        const httpsOpts = {} as { ca?: string; cert?: string; key?: string; headers?: Record<string, string> };
        await kc.applyToHTTPSOptions(httpsOpts);
        interface KubeletVolume { name?: string; usedBytes?: number; pvcRef?: { name?: string; namespace?: string } }
        interface KubeletPod { volume?: KubeletVolume[] }
        interface KubeletSummary { pods?: KubeletPod[] }
        await Promise.all(Array.from(nodes).map(async (node) => {
          try {
            const url = `${cluster.server}/api/v1/nodes/${encodeURIComponent(node)}/proxy/stats/summary`;
            const ca = httpsOpts.ca, cert = httpsOpts.cert, key = httpsOpts.key;
            const { Agent } = await import('https');
            const agent = new Agent({ ca, cert, key });
            const resp = await fetch(url, {
              headers: httpsOpts.headers ?? {},
              // @ts-expect-error node fetch supports agent
              agent,
            });
            if (!resp.ok) return;
            const summary = await resp.json() as KubeletSummary;
            for (const p of summary.pods ?? []) {
              for (const v of p.volume ?? []) {
                if (v.pvcRef?.namespace === namespace && v.pvcRef.name && typeof v.usedBytes === 'number') {
                  // Multiple pods may mount the same RWO PVC; usedBytes
                  // is the same filesystem reading. Last write wins.
                  usedBytesByPvc.set(v.pvcRef.name, v.usedBytes);
                }
              }
            }
          } catch {
            // Best-effort. Falls back to 0 if kubelet proxy is unreachable.
          }
        }));
      }
    }
  } catch (err) {
    console.warn('[clients/storage-placement] kubelet stats failed:', (err as Error).message);
  }

  const pvcs: Array<{
    namespace: string; pvcName: string; volumeName: string;
    sizeBytes: number; usedBytes: number; allocatedBytes: number;
    state: string | null; robustness: string | null;
    replicaNodes: string[];
  }> = [];
  for (const pvc of (pvcsResp.items ?? [])) {
    const pvcName = pvc.metadata?.name ?? '';
    const volumeName = pvc.spec?.volumeName ?? '';
    if (!volumeName) continue;
    const meta = volumeIndex.get(volumeName);
    pvcs.push({
      namespace,
      pvcName,
      volumeName,
      sizeBytes: meta?.sizeBytes ?? 0,
      usedBytes: usedBytesByPvc.get(pvcName) ?? 0,
      allocatedBytes: meta?.allocatedBytes ?? 0,
      state: meta?.state ?? null,
      robustness: meta?.robustness ?? null,
      replicaNodes: (replicaNodesByVolume.get(volumeName) ?? []).slice().sort(),
    });
  }
  return { pvcs };
}

async function getPlanStorageGi(db: Database, planId: string): Promise<number> {
  const [plan] = await db.select({ storageLimit: hostingPlans.storageLimit })
    .from(hostingPlans).where(eq(hostingPlans.id, planId));
  return Number(plan?.storageLimit ?? 10);
}

export async function listClients(
  db: Database,
  params: { limit: number; cursor?: string; sort: { field: string; direction: 'asc' | 'desc' }; search?: string },
): Promise<{ data: typeof clients.$inferSelect[]; pagination: PaginationMeta }> {
  const { limit, cursor, sort, search } = params;

  const conditions = [];
  if (search) {
    const escaped = search.replace(/%/g, '\\%').replace(/_/g, '\\_');
    conditions.push(like(clients.companyName, `%${escaped}%`));
  }

  if (cursor) {
    const decoded = decodeCursor(cursor);
    const sortCol = clients.createdAt; // Default sort column
    conditions.push(
      sort.direction === 'desc' ? lt(sortCol, new Date(decoded.sort)) : gt(sortCol, new Date(decoded.sort)),
    );
  }

  const orderBy = sort.direction === 'desc' ? desc(clients.createdAt) : asc(clients.createdAt);
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select()
    .from(clients)
    .where(where)
    .orderBy(orderBy)
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const data = rows.slice(0, limit);

  let nextCursor: string | null = null;
  if (hasMore && data.length > 0) {
    const last = data[data.length - 1];
    nextCursor = encodeCursor({
      resource: 'client',
      sort: last.createdAt.toISOString(),
      id: last.id,
    });
  }

  const [countResult] = await db.select({ count: sql<number>`count(*)` }).from(clients).where(where);

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

export async function updateClient(db: Database, id: string, input: UpdateClientInput) {
  const existing = await getClientById(db, id); // throws if not found

  // Storage safety: refuse to shrink `storage_limit_override` (or
  // switch to a plan with smaller storage) through the plain update
  // endpoint — a shrink requires `POST /storage/resize` which
  // orchestrates quiesce → snapshot → PVC delete → recreate →
  // restore. Silently writing a smaller quota row would leave the
  // DB and the real PVC inconsistent.
  //
  // Comparison is done in MiB (not GiB) so decimal-GiB overrides
  // (e.g. "2.44" for a 2500 MiB resize) don't silently round to the
  // plan's integer-GiB value and let a shrink slip through.
  const newOverride = input.storage_limit_override;
  const newPlanId = input.plan_id;
  if (newOverride !== undefined || (newPlanId !== undefined && newPlanId !== existing.planId)) {
    const toMib = (gi: number) => Math.round(gi * 1024);
    const currentMib = existing.storageLimitOverride != null
      ? toMib(Number(existing.storageLimitOverride))
      : toMib(await getPlanStorageGi(db, existing.planId));

    let targetMib: number;
    if (newOverride === null) {
      // Override cleared — inherit from (possibly new) plan.
      const effectivePlanId = newPlanId ?? existing.planId;
      targetMib = toMib(await getPlanStorageGi(db, effectivePlanId));
    } else if (newOverride !== undefined) {
      targetMib = toMib(Number(newOverride));
    } else {
      // plan_id changed, override unchanged.
      targetMib = existing.storageLimitOverride != null
        ? toMib(Number(existing.storageLimitOverride))
        : toMib(await getPlanStorageGi(db, newPlanId!));
    }

    if (targetMib < currentMib) {
      const { ApiError } = await import('../../shared/errors.js');
      throw new ApiError(
        'STORAGE_RESIZE_REQUIRED',
        `Shrinking storage from ${currentMib} MiB to ${targetMib} MiB requires a resize operation (POST /api/v1/admin/clients/${id}/storage/resize)`,
        409,
        {
          currentMib,
          targetMib,
          currentGi: Math.round(currentMib / 102.4) / 10,
          targetGi: Math.round(targetMib / 102.4) / 10,
          remediation: 'Use the Resize Storage modal on the client detail page',
        },
      );
    }
  }

  const updateValues: Record<string, unknown> = {};
  if (input.company_name !== undefined) updateValues.companyName = input.company_name;
  if (input.company_email !== undefined) updateValues.companyEmail = input.company_email;
  if (input.contact_email !== undefined) updateValues.contactEmail = input.contact_email;
  if (input.status !== undefined) updateValues.status = input.status;
  if (input.plan_id !== undefined) updateValues.planId = input.plan_id;
  if (input.subscription_expires_at !== undefined) {
    updateValues.subscriptionExpiresAt = input.subscription_expires_at
      ? new Date(input.subscription_expires_at)
      : null;
  }
  if (input.cpu_limit_override !== undefined) updateValues.cpuLimitOverride = input.cpu_limit_override === null ? null : String(input.cpu_limit_override);
  if (input.memory_limit_override !== undefined) updateValues.memoryLimitOverride = input.memory_limit_override === null ? null : String(input.memory_limit_override);
  if (input.storage_limit_override !== undefined) updateValues.storageLimitOverride = input.storage_limit_override === null ? null : String(input.storage_limit_override);
  if (input.max_sub_users_override !== undefined) updateValues.maxSubUsersOverride = input.max_sub_users_override;
  if (input.max_mailboxes_override !== undefined) updateValues.maxMailboxesOverride = input.max_mailboxes_override;
  if (input.monthly_price_override !== undefined) updateValues.monthlyPriceOverride = input.monthly_price_override === null ? null : String(input.monthly_price_override);
  if (input.email_send_rate_limit !== undefined) updateValues.emailSendRateLimit = input.email_send_rate_limit;
  // M5: re-pin a client to a different worker. M3 plumbing makes the
  // next deploy apply the pin; existing pods keep running on their
  // current node until a migration (M6) or scheduler-triggered
  // eviction moves them.
  if (input.worker_node_name !== undefined) {
    await validateWorkerPin(db, input.worker_node_name);
    updateValues.workerNodeName = input.worker_node_name;
  }
  // Storage tier flip is LIVE — pre-write the new tier here so the DB
  // stays the durable record even if the cluster sync below has a
  // transient hiccup. applyTenantTier still needs to know the OLD tier
  // to skip work on a no-op flip; we capture it BEFORE adding tier to
  // updateValues. A previous version let applyTenantTier own the write,
  // but its early CLIENT_NOT_PROVISIONED throw on a partial-state row
  // got swallowed and the operator's intent was silently lost.
  const tierChange: 'local' | 'ha' | undefined = input.storage_tier as 'local' | 'ha' | undefined;
  let previousTier: 'local' | 'ha' = 'local';
  if (tierChange !== undefined) {
    const [row] = await db.select({ storageTier: clients.storageTier })
      .from(clients).where(eq(clients.id, id)).limit(1);
    previousTier = ((row?.storageTier ?? 'local') as 'local' | 'ha');
    updateValues.storageTier = tierChange;
  }

  if (Object.keys(updateValues).length > 0) {
    await db.update(clients).set(updateValues).where(eq(clients.id, id));
  }

  // Live cluster sync of the tier flip. If the namespace isn't ready
  // yet (CLIENT_NOT_PROVISIONED) we still keep the DB write — the
  // platform-storage-policy reconciler picks up the new tier on the
  // next pass. For other failures (Longhorn API down) we surface the
  // error to the operator instead of swallowing it: the DB now says
  // "ha" but the cluster might be on "local", and silently lying about
  // success is what burned us in the first place.
  if (tierChange !== undefined && tierChange !== previousTier) {
    try {
      const { createK8sClients } = await import('../k8s-provisioner/k8s-client.js');
      const { applyTenantTier } = await import('./storage-placement-service.js');
      const k8s = createK8sClients(process.env.KUBECONFIG_PATH);
      await applyTenantTier(db, k8s, id, previousTier, tierChange);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'CLIENT_NOT_PROVISIONED') {
        // Acceptable: namespace not ready yet, reconciler will catch up.
        console.warn(`[clients.updateClient] tier flip queued — ${(err as Error).message}`);
      } else {
        // Re-throw so the route returns a real error envelope.
        throw err;
      }
    }
  }

  // Sync K8s ResourceQuota when resource limits change
  if (input.cpu_limit_override !== undefined || input.memory_limit_override !== undefined || input.storage_limit_override !== undefined || input.plan_id !== undefined) {
    try {
      const { createK8sClients } = await import('../k8s-provisioner/k8s-client.js');
      const { applyResourceQuota } = await import('../k8s-provisioner/service.js');
      const updatedClient = await getClientById(db, id);
      const [plan] = await db.select().from(hostingPlans).where(eq(hostingPlans.id, updatedClient.planId));
      const k8s = createK8sClients(process.env.KUBECONFIG_PATH);
      await applyResourceQuota(k8s, updatedClient.kubernetesNamespace, {
        cpu: String(updatedClient.cpuLimitOverride ?? plan?.cpuLimit ?? 2),
        memory: String(updatedClient.memoryLimitOverride ?? plan?.memoryLimit ?? 4),
        storage: String(updatedClient.storageLimitOverride ?? plan?.storageLimit ?? 50),
      });
    } catch (err) {
      console.warn('[clients] Failed to sync K8s ResourceQuota:', err instanceof Error ? err.message : String(err));
    }
  }

  // Cascade status change through the unified client-lifecycle module
  // so suspend / reactivate go through the same path as the subscription
  // expiry cron and storage-lifecycle ops. Includes ingress swap,
  // mailbox disable, etc.
  if (input.status === 'suspended' || input.status === 'active') {
    try {
      const { applySuspended, applyActive } = await import('../client-lifecycle/cascades.js');
      const { createK8sClients } = await import('../k8s-provisioner/k8s-client.js');
      const client = await getClientById(db, id);
      const k8s = createK8sClients(process.env.KUBECONFIG_PATH);
      const ctx = { db, k8s };
      if (input.status === 'suspended') {
        await applySuspended(ctx, id, client.kubernetesNamespace);
      } else {
        await applyActive(ctx, id, client.kubernetesNamespace);
      }
    } catch (err) {
      console.warn('[clients] Lifecycle cascade failed:', err instanceof Error ? err.message : String(err));
    }
  }

  // Phase 3.B.3: reconcile Stalwart outbound config when:
  //   - client status changed (suspend → rate=0 in throttle)
  //   - email send rate limit changed
  // Non-blocking — throttle reconcile failures shouldn't fail the
  // client update API call.
  if (input.status !== undefined || input.email_send_rate_limit !== undefined) {
    try {
      const { reconcileOutboundConfig } = await import('../email-outbound/service.js');
      const { createK8sClients } = await import('../k8s-provisioner/k8s-client.js');
      const k8s = createK8sClients(process.env.KUBECONFIG_PATH);
      await reconcileOutboundConfig(db, k8s);
    } catch (err) {
      console.warn('[clients] Failed to reconcile outbound config after status/rate change:', err instanceof Error ? err.message : String(err));
    }
  }

  return getClientById(db, id);
}

export async function deleteClient(db: Database, id: string, k8sClients?: K8sClients) {
  const client = await getClientById(db, id);

  // Unified hard-delete cascade via client-lifecycle/cascades.ts —
  // namespace delete + DB row cascade in one function. Falls through
  // to a DB-only delete when k8s isn't available (unit tests).
  if (k8sClients) {
    const { applyDeleted } = await import('../client-lifecycle/cascades.js');
    await applyDeleted({ db, k8s: k8sClients }, id, client.kubernetesNamespace);

    // Also purge snapshot-store archives for this client so we don't
    // leak data after a hard delete. Best-effort; snapshots for
    // already-deleted clients are reaped by the housekeeping cron
    // anyway.
    try {
      const { resolveSnapshotStore } = await import('../storage-lifecycle/snapshot-store.js');
      const { storageSnapshots } = await import('../../db/schema.js');
      const snaps = await db
        .select({ archivePath: storageSnapshots.archivePath })
        .from(storageSnapshots)
        .where(eq(storageSnapshots.clientId, id));
      if (snaps.length > 0) {
        const store = await resolveSnapshotStore(db, process.env as Record<string, unknown>);
        for (const s of snaps) {
          await store.delete(s.archivePath).catch(() => {});
        }
      }
    } catch (err) {
      console.warn(`[client-delete] snapshot purge failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  // k8s not available (unit test path): delete DB row directly.
  await db.delete(clients).where(eq(clients.id, id));
}
