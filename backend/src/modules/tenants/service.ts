import { eq, like, and, sql, desc, asc, lt, gt } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import { tenants, domains, deployments, cronJobs, users, hostingPlans, clusterNodes, regions } from '../../db/schema.js';
import { tenantNotFound } from '../../shared/errors.js';
import { ApiError } from '../../shared/errors.js';
import { encodeCursor, decodeCursor } from '../../shared/pagination.js';
import type { Database } from '../../db/index.js';
import type { CreateTenantInput, UpdateTenantInput } from './schema.js';
import type { PaginationMeta } from '../../shared/response.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

function generateNamespace(name: string): string {
  return `tenant-${name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 50)}-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * M5: validate that a worker pin request references a real,
 * tenant-capable node. Used by both createTenant and updateTenant to
 * match the safety already enforced by the tenant-migration
 * endpoint. Returns the value unchanged on success; throws
 * INVALID_FIELD_VALUE otherwise. null / undefined pass through
 * untouched (means "default scheduler").
 */
async function validateWorkerPin(db: Database, value: string | null | undefined): Promise<string | null | undefined> {
  if (value == null || value === '') return value;
  const [node] = await db.select().from(clusterNodes).where(eq(clusterNodes.name, value)).limit(1);
  if (!node) {
    throw new ApiError('INVALID_FIELD_VALUE', `Unknown worker node '${value}'`, 400, { field: 'node_name' });
  }
  if (!node.canHostTenantWorkloads) {
    throw new ApiError(
      'INVALID_FIELD_VALUE',
      `Node '${value}' does not host tenant workloads (canHostTenantWorkloads=false)`,
      400,
      { field: 'node_name' },
    );
  }
  return value;
}

/**
 * Reshape a raw DB tenant row into the api-contract response shape:
 * the four flat billing_* columns collapse into a nested billingAddress
 * object (or null when any component is unset, which is the case for
 * pre-rename legacy rows that hadn't filled them in).
 *
 * Use at every place the service returns a tenant row to a route
 * handler. Routes serialize the result through Fastify's response
 * JSON Schema, which expects the nested shape.
 */
type TenantRow = typeof tenants.$inferSelect;
type TenantResponseShape = Omit<TenantRow, 'billingStreetAddress' | 'billingPostalAddress' | 'billingCity' | 'billingCountry'> & {
  billingAddress: { streetAddress: string; postalAddress: string; city: string; country: string } | null;
};
export function toTenantResponse<T extends TenantRow>(row: T): TenantResponseShape & Omit<T, keyof TenantRow> {
  const { billingStreetAddress, billingPostalAddress, billingCity, billingCountry, ...rest } = row;
  const billingAddress = billingStreetAddress && billingPostalAddress && billingCity && billingCountry
    ? { streetAddress: billingStreetAddress, postalAddress: billingPostalAddress, city: billingCity, country: billingCountry }
    : null;
  return { ...rest, billingAddress } as TenantResponseShape & Omit<T, keyof TenantRow>;
}

export async function createTenant(db: Database, input: CreateTenantInput, createdBy: string) {
  const id = crypto.randomUUID();
  const namespace = generateNamespace(input.name);

  // Validate worker pin early so the error surfaces before we touch
  // k8s or write the tenant row.
  await validateWorkerPin(db, input.node_name);

  // Validate plan_id + region_id referential integrity before the
  // insert so an invalid UUID surfaces as a clean validation error
  // instead of a raw Postgres FK-violation message (which leaks
  // table/column names in the response detail).
  const [planRow] = await db.select({ id: hostingPlans.id })
    .from(hostingPlans).where(eq(hostingPlans.id, input.plan_id)).limit(1);
  if (!planRow) {
    const err = new Error(`plan_id '${input.plan_id}' does not match any plan`) as Error & { code?: string };
    err.code = 'INVALID_PLAN_ID';
    throw err;
  }
  // region_id is optional in the API contract — UI hides it and the
  // server auto-fills the platform apex region (system_settings.
  // platform_apex_region_id, falling back to the single region row
  // when only one exists).
  let resolvedRegionId: string;
  if (input.region_id) {
    const [regionRow] = await db.select({ id: regions.id })
      .from(regions).where(eq(regions.id, input.region_id)).limit(1);
    if (!regionRow) {
      const err = new Error(`region_id '${input.region_id}' does not match any region`) as Error & { code?: string };
      err.code = 'INVALID_REGION_ID';
      throw err;
    }
    resolvedRegionId = regionRow.id;
  } else {
    const { getSettings } = await import('../system-settings/service.js');
    const settings = await getSettings(db);
    const apex = (settings as { platformApexRegionId?: string | null }).platformApexRegionId;
    if (apex) {
      resolvedRegionId = apex;
    } else {
      // Fallback: pick the only region row, or fail if multiple exist.
      const allRegions = await db.select({ id: regions.id }).from(regions).limit(2);
      if (allRegions.length === 0) {
        const err = new Error('no region configured; set system_settings.platform_apex_region_id first') as Error & { code?: string };
        err.code = 'NO_APEX_REGION';
        throw err;
      }
      if (allRegions.length > 1) {
        const err = new Error('region_id required when multiple regions exist; set system_settings.platform_apex_region_id') as Error & { code?: string };
        err.code = 'AMBIGUOUS_REGION';
        throw err;
      }
      resolvedRegionId = allRegions[0]!.id;
    }
  }

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

  await db.insert(tenants).values({
    id,
    regionId: resolvedRegionId,
    name: input.name,
    contactName: input.contact_name ?? null,
    primaryEmail: input.primary_email,
    secondaryEmail: input.secondary_email ?? null,
    phoneE164: input.phone_e164 ?? null,
    billingStreetAddress: input.billing_address?.street_address ?? null,
    billingPostalAddress: input.billing_address?.postal_address ?? null,
    billingCity: input.billing_address?.city ?? null,
    billingCountry: input.billing_address?.country ?? null,
    status: 'pending',
    kubernetesNamespace: namespace,
    planId: input.plan_id,
    createdBy,
    timezone,
    // M5: optional worker pin. When unset, the scheduler picks at
    // first-deploy time; admins can still re-assign later via PATCH.
    nodeName: input.node_name ?? null,
    // M7: default storage tier is 'local' (cheap, 1 replica). Admin
    // can flip to 'ha' at create or later; flipping after provisioning
    // only changes the intent — the PVC keeps its original SC until
    // a storage-migration flow moves the data (future work).
    storageTier: input.storage_tier ?? 'local',
    subscriptionExpiresAt: input.subscription_expires_at ? new Date(input.subscription_expires_at) : null,
  });

  const [created] = await db.select().from(tenants).where(eq(tenants.id, id));

  // Auto-create tenant_admin user with generated password.
  //
  // SECURITY: pre-check that the email isn't already in use by ANY
  // user before insert. The previous `onConflictDoUpdate(target=email,
  // set: tenantId)` upsert silently re-pointed an existing user
  // (admin / support / different tenant's tenant_admin) to this new
  // tenant — an account-takeover vector when driven from
  // import-finalize where the operator picks the email. Fail closed:
  // surface a clear EMAIL_IN_USE error and roll back the just-inserted
  // tenant row so the caller can retry with a different email.
  const generatedPassword = generateStrongPassword();
  const passwordHash = await bcrypt.hash(generatedPassword, 12);
  const tenantUserId = crypto.randomUUID();

  const [existingUser] = await db.select({ id: users.id }).from(users).where(eq(users.email, input.primary_email)).limit(1);
  if (existingUser) {
    // Roll back the tenant row so caller can retry. We can't transact
    // across kubernetesNamespace generation (nondeterministic), so a
    // post-insert delete is the cleanest atomic-ish fallback.
    await db.delete(tenants).where(eq(tenants.id, id));
    const err = new Error(`a user with email '${input.primary_email}' already exists; pick a different email`) as Error & { code?: string };
    err.code = 'EMAIL_IN_USE';
    throw err;
  }

  await db.insert(users).values({
    id: tenantUserId,
    email: input.primary_email,
    passwordHash,
    fullName: input.name,
    roleName: 'tenant_admin',
    panel: 'tenant',
    tenantId: id,
    status: 'active',
    emailVerifiedAt: new Date(),
  });

  return { ...toTenantResponse(created), _generatedPassword: generatedPassword, _clientUserId: tenantUserId };
}

function generateStrongPassword(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%&*';
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

export async function getTenantById(db: Database, id: string) {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, id));
  if (!tenant) throw tenantNotFound(id);
  return toTenantResponse(tenant);
}

