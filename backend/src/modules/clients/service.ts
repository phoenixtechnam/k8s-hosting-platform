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

/** One row per PVC returned by getClientStoragePlacement. */
export interface ClientPvcPlacementRow {
  namespace: string;
  pvcName: string;
  volumeName: string;
  sizeBytes: number;
  /** Filesystem-level usage from kubelet stats/summary — real user-data
   *  bytes ignoring filesystem metadata + Longhorn block overhead. 0
   *  if no pod currently mounts the PVC (no kubelet to report it). */
  usedBytes: number;
  /** Longhorn Volume.status.actualSize — block-level allocation
   *  including ~230 MiB of ext4 reserved blocks on a 10 GiB volume,
   *  ~40 MiB on XFS. */
  allocatedBytes: number;
  /** Volume.status.state ("attached" | "detached" | "creating" | …). */
  state: string | null;
  /** Volume.status.robustness ("healthy" | "degraded" | "faulted" | …). */
  robustness: string | null;
  replicaNodes: string[];

  // ── Storage health surface (added 2026-04-28) ──
  /** Subset of Volume.status.conditions[] that the operator should
   *  care about. Each entry is a condition type with status==="True"
   *  — i.e. the abnormal/active state. Healthy steady-state volumes
   *  have nearly all conditions at False, with `Scheduled`==True
   *  being the *good* case (it just means "we found a slot for the
   *  desired replica count") so it's filtered out. */
  engineConditions: Array<{ type: string; reason: string | null; message: string | null }>;
  /** Count of replicas currently in `running` state (this is what
   *  replicaNodes already reflects — exposed as a number for symmetry). */
  replicasHealthy: number;
  /** Volume.spec.numberOfReplicas — the desired count. Diff from
   *  replicasHealthy = "still rebuilding" or "stuck pending". */
  replicasExpected: number;
  /** Volume.status.lastBackupAt — RFC3339 string from Longhorn, or
   *  null if this volume has never been backed up. */
  lastBackupAt: string | null;
  /** Filesystem type the PV was formatted with. Sourced from
   *  PV.spec.csi.volumeAttributes.fsType (Longhorn copies the
   *  StorageClass param through here). null on PVs not provisioned
   *  by Longhorn / older installs that didn't surface it. */
  fsType: string | null;
  /** Volume.status.frontend ("blockdev" when attached to a pod,
   *  empty string when detached). Distinct from `state` — frontend
   *  tells you whether a workload currently has the device open. */
  frontendState: string | null;
}

/**
 * Surface PVC node placement + health for the Storage Lifecycle card.
 * Walks the client's PVCs, joins each to its Longhorn Volume CR + PV,
 * then to the running replicas.
 *
 * Best-effort: a missing Longhorn CRD (dev cluster) or transient
 * API blip yields an empty replicas list rather than failing the
 * whole request — the UI shows "—" in that case.
 */
export async function getClientStoragePlacement(
  db: Database,
  id: string,
  k8s: K8sClients,
): Promise<{ pvcs: ClientPvcPlacementRow[] }> {
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
  interface VolumeMeta {
    state: string | null;
    robustness: string | null;
    sizeBytes: number;
    allocatedBytes: number;
    numberOfReplicas: number;
    lastBackupAt: string | null;
    frontendState: string | null;
    engineConditions: Array<{ type: string; reason: string | null; message: string | null }>;
  }
  let volumeIndex: Map<string, VolumeMeta> = new Map();
  try {
    interface LhReplica {
      spec?: { volumeName?: string; nodeID?: string };
      status?: { currentState?: string };
    }
    interface LhVolumeCondition {
      type?: string;
      status?: string;
      reason?: string;
      message?: string;
    }
    interface LhVolume {
      metadata?: { name?: string };
      spec?: { size?: string; numberOfReplicas?: number; frontend?: string };
      status?: {
        state?: string;
        robustness?: string;
        actualSize?: string | number;
        lastBackupAt?: string;
        frontend?: string;
        conditions?: LhVolumeCondition[];
      };
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
    volumeIndex = new Map((vols.items ?? []).map((v) => {
      // Surface only conditions whose status is "True". By Longhorn
      // convention these are types like "Restore" and "OfflineRebuilding"
      // — abnormal sub-states the operator should know about. Healthy
      // steady-state volumes have nearly all conditions at False, with
      // `Scheduled`==True being the *good* case (it just means "we
      // found a slot for the desired replica count"). We deliberately
      // filter out `Scheduled==True` so the UI doesn't show it as a
      // warning.
      const conds = (v.status?.conditions ?? [])
        .filter((c) => c.status === 'True' && c.type && c.type !== 'Scheduled')
        .map((c) => ({ type: c.type as string, reason: c.reason ?? null, message: c.message ?? null }));
      return [
        v.metadata?.name ?? '',
        {
          state: v.status?.state ?? null,
          robustness: v.status?.robustness ?? null,
          sizeBytes: Number(v.spec?.size ?? '0') || 0,
          // Block-level allocation including filesystem metadata +
          // Longhorn snapshot blocks. Empty 10 GiB ext4 volumes report
          // ~230 MiB; XFS reports ~40 MiB. Fresh detached volumes
          // report 0.
          allocatedBytes: Number(v.status?.actualSize ?? '0') || 0,
          // Desired replica count from spec — UI compares this to
          // running replicas to flag a degraded volume even when
          // status.robustness lags.
          numberOfReplicas: Number(v.spec?.numberOfReplicas ?? 1) || 1,
          // Longhorn-format ISO string ("2026-04-26T22:01:14Z") or null.
          lastBackupAt: v.status?.lastBackupAt ?? null,
          // status.frontend is the runtime view ("blockdev" when
          // attached, empty when detached); spec.frontend is the
          // desired type. We surface the live one.
          frontendState: v.status?.frontend ?? null,
          engineConditions: conds,
        },
      ];
    }));
  } catch (err) {
    console.warn('[clients/storage-placement] longhorn list failed:', (err as Error).message);
  }

  // PV index — fsType lives on PV.spec.csi.volumeAttributes.fsType,
  // not on the PVC. Single cluster-wide LIST, then look up by name
  // (PV.metadata.name === PVC.spec.volumeName for bound PVCs).
  // Best-effort; permission denial or transient API failure → empty
  // map → fsType:null in the response.
  const fsTypeByPvName = new Map<string, string>();
  try {
    interface PvItem {
      metadata?: { name?: string };
      spec?: { csi?: { volumeAttributes?: Record<string, string> } };
    }
    const pvList = await (k8s.core as unknown as {
      listPersistentVolume: () => Promise<{ items?: PvItem[] }>;
    }).listPersistentVolume();
    for (const pv of pvList.items ?? []) {
      const n = pv.metadata?.name;
      const fs = pv.spec?.csi?.volumeAttributes?.fsType;
      if (n && fs) fsTypeByPvName.set(n, fs);
    }
  } catch (err) {
    console.warn('[clients/storage-placement] PV list failed:', (err as Error).message);
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
      const https = await import('https');
      const { URL } = await import('url');
      const kc = new k8sNode.KubeConfig();
      kc.loadFromCluster();
      const cluster = kc.getCurrentCluster();
      if (cluster) {
        const httpsOpts = {} as { ca?: string; cert?: string; key?: string; headers?: Record<string, string> };
        await kc.applyToHTTPSOptions(httpsOpts);
        interface KubeletVolume { name?: string; usedBytes?: number; pvcRef?: { name?: string; namespace?: string } }
        interface KubeletPod { volume?: KubeletVolume[] }
        interface KubeletSummary { pods?: KubeletPod[] }

        const fetchSummary = (node: string): Promise<KubeletSummary | null> => new Promise((resolve) => {
          const u = new URL(`${cluster.server}/api/v1/nodes/${encodeURIComponent(node)}/proxy/stats/summary`);
          const req = https.request({
            method: 'GET',
            host: u.hostname,
            port: u.port || 443,
            path: u.pathname,
            ca: httpsOpts.ca,
            cert: httpsOpts.cert,
            key: httpsOpts.key,
            // K3s apiserver presents a self-signed cert when reached via
            // KUBERNETES_SERVICE_HOST; in-cluster CA covers it but some
            // installs serve a different cert on the proxy port. Reject
            // unauthorized stays default (true) — applyToHTTPSOptions
            // pulls the right CA from the SA token mount.
            headers: httpsOpts.headers ?? {},
          }, (res) => {
            if (res.statusCode !== 200) {
              console.warn(`[clients/storage-placement] kubelet ${node} HTTP ${res.statusCode}`);
              res.resume();
              resolve(null);
              return;
            }
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
              try { resolve(JSON.parse(data) as KubeletSummary); }
              catch (err) {
                console.warn(`[clients/storage-placement] kubelet ${node} parse: ${(err as Error).message}`);
                resolve(null);
              }
            });
          });
          req.on('error', (err) => {
            console.warn(`[clients/storage-placement] kubelet ${node} req: ${err.message}`);
            resolve(null);
          });
          req.end();
        });

        const summaries = await Promise.all(Array.from(nodes).map(fetchSummary));
        for (const summary of summaries) {
          if (!summary) continue;
          for (const p of summary.pods ?? []) {
            for (const v of p.volume ?? []) {
              if (v.pvcRef?.namespace === namespace && v.pvcRef.name && typeof v.usedBytes === 'number') {
                // Multiple pods may mount the same RWO PVC; usedBytes
                // is the same filesystem reading. Last write wins.
                usedBytesByPvc.set(v.pvcRef.name, v.usedBytes);
              }
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn('[clients/storage-placement] kubelet stats failed:', (err as Error).message);
  }

  const pvcs: ClientPvcPlacementRow[] = [];
  for (const pvc of (pvcsResp.items ?? [])) {
    const pvcName = pvc.metadata?.name ?? '';
    const volumeName = pvc.spec?.volumeName ?? '';
    if (!volumeName) continue;
    const meta = volumeIndex.get(volumeName);
    const replicaNodes = (replicaNodesByVolume.get(volumeName) ?? []).slice().sort();
    pvcs.push({
      namespace,
      pvcName,
      volumeName,
      sizeBytes: meta?.sizeBytes ?? 0,
      usedBytes: usedBytesByPvc.get(pvcName) ?? 0,
      allocatedBytes: meta?.allocatedBytes ?? 0,
      state: meta?.state ?? null,
      robustness: meta?.robustness ?? null,
      replicaNodes,
      engineConditions: meta?.engineConditions ?? [],
      replicasHealthy: replicaNodes.length,
      replicasExpected: meta?.numberOfReplicas ?? 1,
      lastBackupAt: meta?.lastBackupAt ?? null,
      fsType: fsTypeByPvName.get(volumeName) ?? null,
      frontendState: meta?.frontendState ?? null,
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