/** One row per PVC returned by getTenantStoragePlacement. */
export interface TenantPvcPlacementRow {
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
 * Walks the tenant's PVCs, joins each to its Longhorn Volume CR + PV,
 * then to the running replicas.
 *
 * Best-effort: a missing Longhorn CRD (dev cluster) or transient
 * API blip yields an empty replicas list rather than failing the
 * whole request — the UI shows "—" in that case.
 *
 * Performance phases (2026-04-30, ~3-6s -> <1s on first load, <50ms cached):
 *   1. All independent LISTs run via Promise.all (was sequential).
 *   2. Kubelet stats hit :10250 directly (was via apiserver-proxy).
 *   3. KubeConfig + HTTPS Agent are lifted to module-level singletons.
 *   4. 5-second TTL response cache per (tenantId).
 *   5. Skip kubelet stats entirely when all volumes are detached
 *      (no pod => no kubelet entry to read anyway).
 */

const STORAGE_PLACEMENT_TTL_MS = 5_000;
interface PlacementCacheEntry {
  at: number;
  data: { pvcs: TenantPvcPlacementRow[] };
}
const _placementCache = new Map<string, PlacementCacheEntry>();

export function invalidateStoragePlacementCache(tenantId: string): void {
  _placementCache.delete(tenantId);
}

/** Test-only: clear the placement cache so tests don't leak state. */
export function __resetStoragePlacementCacheForTests(): void {
  _placementCache.clear();
}

// Singleton initialisation: assigned all-or-nothing at the end so a
// concurrent first-call that observes a partial state can't proceed.
interface KubeletHttpsContext {
  cluster: ReturnType<import('@kubernetes/client-node').KubeConfig['getCurrentCluster']>;
  opts: { ca?: string; cert?: string; key?: string; headers?: Record<string, string> };
  /** For direct :10250 calls — node serving cert is not in the SA CA,
   *  so verification is off. Auth is the SA bearer token in headers. */
  directAgent: import('node:https').Agent;
  /** For apiserver-proxy fallback — apiserver cert IS in the SA CA,
   *  so verification stays on. Reusing the directAgent here would
   *  silently disable TLS verification on the apiserver hop too. */
  proxyAgent: import('node:https').Agent;
}

// Per-node learned state: if direct :10250 fails for a node (firewall,
// RBAC denial, TLS error), remember it for KUBELET_BAD_NODE_TTL_MS so
// we don't keep paying the 800ms direct timeout per cold call.
// Per-node (not global) so a single firewalled node doesn't disable
// the direct path for healthy nodes. Cleared on process restart or
// after the TTL — short enough that genuine recoveries are picked up.
const KUBELET_BAD_NODE_TTL_MS = 5 * 60_000; // 5 min
const _directKubeletBadNodes = new Map<string, number>();
function noteDirectKubeletFailure(node: string): void {
  _directKubeletBadNodes.set(node, Date.now());
}
function isDirectKubeletKnownBad(node: string): boolean {
  const at = _directKubeletBadNodes.get(node);
  if (!at) return false;
  if (Date.now() - at > KUBELET_BAD_NODE_TTL_MS) {
    _directKubeletBadNodes.delete(node);
    return false;
  }
  return true;
}
let _kubeletCtx: KubeletHttpsContext | null = null;
let _kubeletCtxInitPromise: Promise<KubeletHttpsContext | null> | null = null;
async function getKubeletHttpsContext(): Promise<KubeletHttpsContext | null> {
  if (_kubeletCtx) return _kubeletCtx;
  if (_kubeletCtxInitPromise) return _kubeletCtxInitPromise;
  _kubeletCtxInitPromise = (async () => {
    const k8sNode = await import('@kubernetes/client-node');
    const https = await import('node:https');
    const kc = new k8sNode.KubeConfig();
    try { kc.loadFromCluster(); } catch { return null; }
    const opts = {} as { ca?: string; cert?: string; key?: string; headers?: Record<string, string> };
    await kc.applyToHTTPSOptions(opts);
    const cluster = kc.getCurrentCluster();
    if (!cluster) return null;
    const directAgent = new https.Agent({
      keepAlive: true, keepAliveMsecs: 15_000,
      maxSockets: 32, maxFreeSockets: 8,
      rejectUnauthorized: false,
    });
    const proxyAgent = new https.Agent({
      keepAlive: true, keepAliveMsecs: 15_000,
      maxSockets: 32, maxFreeSockets: 8,
      // Default rejectUnauthorized: true. CA from applyToHTTPSOptions
      // covers the apiserver, so verification works on this path.
    });
    _kubeletCtx = { cluster, opts, directAgent, proxyAgent };
    return _kubeletCtx;
  })();
  const ctx = await _kubeletCtxInitPromise;
  _kubeletCtxInitPromise = null;
  return ctx;
}

export async function getTenantStoragePlacement(
  db: Database,
  id: string,
  k8s: K8sClients,
): Promise<{ pvcs: TenantPvcPlacementRow[] }> {
  const cached = _placementCache.get(id);
  if (cached && Date.now() - cached.at < STORAGE_PLACEMENT_TTL_MS) {
    return cached.data;
  }

  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, id));
  if (!tenant) throw tenantNotFound(id);
  if (!tenant.kubernetesNamespace) {
    return { pvcs: [] };
  }

  const namespace = tenant.kubernetesNamespace;

  // ── Phase 1: kick off all independent LISTs in parallel ──
  // Each piece is best-effort — a transient blip on one path yields a
  // partial result rather than failing the whole call.
  interface PvcItem { metadata?: { name?: string }; spec?: { volumeName?: string } }
  interface LhReplica { spec?: { volumeName?: string; nodeID?: string }; status?: { currentState?: string } }
  interface LhVolumeCondition { type?: string; status?: string; reason?: string; message?: string }
  interface LhVolume {
    metadata?: { name?: string };
    spec?: { size?: string; numberOfReplicas?: number; frontend?: string };
    status?: {
      state?: string; robustness?: string; actualSize?: string | number;
      lastBackupAt?: string; frontend?: string; conditions?: LhVolumeCondition[];
    };
  }
  interface PvItem {
    metadata?: { name?: string };
    spec?: { csi?: { volumeAttributes?: Record<string, string> } };
  }
  interface PodItem { spec?: { nodeName?: string } }

  const [pvcsResp, repsResp, volsResp, pvList, podsResp] = await Promise.all([
    k8s.core.listNamespacedPersistentVolumeClaim({ namespace })
      .catch(() => ({ items: [] as PvcItem[] })) as Promise<{ items?: PvcItem[] }>,
    (k8s.custom.listNamespacedCustomObject({
      group: 'longhorn.io', version: 'v1beta2',
      namespace: 'longhorn-system', plural: 'replicas',
    } as unknown as Parameters<typeof k8s.custom.listNamespacedCustomObject>[0])
      .catch(() => ({ items: [] }))) as Promise<{ items?: LhReplica[] }>,
    (k8s.custom.listNamespacedCustomObject({
      group: 'longhorn.io', version: 'v1beta2',
      namespace: 'longhorn-system', plural: 'volumes',
    } as unknown as Parameters<typeof k8s.custom.listNamespacedCustomObject>[0])
      .catch(() => ({ items: [] }))) as Promise<{ items?: LhVolume[] }>,
    ((k8s.core as unknown as { listPersistentVolume: () => Promise<{ items?: PvItem[] }> })
      .listPersistentVolume()
      .catch(() => ({ items: [] as PvItem[] }))),
    k8s.core.listNamespacedPod({ namespace })
      .catch(() => ({ items: [] as PodItem[] })) as Promise<{ items?: PodItem[] }>,
  ]);

  // Replicas → nodes-by-volume index
  const replicaNodesByVolume = new Map<string, string[]>();
  for (const r of repsResp.items ?? []) {
    if (r.status?.currentState !== 'running') continue;
    const v = r.spec?.volumeName;
    const n = r.spec?.nodeID;
    if (!v || !n) continue;
    const arr = replicaNodesByVolume.get(v) ?? [];
    arr.push(n);
    replicaNodesByVolume.set(v, arr);
  }

  // Volumes → metadata index
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
  const volumeIndex = new Map<string, VolumeMeta>((volsResp.items ?? []).map((v) => {
    const conds = (v.status?.conditions ?? [])
      .filter((c) => c.status === 'True' && c.type && c.type !== 'Scheduled')
      .map((c) => ({ type: c.type as string, reason: c.reason ?? null, message: c.message ?? null }));
    return [
      v.metadata?.name ?? '',
      {
        state: v.status?.state ?? null,
        robustness: v.status?.robustness ?? null,
        sizeBytes: Number(v.spec?.size ?? '0') || 0,
        allocatedBytes: Number(v.status?.actualSize ?? '0') || 0,
        numberOfReplicas: Number(v.spec?.numberOfReplicas ?? 1) || 1,
        lastBackupAt: v.status?.lastBackupAt ?? null,
        frontendState: v.status?.frontend ?? null,
        engineConditions: conds,
      },
    ];
  }));

  // PV → fsType index
  const fsTypeByPvName = new Map<string, string>();
  for (const pv of pvList.items ?? []) {
    const n = pv.metadata?.name;
    const fs = pv.spec?.csi?.volumeAttributes?.fsType;
    if (n && fs) fsTypeByPvName.set(n, fs);
  }

  // ── Phase 5: skip kubelet stats when no Longhorn volume reports as
  // attached. Detached volumes never appear in any pod's volume[]
  // entries, so kubelet stats yield nothing. Skipping saves
  // ~600-1500ms for archived/idle tenants.
  //
  // Caveat: if the Longhorn volumes LIST itself failed (volumeIndex
  // empty), we conservatively skip — and `usedBytes` stays 0 even
  // for attached volumes until Longhorn is back. The placement table
  // still renders all other fields; this is degraded mode, not a
  // correctness bug.
  const anyAttached = (pvcsResp.items ?? []).some((pvc) => {
    const meta = volumeIndex.get(pvc.spec?.volumeName ?? '');
    return meta?.state === 'attached' || meta?.frontendState === 'blockdev';
  });

  // ── Phases 2+3: kubelet stats via direct :10250 with cached
  // KubeConfig + persistent keep-alive Agent ──
  const usedBytesByPvc = new Map<string, number>();
  if (anyAttached) {
    try {
      const nodeNames = new Set<string>();
      for (const p of (podsResp.items ?? [])) {
        const n = p.spec?.nodeName;
        if (n) nodeNames.add(n);
      }
      if (nodeNames.size > 0) {
        // Resolve node InternalIPs (kubelet on :10250 listens on the
        // node's pod-network IP, not on the apiserver hostname).
        const nodesResp = await (k8s.core as unknown as {
          listNode: () => Promise<{ items?: Array<{
            metadata?: { name?: string };
            status?: { addresses?: Array<{ type?: string; address?: string }> };
          }> }>;
        }).listNode().catch(() => ({ items: [] }));
        const ipByNode = new Map<string, string>();
        for (const n of nodesResp.items ?? []) {
          const name = n.metadata?.name;
          const ip = (n.status?.addresses ?? []).find((a) => a.type === 'InternalIP')?.address;
          if (name && ip) ipByNode.set(name, ip);
        }

        const ctx = await getKubeletHttpsContext();
        if (ctx) {
          const https = await import('node:https');
          interface KubeletVolume { name?: string; usedBytes?: number; pvcRef?: { name?: string; namespace?: string } }
          interface KubeletPod { volume?: KubeletVolume[] }
          interface KubeletSummary { pods?: KubeletPod[] }

          const fetchDirect = (node: string, host: string, port = 10250): Promise<KubeletSummary | null> => new Promise((resolve) => {
            const req = https.request({
              method: 'GET',
              host,
              port,
              path: '/stats/summary',
              ca: ctx.opts.ca,
              cert: ctx.opts.cert,
              key: ctx.opts.key,
              headers: ctx.opts.headers ?? {},
              agent: ctx.directAgent,
              // Short timeout — if the node's :10250 isn't reachable
              // (firewall, RBAC) we want to fall back to apiserver-
              // proxy fast, not pay 4s every cold load.
              timeout: 800,
            }, (res) => {
              if (res.statusCode !== 200) {
                // Any non-200 (401/403 RBAC denial, 5xx kubelet hiccup)
                // is treated as "direct path doesn't work for this node
                // right now". Skip direct for this node for KUBELET_BAD_
                // NODE_TTL_MS.
                noteDirectKubeletFailure(node);
                res.resume();
                resolve(null);
                return;
              }
              let data = '';
              res.setEncoding('utf8');
              res.on('data', (chunk) => { data += chunk; });
              res.on('end', () => {
                try { resolve(JSON.parse(data) as KubeletSummary); }
                catch { resolve(null); }
              });
            });
            req.on('error', () => { noteDirectKubeletFailure(node); resolve(null); });
            req.on('timeout', () => { noteDirectKubeletFailure(node); req.destroy(); resolve(null); });
            req.end();
          });

          // Apiserver-proxy fallback for nodes whose :10250 isn't
          // reachable from platform-api (some restricted networks).
          const fetchProxy = (node: string): Promise<KubeletSummary | null> => new Promise((resolve) => {
            const u = new URL(`${ctx.cluster?.server}/api/v1/nodes/${encodeURIComponent(node)}/proxy/stats/summary`);
            const req = https.request({
              method: 'GET',
              host: u.hostname,
              port: u.port || 443,
              path: u.pathname,
              ca: ctx.opts.ca,
              cert: ctx.opts.cert,
              key: ctx.opts.key,
              headers: ctx.opts.headers ?? {},
              agent: ctx.proxyAgent,
              timeout: 6_000,
            }, (res) => {
              if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
              let data = '';
              res.setEncoding('utf8');
              res.on('data', (chunk) => { data += chunk; });
              res.on('end', () => {
                try { resolve(JSON.parse(data) as KubeletSummary); }
                catch { resolve(null); }
              });
            });
            req.on('error', () => resolve(null));
            req.on('timeout', () => { req.destroy(); resolve(null); });
            req.end();
          });

          const summaries = await Promise.all(Array.from(nodeNames).map(async (node) => {
            const ip = ipByNode.get(node);
            // Skip direct path for nodes we've recently seen fail —
            // saves 800ms per cold call per known-bad node.
            if (ip && !isDirectKubeletKnownBad(node)) {
              const direct = await fetchDirect(node, ip);
              if (direct) return direct;
            }
            return fetchProxy(node);
          }));

          for (const summary of summaries) {
            if (!summary) continue;
            for (const p of summary.pods ?? []) {
              for (const v of p.volume ?? []) {
                if (v.pvcRef?.namespace === namespace && v.pvcRef.name && typeof v.usedBytes === 'number') {
                  usedBytesByPvc.set(v.pvcRef.name, v.usedBytes);
                }
              }
            }
          }
        }
      }
    } catch (err) {
      console.warn('[tenants/storage-placement] kubelet stats failed:', (err as Error).message);
    }
  }

  const pvcs: TenantPvcPlacementRow[] = [];
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

  // ── Phase 4: cache for STORAGE_PLACEMENT_TTL_MS ──
  const result = { pvcs };
  _placementCache.set(id, { at: Date.now(), data: result });
  return result;
}

async function getPlanStorageGi(db: Database, planId: string): Promise<number> {
  const [plan] = await db.select({ storageLimit: hostingPlans.storageLimit })
    .from(hostingPlans).where(eq(hostingPlans.id, planId));
  return Number(plan?.storageLimit ?? 10);
}

/**
 * Resolve the pre-archive snapshot retention from storage-lifecycle
 * settings (defaults to 90d). Used when a PATCH status:archived omits
 * archive_retention_days. Best-effort: a settings load failure falls
 * back to 90 rather than blocking the archive — operators can still
 * re-take a manual snapshot if needed.
 */
async function loadPreArchiveRetentionDays(db: Database): Promise<number> {
  try {
    const { loadStorageLifecycleSettings } = await import('../storage-lifecycle/settings.js');
    const s = await loadStorageLifecycleSettings(db);
    return s.retentionPreArchiveDays;
  } catch (err) {
    console.warn('[tenants] loadPreArchiveRetentionDays failed, defaulting to 90d:', err instanceof Error ? err.message : String(err));
    return 90;
  }
}

export async function listTenants(
  db: Database,
  params: { limit: number; cursor?: string; sort: { field: string; direction: 'asc' | 'desc' }; search?: string },
): Promise<{ data: typeof tenants.$inferSelect[]; pagination: PaginationMeta }> {
  const { limit, cursor, sort, search } = params;

  const conditions = [];
  if (search) {
    const escaped = search.replace(/%/g, '\\%').replace(/_/g, '\\_');
    conditions.push(like(tenants.name, `%${escaped}%`));
  }

  if (cursor) {
    const decoded = decodeCursor(cursor);
    const sortCol = tenants.createdAt; // Default sort column
    conditions.push(
      sort.direction === 'desc' ? lt(sortCol, new Date(decoded.sort)) : gt(sortCol, new Date(decoded.sort)),
    );
  }

  const orderBy = sort.direction === 'desc' ? desc(tenants.createdAt) : asc(tenants.createdAt);
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select()
    .from(tenants)
    .where(where)
    .orderBy(orderBy)
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const data = rows.slice(0, limit);

  let nextCursor: string | null = null;
  if (hasMore && data.length > 0) {
    const last = data[data.length - 1];
    nextCursor = encodeCursor({
      resource: 'tenant',
      sort: last.createdAt.toISOString(),
      id: last.id,
    });
  }

  const [countResult] = await db.select({ count: sql<number>`count(*)` }).from(tenants).where(where);

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

export async function updateTenant(
  db: Database,
  id: string,
  input: UpdateTenantInput,
  opts: { triggeredByUserId?: string | null; k8sTenants?: K8sClients } = {},
) {
  const existing = await getTenantById(db, id); // throws if not found

  // Storage policy:
  //   • shrink (target < current MiB) → reject with STORAGE_RESIZE_REQUIRED.
  //     Operator must call POST /storage/resize explicitly so the
  //     destructive flow (snapshot+recreate+restore) is opt-in.
  //   • grow  (target > current MiB) → accepted; we auto-trigger the
  //     storage-lifecycle online-grow orchestrator AFTER the DB write
  //     and surface the operation id so the UI can poll progress.
  //
  // Comparison is done in MiB (not GiB) so decimal-GiB overrides
  // (e.g. "2.44" for a 2500 MiB resize) don't silently round to the
  // plan's integer-GiB value and let a shrink slip through.
  const newOverride = input.storage_limit_override;
  const newPlanId = input.plan_id;
  let pendingGrowMib: number | null = null;
  let pendingShrinkMib: number | null = null;
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
      // Shrink is destructive (snapshot → recreate PVC → restore).
      // Default-safe: reject unless caller explicitly opts in via
      // confirm_destructive_shrink:true. The orchestrator (resizeTenant
      // → resizeDestructive) runs its own pre-check that current
      // usedBytes × 1.1 buffer fits in target — if it doesn't, the
      // dispatch below throws RESIZE_UNSAFE before any data is touched.
      if (input.confirm_destructive_shrink !== true) {
        const { ApiError } = await import('../../shared/errors.js');
        throw new ApiError(
          'STORAGE_RESIZE_REQUIRED',
          `Shrinking storage from ${currentMib} MiB to ${targetMib} MiB is destructive and requires confirmation`,
          409,
          {
            currentMib,
            targetMib,
            currentGi: Math.round(currentMib / 102.4) / 10,
            targetGi: Math.round(targetMib / 102.4) / 10,
            remediation: 'Re-send the PATCH with confirm_destructive_shrink:true. The UI plan-edit modal handles this with a confirmation step.',
          },
        );
      }
      // Pre-flight dryrun BEFORE writing the new override to DB. The
      // grow path can write-then-dispatch because grow is idempotent
      // and a stale override is benign. Shrink is destructive and a
      // RESIZE_UNSAFE rejection from the orchestrator AFTER a DB write
      // leaves the override at the new (smaller) value while the PVC
      // stays at the old size — subsequent PATCHes would mis-classify
      // grow vs shrink. Run the dryrun here so we throw the
      // RESIZE_UNSAFE envelope before mutating anything.
      try {
        const { resolveSnapshotStore } = await import('../storage-lifecycle/snapshot-store.js');
        const { resizeDryRunMib } = await import('../storage-lifecycle/service.js');
        const { createK8sClients } = await import('../k8s-provisioner/k8s-client.js');
        const k8s = opts.k8sTenants ?? createK8sClients(process.env.KUBECONFIG_PATH);
        const store = await resolveSnapshotStore(db, process.env as Record<string, unknown>);
        const platformNamespace = process.env.PLATFORM_NAMESPACE ?? 'platform';
        const dry = await resizeDryRunMib({ db, k8s, store, platformNamespace }, id, targetMib);
        if (!dry.willFit) {
          const { ApiError } = await import('../../shared/errors.js');
          throw new ApiError('RESIZE_UNSAFE', dry.rejectReason ?? 'Shrink target too small for current usage', 400, { dryRun: dry });
        }
      } catch (err) {
        if (err instanceof ApiError) throw err;
        // resolveSnapshotStore / k8s import failure: fall through to
        // dispatch path which will surface the same error to the operator.
        console.warn('[tenants.updateTenant] shrink pre-flight dryrun failed:', err instanceof Error ? err.message : String(err));
      }
      pendingShrinkMib = targetMib;
    } else if (targetMib > currentMib) {
      // Mark intent — resize call happens AFTER the DB write below so
      // the persisted override matches what we ask the orchestrator
      // to grow to.
      pendingGrowMib = targetMib;
    }
  }

  // Reject nonsensical archived → suspended/pending transitions early.
  // Archived tenants have no PVC, no workloads, no mailboxes — going
  // straight to "suspended" would leave the row in a degenerate state.
  // The valid exits from archived are:
  //   archived → active   (restoreArchivedTenant orchestrator)
  //   archived → deleted  (DELETE /tenants/:id, hard cascade)
  if (
    input.status !== undefined
    && existing.status === 'archived'
    && input.status !== 'archived'
    && input.status !== 'active'
  ) {
    throw new ApiError(
      'INVALID_LIFECYCLE_TRANSITION',
      `Cannot transition archived tenant to '${input.status}' — only 'active' (restore) or 'archived' (no-op) are valid`,
      409,
      { from: 'archived', to: input.status },
      'Restore the tenant first (PATCH status: active) and then suspend if needed',
    );
  }

  // Detect status transitions that hand control over to a
  // storage-lifecycle orchestrator. Those orchestrators read
  // tenant.status to decide what to do (archive: must be non-archived;
  // restore-from-archive: must be archived; suspend: must be
  // non-suspended; resume: must be suspended) and then write the new
  // status themselves at the right point — so we MUST NOT pre-write
  // the new status here.
  const statusOwnedByLifecycle = (
    (input.status === 'archived' && existing.status !== 'archived')
    || (input.status === 'active' && existing.status === 'archived')
    || (input.status === 'suspended' && existing.status !== 'suspended')
    || (input.status === 'active' && existing.status === 'suspended')
  );

  const updateValues: Record<string, unknown> = {};
  if (input.name !== undefined) updateValues.name = input.name;
  if (input.primary_email !== undefined) updateValues.primaryEmail = input.primary_email;
  if (input.secondary_email !== undefined) updateValues.secondaryEmail = input.secondary_email;
  if (input.status !== undefined && !statusOwnedByLifecycle) updateValues.status = input.status;
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
  // M5: re-pin a tenant to a different worker. M3 plumbing makes the
  // next deploy apply the pin; existing pods keep running on their
  // current node until a migration (M6) or scheduler-triggered
  // eviction moves them.
  if (input.node_name !== undefined) {
    await validateWorkerPin(db, input.node_name);
    updateValues.nodeName = input.node_name;
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
    const [row] = await db.select({ storageTier: tenants.storageTier })
      .from(tenants).where(eq(tenants.id, id)).limit(1);
    previousTier = ((row?.storageTier ?? 'local') as 'local' | 'ha');
    // Cluster-shape gate: only check on a real local→ha flip (no-op
    // and ha→local are always safe). Same helper the create path uses
    // so the rule lives in one place.
    if (tierChange === 'ha' && previousTier !== 'ha') {
      const { assertHaTierFeasible } = await import('./capacity-preflight.js');
      await assertHaTierFeasible(db);
    }
    updateValues.storageTier = tierChange;
  }

  if (Object.keys(updateValues).length > 0) {
    await db.update(tenants).set(updateValues).where(eq(tenants.id, id));
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
        console.warn(`[tenants.updateTenant] tier flip queued — ${(err as Error).message}`);
      } else {
        // Re-throw so the route returns a real error envelope.
        throw err;
      }
    }
  }

  // Sync K8s ResourceQuota when resource limits change (fast synchronous
  // path; the full reprovision task below is async and idempotent).
  const planOrLimitsChanged = (
    (input.plan_id !== undefined && input.plan_id !== existing.planId)
    || input.cpu_limit_override !== undefined
    || input.memory_limit_override !== undefined
    || input.storage_limit_override !== undefined
  );
  if (planOrLimitsChanged) {
    try {
      const { createK8sClients } = await import('../k8s-provisioner/k8s-client.js');
      const { applyResourceQuota } = await import('../k8s-provisioner/service.js');
      const updatedTenant = await getTenantById(db, id);
      const [plan] = await db.select().from(hostingPlans).where(eq(hostingPlans.id, updatedTenant.planId));
      const k8s = createK8sClients(process.env.KUBECONFIG_PATH);
      await applyResourceQuota(k8s, updatedTenant.kubernetesNamespace, {
        cpu: String(updatedTenant.cpuLimitOverride ?? plan?.cpuLimit ?? 2),
        memory: String(updatedTenant.memoryLimitOverride ?? plan?.memoryLimit ?? 4),
        storage: String(updatedTenant.storageLimitOverride ?? plan?.storageLimit ?? 50),
      });
    } catch (err) {
      console.warn('[tenants] Failed to sync K8s ResourceQuota:', err instanceof Error ? err.message : String(err));
    }
  }

  // Auto-reprovision: queue a full provision_namespace task when plan or
  // resource limits change so namespace PSS labels, ResourceQuota, and
  // NetworkPolicy converge without requiring the operator to click
  // "Re-provision" manually. The task is fire-and-forget; the returned
  // reprovisionTaskId lets the UI open the progress modal if desired.
  //
  // Guard: skip when the tenant has no namespace yet (not provisioned /
  // still pending), is already being provisioned, or is being archived
  // in this same PATCH (the archive orchestrator deletes the namespace).
  let reprovisionTaskId: string | null = null;
  if (planOrLimitsChanged) {
    const eligibleStatus = existing.provisioningStatus === 'provisioned' || existing.provisioningStatus === 'failed';
    const notArchiving = existing.status !== 'archived' && input.status !== 'archived';
    const notBusy = existing.provisioningStatus !== 'provisioning';
    if (eligibleStatus && notArchiving && notBusy) {
      try {
        const { provisioningTasks: provTasksTable } = await import('../../db/schema.js');
        const { createK8sClients } = await import('../k8s-provisioner/k8s-client.js');
        const { runProvisionNamespace, PROVISION_STEPS, buildStepsLog, mirrorProvisioningToTaskTracker } = await import('../k8s-provisioner/service.js');
        const taskId = crypto.randomUUID();
        await db.insert(provTasksTable).values({
          id: taskId,
          tenantId: id,
          type: 'provision_namespace',
          status: 'pending',
          totalSteps: PROVISION_STEPS.length,
          completedSteps: 0,
          stepsLog: buildStepsLog(PROVISION_STEPS),
          startedBy: opts.triggeredByUserId ?? null,
        });
        await mirrorProvisioningToTaskTracker(db, taskId).catch(() => {});
        const k8s = opts.k8sTenants ?? createK8sClients(process.env.KUBECONFIG_PATH);
        runProvisionNamespace(db, k8s, taskId, id).catch((err) => {
          console.warn('[tenants.updateTenant] auto-reprovision failed:', err instanceof Error ? err.message : String(err));
        });
        reprovisionTaskId = taskId;
      } catch (err) {
        console.warn('[tenants.updateTenant] auto-reprovision setup failed:', err instanceof Error ? err.message : String(err));
      }
    }
  }

  // Cascade status change through the unified tenant-lifecycle module
  // so suspend / reactivate go through the same path as the subscription
  // expiry cron and storage-lifecycle ops. Includes ingress swap,
  // mailbox disable, etc.
  //
  // Archive + restore-from-archive are full storage-lifecycle
  // orchestrators (snapshot, then delete workloads + PVC, OR recreate
  // PVC from snapshot). They write storage_operations rows so the UI
  // can poll progress; the simple cascade path is bypassed for those
  // transitions because the orchestrators internally invoke the right
  // cascade at the right point (after snapshot, before/after PVC swap).
  let storageArchiveOperationId: string | null = null;
  let storageRestoreOperationId: string | null = null;
  // Suspend/resume return op-id from the lifecycle orchestrator (which
  // creates an op row and runs quiesce/unquiesce). Distinct from the
  // archive/restore ids so the UI can decide which modal to open.
  let storageOperationId: string | null = null;
  if (input.status === 'archived') {
    if (existing.status !== 'archived') {
      try {
        const { archiveTenant } = await import('../storage-lifecycle/service.js');
        // Phase 3 of the snapshot-storage overhaul: PATCH status:archived
        // writes a pre-archive snapshot, so it must route through the
        // per-class resolver (NOT the legacy single-active-target
        // fallback). Throws NO_SNAPSHOT_TARGET (409) if the
        // tenant_snapshot class is unassigned — operator must
        // configure an assignment before archive can proceed.
        const { resolveSnapshotStoreForClass } = await import('../storage-lifecycle/snapshot-store.js');
        const { createK8sClients } = await import('../k8s-provisioner/k8s-client.js');
        const k8s = opts.k8sTenants ?? createK8sClients(process.env.KUBECONFIG_PATH);
        const bundle = await resolveSnapshotStoreForClass(
          db,
          process.env as Record<string, unknown>,
          'tenant_snapshot',
        );
        const platformNamespace = process.env.PLATFORM_NAMESPACE ?? 'platform';
        const retentionDays = input.archive_retention_days
          ?? (await loadPreArchiveRetentionDays(db));
        const { operationId } = await archiveTenant(
          {
            db,
            k8s,
            store: bundle.store,
            platformNamespace,
            targetId: bundle.targetId,
            snapshotClass: 'tenant_snapshot',
          },
          id,
          { retentionDays, triggeredByUserId: opts.triggeredByUserId ?? null },
        );
        storageArchiveOperationId = operationId;
      } catch (err) {
        if (err instanceof ApiError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        throw new ApiError('ARCHIVE_FAILED', `Failed to start archive: ${msg}`, 502, undefined, 'Check storage-lifecycle settings (snapshot backend) and retry');
      }
    }
    // PATCH status:archived on already-archived tenant is a no-op —
    // we already updated the DB row above. Don't re-archive.
  } else if (input.status === 'active' && existing.status === 'archived') {
    try {
      const { restoreArchivedTenant } = await import('../storage-lifecycle/service.js');
      const { resolveSnapshotStore } = await import('../storage-lifecycle/snapshot-store.js');
      const { createK8sClients } = await import('../k8s-provisioner/k8s-client.js');
      const k8s = opts.k8sTenants ?? createK8sClients(process.env.KUBECONFIG_PATH);
      const store = await resolveSnapshotStore(db, process.env as Record<string, unknown>);
      const platformNamespace = process.env.PLATFORM_NAMESPACE ?? 'platform';
      const { operationId } = await restoreArchivedTenant(
        { db, k8s, store, platformNamespace },
        id,
        { triggeredByUserId: opts.triggeredByUserId ?? null },
      );
      storageRestoreOperationId = operationId;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new ApiError('RESTORE_FAILED', `Failed to start restore: ${msg}`, 502, undefined, 'Verify pre-archive snapshot still exists (retention may have expired) and retry');
    }
  } else if (input.status === 'suspended' || input.status === 'active') {
    // Non-archive transitions: dispatch to the storage-lifecycle
    // suspend/resume orchestrators. They quiesce K8s deployments
    // (scale to 0 / restore pre-suspend replicas) AND run the
    // applySuspended/applyActive cascades for ingress swap, mailbox
    // disable, etc. Operation row is created so the UI can track
    // progress; storageOperationId is returned to the caller.
    try {
      const { createK8sClients } = await import('../k8s-provisioner/k8s-client.js');
      const { suspendTenant, resumeTenant } = await import('../storage-lifecycle/service.js');
      const { resolveSnapshotStore } = await import('../storage-lifecycle/snapshot-store.js');
      const k8s = createK8sClients(process.env.KUBECONFIG_PATH);
      const store = await resolveSnapshotStore(db, process.env as Record<string, unknown>);
      const platformNamespace = process.env.PLATFORM_NAMESPACE ?? 'platform';
      const ctx = { db, k8s, store, platformNamespace };
      if (input.status === 'suspended') {
        const { operationId } = await suspendTenant(ctx, id, { triggeredByUserId: opts.triggeredByUserId ?? null });
        storageOperationId = operationId;
      } else {
        const { operationId } = await resumeTenant(ctx, id, { triggeredByUserId: opts.triggeredByUserId ?? null });
        storageOperationId = operationId;
      }
    } catch (err) {
      // ALREADY_SUSPENDED / NOT_SUSPENDED idempotency errors are
      // benign — the row is already in the requested state. Other
      // errors surface to the caller so the UI can show them.
      if (err instanceof ApiError && (err.code === 'ALREADY_SUSPENDED' || err.code === 'NOT_SUSPENDED')) {
        console.warn(`[tenants.updateTenant] suspend/resume idempotent: ${err.message}`);
      } else {
        throw err;
      }
    }
  }

  // Phase 3.B.3: reconcile Stalwart outbound config when:
  //   - tenant status changed (suspend → rate=0 in throttle)
  //   - email send rate limit changed
  // Non-blocking — throttle reconcile failures shouldn't fail the
  // tenant update API call.
  if (input.status !== undefined || input.email_send_rate_limit !== undefined) {
    try {
      const { reconcileOutboundConfig } = await import('../email-outbound/service.js');
      const { createK8sClients } = await import('../k8s-provisioner/k8s-client.js');
      const k8s = createK8sClients(process.env.KUBECONFIG_PATH);
      await reconcileOutboundConfig(db, k8s);
    } catch (err) {
      console.warn('[tenants] Failed to reconcile outbound config after status/rate change:', err instanceof Error ? err.message : String(err));
    }
  }

  // Auto-trigger online-grow / destructive-shrink when subscription
  // change asked for more or less storage. Done AFTER all other DB
  // writes so the persisted override matches what the orchestrator
  // targets. resizeTenant internally dispatches grow vs shrink based
  // on (newMib vs PVC current). Failures here attach a null op id to
  // the response so the UI can surface the failure without rolling
  // back the rest of the PATCH.
  let storageGrowOperationId: string | null = null;
  let storageShrinkOperationId: string | null = null;
  const pendingResizeMib = pendingGrowMib ?? pendingShrinkMib;
  if (pendingResizeMib != null) {
    try {
      const { resolveSnapshotStore } = await import('../storage-lifecycle/snapshot-store.js');
      const { resizeTenant } = await import('../storage-lifecycle/service.js');
      const { createK8sClients } = await import('../k8s-provisioner/k8s-client.js');
      const k8s = opts.k8sTenants ?? createK8sClients(process.env.KUBECONFIG_PATH);
      const store = await resolveSnapshotStore(db, process.env as Record<string, unknown>);
      const platformNamespace = process.env.PLATFORM_NAMESPACE ?? 'platform';
      const { operationId } = await resizeTenant(
        { db, k8s, store, platformNamespace },
        id,
        { newMib: pendingResizeMib, triggeredByUserId: opts.triggeredByUserId ?? null },
      );
      if (pendingGrowMib != null) {
        storageGrowOperationId = operationId;
      } else {
        storageShrinkOperationId = operationId;
      }
    } catch (err) {
      // For shrink we re-throw RESIZE_UNSAFE so the operator sees a
      // real error envelope (the dryrun rejected the target as too
      // small for current contents). For grow we keep the
      // best-effort behavior — the override is already persisted, the
      // ResourceQuota will reflect it, and the operator can retry.
      const code = (err as { code?: string }).code;
      if (pendingShrinkMib != null && code === 'RESIZE_UNSAFE') {
        throw err;
      }
      console.warn(
        `[tenants] Auto ${pendingGrowMib != null ? 'grow' : 'shrink'} failed to start:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  const updated = await getTenantById(db, id);
  // Attach lifecycle op ids when set so the UI can open progress
  // modals. Each transition only fires its own orchestrator so at most
  // one of these is non-null per PATCH.
  const sideEffects: {
    storageGrowOperationId?: string;
    storageShrinkOperationId?: string;
    storageArchiveOperationId?: string;
    storageRestoreOperationId?: string;
    storageOperationId?: string;
    reprovisionTaskId?: string;
  } = {};
  if (storageGrowOperationId != null) sideEffects.storageGrowOperationId = storageGrowOperationId;
  if (storageShrinkOperationId != null) sideEffects.storageShrinkOperationId = storageShrinkOperationId;
  if (storageArchiveOperationId != null) sideEffects.storageArchiveOperationId = storageArchiveOperationId;
  if (storageRestoreOperationId != null) sideEffects.storageRestoreOperationId = storageRestoreOperationId;
  if (storageOperationId != null) sideEffects.storageOperationId = storageOperationId;
  if (reprovisionTaskId != null) sideEffects.reprovisionTaskId = reprovisionTaskId;
  return Object.keys(sideEffects).length > 0
    ? { ...updated, ...sideEffects }
    : updated;
}

export async function deleteTenant(
  db: Database,
  id: string,
  k8sTenants?: K8sClients,
): Promise<{ transitionId: string | null }> {
  const tenant = await getTenantById(db, id);

  // Unified hard-delete cascade via tenant-lifecycle/cascades.ts —
  // namespace delete + DB row cascade in one function. Falls through
  // to a DB-only delete when k8s isn't available (unit tests).
  if (k8sTenants) {
    const { applyDeleted } = await import('../tenant-lifecycle/cascades.js');
    const transitionId = await applyDeleted({ db, k8s: k8sTenants }, id, tenant.kubernetesNamespace);

    // Also purge snapshot-store archives for this tenant so we don't
    // leak data after a hard delete. Best-effort; snapshots for
    // already-deleted tenants are reaped by the housekeeping cron
    // anyway.
    try {
      const { resolveSnapshotStore } = await import('../storage-lifecycle/snapshot-store.js');
      const { storageSnapshots } = await import('../../db/schema.js');
      const snaps = await db
        .select({ archivePath: storageSnapshots.archivePath })
        .from(storageSnapshots)
        .where(eq(storageSnapshots.tenantId, id));
      if (snaps.length > 0) {
        const store = await resolveSnapshotStore(db, process.env as Record<string, unknown>);
        for (const s of snaps) {
          await store.delete(s.archivePath).catch(() => {});
        }
      }
    } catch (err) {
      console.warn(`[tenant-delete] snapshot purge failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { transitionId };
  }

  // k8s not available (unit test path): delete DB row directly.
  await db.delete(tenants).where(eq(tenants.id, id));
  return { transitionId: null };
}
