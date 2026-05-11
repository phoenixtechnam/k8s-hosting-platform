// M13: platform-level storage replication policy. Companion to the M7
// per-tenant `clients.storage_tier` enum, but for the PLATFORM's own
// StatefulSets (postgres, stalwart-mail). The reconciler patches the
// matching longhorn.io/Volume CRs `.spec.numberOfReplicas` live —
// Longhorn handles add/remove of replicas asynchronously. No
// StatefulSet recreation, no snapshot/restore, no downtime.

import { eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { MERGE_PATCH } from '../../shared/k8s-patch.js';

// Platform StatefulSets whose volumes this policy controls. Add to the
// list when a new system StatefulSet ships with a PVC.
//
// NOTE: Postgres is owned by CNPG (Cluster/postgres in k8s/base/database.yaml),
// not a StatefulSet. CNPG's `instances` field is set by CNPG_INSTANCES_FOR
// below. The legacy `data-postgres-0` prefix entry was retired with the
// orphan StatefulSet (Phase 4 cleanup, 2026-04-27).
//
// CNPG-managed PVCs (`<cluster>-<n>`, e.g. postgres-1) are now ALSO
// included in the volumes list returned from readClusterState — they
// are enumerated separately via the cnpg.io/cluster=<name> label
// selector (see CNPG_CLUSTERS below). Inclusion is for OBSERVATION
// (display in the volumes table) and Longhorn-replica patching only:
// once a CNPG PVC appears in `state.volumes`, the existing
// `patchLonghornVolumes` loop will reconcile its numberOfReplicas to
// match the platform tier just like a StatefulSet PVC. CNPG's
// `spec.instances` is still patched independently by
// `patchCnpgClusters` — these are orthogonal concerns (CNPG instances
// = number of Postgres pods; Longhorn numberOfReplicas = number of
// disk copies per pod's PVC).
export const PLATFORM_STATEFULSETS: ReadonlyArray<{ namespace: string; pvcPrefix: string }> = [
  { namespace: 'mail', pvcPrefix: 'data-stalwart-mail' },    // data-stalwart-mail-0
];

// HA tier replicates a system volume to one server up to MAX_HA_REPLICAS.
// Lowered from 5 to 3 on 2026-05-11: rationale per the user's
// architectural intent — "in HA mode all servers should replicate all
// essential services for ease of maintenance, so an operator knows
// that all server nodes have almost the same state". 3 replicas
// survive 1 simultaneous server failure with quorum (the 2-of-3
// majority); going to 4-5 doubles write amplification on the postgres
// primary for marginal additional fault-tolerance (a 3-of-5 majority
// is only meaningful for clusters that often run with 2 simultaneous
// server outages — not our deployment shape). On 4+ server clusters
// the extra servers become headroom for tenant workloads rather than
// additional system replicas.
const MAX_HA_REPLICAS = 3;

export function replicasForSystemTier(tier: 'local' | 'ha', readyServerCount: number): number {
  if (tier === 'local') return 1;
  // HA: replicate to one server up to MAX_HA_REPLICAS. With the cap at 3,
  // a 3-server cluster lands one replica per server; a 4+ server cluster
  // still gets 3 (extra servers contribute capacity, not extra replicas).
  return Math.max(2, Math.min(readyServerCount, MAX_HA_REPLICAS));
}

// Stateless platform Deployments that scale 1↔min(serverCount,3) with the
// tier. Adding topologySpreadConstraints on each scale-up so a 3-replica
// rollout lands one pod per server (DoNotSchedule — see HA_TOPOLOGY_SPREAD).
// List is exhaustive — these are every platform-namespace Deployment whose
// loss would degrade admin/client panel function.
const STATELESS_DEPLOYMENTS: ReadonlyArray<{ namespace: string; name: string }> = [
  { namespace: 'platform', name: 'admin-panel' },
  { namespace: 'platform', name: 'client-panel' },
  { namespace: 'platform', name: 'platform-api' },
  { namespace: 'platform', name: 'oauth2-proxy' },
  { namespace: 'platform', name: 'dex' },
  // Cut 3 (2026-05-04): mail data-plane services follow the same
  // HA scaling policy as the platform stateless tier. Stalwart 0.16
  // is a Deployment (not StatefulSet — state lives in mail-pg CNPG)
  // so it fits the stateless replicas list. Roundcube is similarly
  // stateless (sessions persisted in Postgres since Phase 3.A.5,
  // emptyDir for the install dir).
  { namespace: 'mail', name: 'stalwart-mail' },
  { namespace: 'mail', name: 'roundcube' },
];
// Single-server (local) installs default to 1 replica per stateless
// service. HA scales to min(readyServerCount, MAX_HA_REPLICAS=3) so a
// 3-server cluster gets 1 pod per server (the "all servers same state"
// invariant); a 4-5 server cluster still has 3 replicas with the extra
// servers providing failover headroom for tenant workloads.
export function deploymentReplicasForSystemTier(tier: 'local' | 'ha', readyServerCount: number): number {
  if (tier === 'local') return 1;
  return Math.max(2, Math.min(readyServerCount, MAX_HA_REPLICAS));
}

// Leader-elect operators. These run with a single active leader at a
// time (lease-coordinated), so more than 2 replicas is purely wasteful
// — one leader does the work, one warm standby takes over on a leader
// crash. 2 is the minimum + maximum useful replica count in HA. In
// local mode (1 server) we drop to 1 since leader-election with a
// single replica is a no-op anyway.
//
// Targeted operators (all imperatively installed by bootstrap.sh — no
// HelmRelease CRs to patch — so the reconciler uses /scale subresource,
// same pattern as the stateless tier):
//   cert-manager:  controller + cainjector + webhook
//   flux-system:   source-controller, kustomize-controller, helm-controller, notification-controller
//   kube-system:   sealed-secrets-controller, snapshot-controller
//   cnpg-system:   cnpg-controller-manager
//
// Risk: a bootstrap.sh re-run via `helm upgrade --install` would reset
// the operator Deployment's replicas to 1; the reconciler picks it up
// on the next tick (≤5 min). One-replica window during that interval —
// acceptable for an operator workload (no user-visible blip; leader
// keeps working).
const LEADER_ELECT_DEPLOYMENTS: ReadonlyArray<{ namespace: string; name: string }> = [
  { namespace: 'cert-manager', name: 'cert-manager' },
  { namespace: 'cert-manager', name: 'cert-manager-cainjector' },
  { namespace: 'cert-manager', name: 'cert-manager-webhook' },
  { namespace: 'flux-system', name: 'source-controller' },
  { namespace: 'flux-system', name: 'kustomize-controller' },
  { namespace: 'flux-system', name: 'helm-controller' },
  { namespace: 'flux-system', name: 'notification-controller' },
  { namespace: 'kube-system', name: 'sealed-secrets-controller' },
  { namespace: 'kube-system', name: 'snapshot-controller' },
  { namespace: 'cnpg-system', name: 'cnpg-cloudnative-pg' },
];

// Leader-elect cap is 2 — see the LEADER_ELECT_DEPLOYMENTS comment.
// Below 2 servers, 1 replica is correct (no quorum possible with 1
// node anyway).
const MAX_LEADER_ELECT_REPLICAS = 2;

export function leaderElectReplicasForSystemTier(
  tier: 'local' | 'ha',
  readyServerCount: number,
): number {
  if (tier === 'local') return 1;
  return Math.max(1, Math.min(readyServerCount, MAX_LEADER_ELECT_REPLICAS));
}

// CNPG clusters. Apply HA flips spec.instances 1↔3 — CNPG streams
// replication from primary, no manual data migration needed.
//
// mail-pg: dedicated CNPG cluster for Stalwart 0.16. Independent
// snapshot/recovery cycle from platform-PG; same Apply-HA scaling
// path so a single admin action scales both clusters together.
// (Cut 2 / M6.2 — stalwart-mail deploy layer.)
// Cluster names track the role-based naming scheme (no version baggage).
// Cluster name history (cleaned up 2026-05-07):
//   platform: postgres → postgres-18 → system-db
//   mail:     mail-pg  → mail-pg-17 → mail-pg-18 → mail-db
// Future PG-major bumps follow the dump+restore-into-same-named-cluster
// pattern (or transient-then-rename), so this list stays version-stable.
const CNPG_CLUSTERS: ReadonlyArray<{ namespace: string; name: string }> = [
  { namespace: 'platform', name: 'system-db' },
  { namespace: 'mail', name: 'mail-db' },
];
// CNPG instance count tracks the same readyServerCount-aware policy
// so postgres replication fans out across every server in HA mode
// (matching Longhorn replicas for symmetric tolerance).
export function cnpgInstancesForSystemTier(tier: 'local' | 'ha', readyServerCount: number): number {
  if (tier === 'local') return 1;
  return Math.max(2, Math.min(readyServerCount, MAX_HA_REPLICAS));
}

// Valkey (platform-wide Redis-protocol coordinator cache) lives in
// redis-system. Single base manifest, replicas + maxmemory patched
// here so HA toggles and growth from 1 → N servers are picked up
// automatically.
//
// In `local` mode the StatefulSet shrinks to a single pod (no
// Sentinel quorum, but a single-pod cluster has no failover need
// either — the cache is purely in-memory and rebuilds on Pod
// restart). HA mode scales to readyServerCount (capped) so each
// server hosts one Valkey + Sentinel pair via DoNotSchedule
// topologySpread.
const VALKEY_NAMESPACE = 'redis-system';
const VALKEY_STATEFULSET = 'valkey';
const VALKEY_CONFIGMAP = 'valkey-config';

export function valkeyReplicasForSystemTier(tier: 'local' | 'ha', readyServerCount: number): number {
  // In `local` mode, run a single replica regardless of node count —
  // sentinel quorum requires 3 anyway, so 1 vs 2 makes no difference
  // in failover capability and 1 saves resources.
  if (tier === 'local') return 1;
  // HA mode: ≥3 to give Sentinel a quorum (2 of 3) for failover
  // elections. On a 2-server cluster (rare; HA threshold is 3+),
  // fall back to 1 — Sentinel can't quorum on 2 anyway.
  if (readyServerCount < HA_SERVER_THRESHOLD) return 1;
  return Math.min(readyServerCount, MAX_HA_REPLICAS);
}

// Memory budget per Valkey pod. Scales with cluster size so a
// 5-server install gets ~256 MiB total cache headroom while a
// single-node install stays at ~32 MiB to leave RAM for tenant
// workloads. Numbers chosen empirically from Stalwart's coordinator
// cache footprint (≈4 MiB per active mailbox) plus headroom.
//
// The maxmemory directive is applied via ConfigMap + Reloader
// rolling restart — see patchValkey() for the full path.
export function valkeyMaxMemoryBytesForSystemTier(
  tier: 'local' | 'ha',
  readyServerCount: number,
): number {
  // local mode: 32 MiB — small but sufficient for a single-node lab.
  if (tier === 'local') return 32 * 1024 * 1024;
  // HA mode: 32 MiB / replica baseline + 32 MiB / additional server
  // beyond the threshold. 3 servers → 96 MiB; 4 → 128 MiB; 5 → 160 MiB.
  const replicas = valkeyReplicasForSystemTier(tier, readyServerCount);
  return Math.max(32, replicas * 32) * 1024 * 1024;
}

/**
 * Format a byte count as a Valkey-compatible memory directive
 * (e.g. "96mb"). Valkey accepts decimal-MB, decimal-GB; we only
 * emit "Nmb" since our budgets stay sub-GiB through MAX_HA_REPLICAS.
 */
export function formatValkeyMemoryBytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))}mb`;
}

const SINGLETON_ID = 'singleton';
const HA_SERVER_THRESHOLD = 3;

// NOTE: topologySpreadConstraints for the active-active Deployments
// live in the manifests themselves (e.g. k8s/base/oauth2-proxy/
// deployment.yaml, k8s/base/platform/{admin,client}-deployment.yaml).
// We can't patch them imperatively from here without fighting Flux's
// server-side-apply field manager — see the patchStatelessDeployments
// comment around line 642 for the full rationale. The convention is
// DoNotSchedule on every active-active Deployment in HA, enforcing
// strict one-per-server placement so an operator can rely on every
// server holding the same system pods (2026-05-11 architectural
// invariant: "all servers same state for ease of maintenance").

export type LonghornVolume = {
  metadata?: { name?: string; namespace?: string };
  spec?: { numberOfReplicas?: number };
  status?: { robustness?: string; state?: string };
};

export type VolumeFact = {
  namespace: string;
  pvcName: string;
  volumeName: string;
  currentReplicas: number;
  desiredReplicas: number;
  healthy: boolean;
  phase: string | null;
  /** M-NS-2: nodes currently hosting a healthy replica. UI flags drift when any of these is NOT a system server. */
  replicaNodes: string[];
  /** True when at least one replicaNodes entry sits on a non-system server. */
  hasOffSystemReplica: boolean;
  /** Source of the PVC — `statefulset` (e.g. stalwart) or `cnpg` (e.g. postgres). */
  kind: 'statefulset' | 'cnpg';
};

export async function getPolicy(db: Database): Promise<typeof schema.platformStoragePolicy.$inferSelect> {
  const rows = await db.select().from(schema.platformStoragePolicy)
    .where(eq(schema.platformStoragePolicy.id, SINGLETON_ID))
    .limit(1);
  if (rows[0]) return rows[0];
  // Defensive: if the singleton row was wiped, recreate at default.
  // onConflictDoNothing handles the race where two backends concurrently
  // hit the empty-row branch — second insert is silently skipped, then
  // the SELECT below picks up whichever row won.
  await db.insert(schema.platformStoragePolicy)
    .values({ id: SINGLETON_ID })
    .onConflictDoNothing();
  const reread = await db.select().from(schema.platformStoragePolicy)
    .where(eq(schema.platformStoragePolicy.id, SINGLETON_ID))
    .limit(1);
  return reread[0];
}

export async function setPolicy(
  db: Database,
  systemTier: 'local' | 'ha',
  pinnedByAdmin: boolean,
  actorId: string | null,
): Promise<typeof schema.platformStoragePolicy.$inferSelect> {
  const updated = await db.update(schema.platformStoragePolicy)
    .set({
      systemTier,
      pinnedByAdmin,
      lastAppliedAt: new Date(),
      lastAppliedBy: actorId ?? null,
    })
    .where(eq(schema.platformStoragePolicy.id, SINGLETON_ID))
    .returning();
  return updated[0];
}

// Read live cluster state for the recommendation + per-volume fact list.
export async function readClusterState(
  k8s: K8sClients,
  db: Database,
): Promise<{ readyServerCount: number; totalNodeCount: number; recommendedTier: 'local' | 'ha'; volumes: VolumeFact[] }> {
  const policy = await getPolicy(db);
  // desiredReplicas is computed AFTER readyServerCount is known —
  // HA tier scales to min(readyServerCount, MAX_HA_REPLICAS=3).
  // Beyond 3 servers, extras contribute failover headroom for tenant
  // workloads instead of additional system replicas.

  // Count Ready server nodes by label
  // (platform.phoenix-host.net/node-role=server) so workers don't
  // bump the recommendation. A 3-server quorum is the threshold.
  //
  // `totalNodeCount` is named for the API field but means "total
  // server-tagged nodes" — workers are excluded so the UI banner's
  // "X of Y server nodes" denominator only counts what's eligible to
  // host the platform-storage replicas. Including workers here would
  // make the ratio meaningless on mixed clusters (e.g. 3-of-7 with
  // 4 workers reads as under-resourced when the 3 servers are exactly
  // what the recommendation needs).
  const nodes = await k8s.core.listNode();
  let readyServerCount = 0;
  let totalNodeCount = 0;
  for (const node of nodes.items ?? []) {
    const labels = node.metadata?.labels ?? {};
    const isServer = labels['platform.phoenix-host.net/node-role'] === 'server'
      || (node.spec?.taints ?? []).some((t) => t.key === 'node-role.kubernetes.io/control-plane');
    if (!isServer) continue;
    totalNodeCount++;
    const ready = (node.status?.conditions ?? []).find((c) => c.type === 'Ready');
    if (ready?.status === 'True') readyServerCount++;
  }
  const recommendedTier: 'local' | 'ha' = readyServerCount >= HA_SERVER_THRESHOLD ? 'ha' : 'local';
  const desiredReplicas = replicasForSystemTier(policy.systemTier, readyServerCount);

  // M-NS-2: build the set of system-tagged nodes once so each volume's
  // placement check is a constant-time lookup. A k8s node carries
  // role=server in its labels; the matching Longhorn node must have
  // the "system" tag (the reconciler in nodes/k8s-sync mirrors role
  // → tag). We use the k8s label as the source of truth here so the
  // UI immediately reflects role flips even before Longhorn re-syncs.
  const systemNodes = new Set<string>();
  for (const node of nodes.items ?? []) {
    if (node.metadata?.labels?.['platform.phoenix-host.net/node-role'] === 'server') {
      systemNodes.add(node.metadata.name ?? '');
    }
  }

  // One up-front list of all running Longhorn replicas, keyed by
  // volumeName → nodeIDs. Cheaper than per-volume queries when the
  // platform has more than a handful of volumes.
  const replicasByVolume = new Map<string, string[]>();
  try {
    interface LhReplica {
      spec?: { volumeName?: string; nodeID?: string };
      status?: { currentState?: string };
    }
    const reps = await k8s.custom.listNamespacedCustomObject({
      group: 'longhorn.io', version: 'v1beta2',
      namespace: 'longhorn-system', plural: 'replicas',
    } as unknown as Parameters<typeof k8s.custom.listNamespacedCustomObject>[0]) as { items?: LhReplica[] };
    for (const r of reps.items ?? []) {
      const vol = r.spec?.volumeName;
      const node = r.spec?.nodeID;
      if (!vol || !node) continue;
      if (r.status?.currentState !== 'running') continue;
      const arr = replicasByVolume.get(vol) ?? [];
      arr.push(node);
      replicasByVolume.set(vol, arr);
    }
  } catch (err) {
    // Longhorn may not be installed (dev cluster); empty placement is
    // an acceptable degradation — the UI will simply show "—" for
    // node placement.
    const status = (err as { code?: number }).code ?? (err as { statusCode?: number }).statusCode;
    if (status !== 404) {
      console.warn('[platform-storage-policy] longhorn replica list failed:', (err as Error).message);
    }
  }

  // Discover Longhorn Volumes backing platform StatefulSet PVCs. We
  // look up by PVC name pattern rather than asking Longhorn directly
  // for a `pvc.name` filter (the v1beta2 API doesn't index that). The
  // PV referenced by each PVC carries the Volume CR's name.
  const volumes: VolumeFact[] = [];
  for (const sts of PLATFORM_STATEFULSETS) {
    const pvcs = await k8s.core.listNamespacedPersistentVolumeClaim({ namespace: sts.namespace })
      .catch(() => ({ items: [] }));
    for (const pvc of pvcs.items ?? []) {
      const name = pvc.metadata?.name ?? '';
      if (!name.startsWith(sts.pvcPrefix)) continue;
      const lhVolName = pvc.spec?.volumeName;
      if (!lhVolName) continue;
      // Longhorn Volumes are namespaced to longhorn-system. We use the
      // CustomObjects API directly — there's no typed client.
      const vol = await k8s.custom.getNamespacedCustomObject({
        group: 'longhorn.io', version: 'v1beta2',
        namespace: 'longhorn-system', plural: 'volumes', name: lhVolName,
      }).catch(() => null) as LonghornVolume | null;
      const currentReplicas = vol?.spec?.numberOfReplicas ?? 0;
      const robustness = vol?.status?.robustness ?? null;
      const state = vol?.status?.state ?? null;
      const healthy = robustness === 'healthy' && state === 'attached';
      const replicaNodes = (replicasByVolume.get(lhVolName) ?? []).slice().sort();
      const hasOffSystemReplica = replicaNodes.some((n) => !systemNodes.has(n));
      volumes.push({
        namespace: sts.namespace,
        pvcName: name,
        volumeName: lhVolName,
        currentReplicas,
        desiredReplicas,
        healthy,
        phase: state,
        replicaNodes,
        hasOffSystemReplica,
        kind: 'statefulset',
      });
    }
  }

  // CNPG-managed PVCs. CNPG creates one PVC per Postgres instance
  // labelled `cnpg.io/cluster=<cluster.name>`. Listing by label is
  // robust against the cluster name not matching a fixed pvcPrefix
  // (CNPG names them `<cluster>-<n>`, with no consistent suffix
  // count). desiredReplicas comes from the same REPLICAS_FOR table
  // so the column stays consistent across PVC sources, and the
  // existing patchLonghornVolumes() loop handles reconcile.
  // CNPG PVCs use Longhorn replicas=1 INDEPENDENTLY of the system
  // tier. CNPG streaming replication is the HA mechanism for postgres
  // — having N postgres instances across N servers with N×N Longhorn
  // replicas would pay quadratic write amplification for redundancy
  // that already exists at the CNPG layer. Each CNPG instance's PVC
  // only needs 1 replica (single-node disk-failure tolerance via the
  // CNPG instance failover, not via Longhorn). The CNPG instance
  // count itself scales with min(readyServerCount, 3) via
  // cnpgInstancesForSystemTier so a 3-server cluster gets 3 postgres
  // instances (1-server-loss tolerance with quorum) and a 4+ server
  // cluster still gets 3 — the extra servers provide failover headroom
  // for tenant workloads rather than additional postgres instances.
  const CNPG_DESIRED_REPLICAS = 1;
  for (const c of CNPG_CLUSTERS) {
    const pvcs = await k8s.core.listNamespacedPersistentVolumeClaim({
      namespace: c.namespace,
      labelSelector: `cnpg.io/cluster=${c.name}`,
    } as unknown as Parameters<typeof k8s.core.listNamespacedPersistentVolumeClaim>[0])
      .catch(() => ({ items: [] }));
    for (const pvc of pvcs.items ?? []) {
      const name = pvc.metadata?.name ?? '';
      const lhVolName = pvc.spec?.volumeName;
      if (!name || !lhVolName) continue;
      const vol = await k8s.custom.getNamespacedCustomObject({
        group: 'longhorn.io', version: 'v1beta2',
        namespace: 'longhorn-system', plural: 'volumes', name: lhVolName,
      }).catch(() => null) as LonghornVolume | null;
      const currentReplicas = vol?.spec?.numberOfReplicas ?? 0;
      const robustness = vol?.status?.robustness ?? null;
      const state = vol?.status?.state ?? null;
      const healthy = robustness === 'healthy' && state === 'attached';
      const replicaNodes = (replicasByVolume.get(lhVolName) ?? []).slice().sort();
      const hasOffSystemReplica = replicaNodes.some((n) => !systemNodes.has(n));
      volumes.push({
        namespace: c.namespace,
        pvcName: name,
        volumeName: lhVolName,
        currentReplicas,
        desiredReplicas: CNPG_DESIRED_REPLICAS,
        healthy,
        phase: state,
        replicaNodes,
        hasOffSystemReplica,
        kind: 'cnpg',
      });
    }
  }

  return { readyServerCount, totalNodeCount, recommendedTier, volumes };
}

export type ApplyPatchResult = {
  namespace: string;
  volumeName: string;
  previousReplicas: number;
  newReplicas: number;
  patched: boolean;
  error: string | null;
};

export type DeploymentPatchResult = {
  namespace: string;
  name: string;
  previousReplicas: number;
  newReplicas: number;
  patched: boolean;
  error: string | null;
};

export type CnpgClusterPatchResult = {
  namespace: string;
  name: string;
  previousInstances: number;
  newInstances: number;
  patched: boolean;
  error: string | null;
};

export type ValkeyPatchResult = {
  namespace: string;
  statefulSetName: string;
  previousReplicas: number;
  newReplicas: number;
  previousMaxMemory: string | null;
  newMaxMemory: string;
  replicasPatched: boolean;
  configPatched: boolean;
  error: string | null;
};

export type ApplyPolicyOutcome = {
  volumes: ApplyPatchResult[];
  deployments: DeploymentPatchResult[];
  leaderElectDeployments: DeploymentPatchResult[];
  cnpgClusters: CnpgClusterPatchResult[];
  valkey: ValkeyPatchResult | null;
};

// Apply the desired tier to:
//   1) Longhorn volumes (replicas per PVC)
//   2) Stateless platform Deployments (replicas + topologySpread)
//   3) Leader-elect operator Deployments (replicas 1↔2)
//   4) CNPG Cluster (instances)
//   5) Valkey StatefulSet (replicas + maxmemory)
// Each step is idempotent and returns its result (whether patched
// or skipped, with any error). Steps run sequentially — failure
// in one does not stop the others (so a partial Apply is reported
// transparently rather than silently halting).
export async function applyPolicy(
  k8s: K8sClients,
  db: Database,
): Promise<ApplyPolicyOutcome> {
  const policy = await getPolicy(db);
  const state = await readClusterState(k8s, db);
  const tier: 'local' | 'ha' = policy.systemTier;

  return {
    volumes: await patchLonghornVolumes(k8s, state.volumes),
    deployments: await patchStatelessDeployments(k8s, tier, state.readyServerCount),
    leaderElectDeployments: await patchLeaderElectDeployments(k8s, tier, state.readyServerCount),
    cnpgClusters: await patchCnpgClusters(k8s, tier, state.readyServerCount),
    valkey: await patchValkey(k8s, tier, state.readyServerCount),
  };
}

async function patchLonghornVolumes(
  k8s: K8sClients,
  volumes: VolumeFact[],
): Promise<ApplyPatchResult[]> {
  // First read the live nodeSelector for each platform volume — we
  // want to patch BOTH numberOfReplicas (tier-driven) AND nodeSelector
  // ("system") in a single round trip per volume, but only when the
  // current value diverges. One LIST is cheaper than N GETs.
  const liveSelectors = await readLiveNodeSelectors(k8s, volumes.map((v) => v.volumeName));

  const results: ApplyPatchResult[] = [];
  for (const v of volumes) {
    const currentSelector = liveSelectors.get(v.volumeName) ?? [];
    // Drift = the selector is not exactly ["system"]. Stricter than
    // "missing system" — also catches volumes that picked up extra
    // tags (operator mistake or Longhorn evolution). The reconciler
    // re-asserts exactly ["system"] so the desired state is canonical.
    const wantsSelector = !(currentSelector.length === 1 && currentSelector[0] === 'system');
    const replicaDelta = v.currentReplicas !== v.desiredReplicas;

    if (!replicaDelta && !wantsSelector) {
      results.push({
        namespace: v.namespace, volumeName: v.volumeName,
        previousReplicas: v.currentReplicas, newReplicas: v.desiredReplicas,
        patched: false, error: null,
      });
      continue;
    }

    const patch: { spec: Record<string, unknown> } = { spec: {} };
    if (replicaDelta) {
      patch.spec.numberOfReplicas = v.desiredReplicas;
    }
    if (wantsSelector) {
      // M-NS-2: pin platform replicas to system-tagged nodes only.
      // Longhorn auto-evicts non-conformant replicas (e.g. one
      // currently on the worker) and rebuilds on a server.
      patch.spec.nodeSelector = ['system'];
    }

    try {
      // Double-cast — see longhorn-reconciler.ts; @kubernetes/client-
      // node v1.4 typings reject the plain literal here.
      await k8s.custom.patchNamespacedCustomObject({
        group: 'longhorn.io', version: 'v1beta2',
        namespace: 'longhorn-system', plural: 'volumes',
        name: v.volumeName, body: patch,
      } as unknown as Parameters<typeof k8s.custom.patchNamespacedCustomObject>[0], MERGE_PATCH);
      results.push({
        namespace: v.namespace, volumeName: v.volumeName,
        previousReplicas: v.currentReplicas, newReplicas: v.desiredReplicas,
        patched: true, error: null,
      });
    } catch (err) {
      results.push({
        namespace: v.namespace, volumeName: v.volumeName,
        previousReplicas: v.currentReplicas, newReplicas: v.desiredReplicas,
        patched: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

/**
 * Read .spec.nodeSelector for each platform volume. Returns a map of
 * name → tag list (empty array when the field is unset). Uses a single
 * LIST call and filters in-process — one round-trip regardless of how
 * many volumes there are. RBAC for `longhorn.io/volumes get,list,watch`
 * already exists.
 */
async function readLiveNodeSelectors(
  k8s: K8sClients,
  volumeNames: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const wanted = new Set(volumeNames);
  try {
    interface LhVolume {
      metadata?: { name?: string };
      spec?: { nodeSelector?: string[] };
    }
    const res = await k8s.custom.listNamespacedCustomObject({
      group: 'longhorn.io', version: 'v1beta2',
      namespace: 'longhorn-system', plural: 'volumes',
    } as unknown as Parameters<typeof k8s.custom.listNamespacedCustomObject>[0]) as { items?: LhVolume[] };
    for (const v of res.items ?? []) {
      const name = v.metadata?.name;
      if (!name || !wanted.has(name)) continue;
      const selector = Array.isArray(v.spec?.nodeSelector) ? [...v.spec.nodeSelector] : [];
      out.set(name, selector);
    }
  } catch (err) {
    console.warn('[platform-storage-policy] list volumes for nodeSelector read failed:', (err as Error).message);
  }
  // Volumes the LIST didn't return get an empty selector — the
  // subsequent patch loop will still fire and add ["system"] if needed.
  for (const name of volumeNames) {
    if (!out.has(name)) out.set(name, []);
  }
  return out;
}

// Generic scale-loop helper: reads each Deployment's current replicas,
// scales via the /scale subresource if it differs from `desired`, and
// reports per-deployment outcomes. Used by both the stateless tier
// (admin/client/platform-api/oauth2-proxy/dex + mail) and the
// leader-elect tier (cert-manager + Flux + sealed-secrets +
// snapshot-controller + CNPG operator).
//
// /scale is HPAs' subresource — it has its own field manager rules so
// Flux SSA on the parent Deployment .spec.replicas can't fight with us.
// A normal MERGE_PATCH on .spec.replicas would lose on every reconcile.
async function patchDeploymentsToReplicaCount(
  k8s: K8sClients,
  deployments: ReadonlyArray<{ namespace: string; name: string }>,
  desired: number,
): Promise<DeploymentPatchResult[]> {
  const results: DeploymentPatchResult[] = [];
  for (const d of deployments) {
    let previousReplicas = 0;
    try {
      const live = await k8s.apps.readNamespacedDeployment({ namespace: d.namespace, name: d.name });
      previousReplicas = live.spec?.replicas ?? 0;
      if (previousReplicas === desired) {
        results.push({
          namespace: d.namespace, name: d.name,
          previousReplicas, newReplicas: desired,
          patched: false, error: null,
        });
        continue;
      }
      await k8s.apps.replaceNamespacedDeploymentScale({
        namespace: d.namespace, name: d.name,
        body: {
          metadata: { name: d.name, namespace: d.namespace },
          spec: { replicas: desired },
        },
      } as unknown as Parameters<typeof k8s.apps.replaceNamespacedDeploymentScale>[0]);
      results.push({
        namespace: d.namespace, name: d.name,
        previousReplicas, newReplicas: desired,
        patched: true, error: null,
      });
    } catch (err) {
      results.push({
        namespace: d.namespace, name: d.name,
        previousReplicas, newReplicas: desired,
        patched: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

async function patchStatelessDeployments(
  k8s: K8sClients,
  tier: 'local' | 'ha',
  readyServerCount: number,
): Promise<DeploymentPatchResult[]> {
  const desired = deploymentReplicasForSystemTier(tier, readyServerCount);
  // topologySpread lives in .spec.template.spec.topologySpreadConstraints
  // — that IS managed by Flux SSA. We don't patch it imperatively
  // (would get reverted). Operators who want HA topology spread set it
  // in the manifest (DoNotSchedule per the 2026-05-11 convention).
  return patchDeploymentsToReplicaCount(k8s, STATELESS_DEPLOYMENTS, desired);
}

async function patchLeaderElectDeployments(
  k8s: K8sClients,
  tier: 'local' | 'ha',
  readyServerCount: number,
): Promise<DeploymentPatchResult[]> {
  const desired = leaderElectReplicasForSystemTier(tier, readyServerCount);
  return patchDeploymentsToReplicaCount(k8s, LEADER_ELECT_DEPLOYMENTS, desired);
}

/**
 * Parse a Kubernetes resource quantity string like "10Gi", "500Mi",
 * "1G", "1024" into bytes. Supports binary (Ki/Mi/Gi/Ti) and decimal
 * (k/M/G/T) suffixes. Defaults to bytes if no suffix.
 */
export function parseSizeToBytes(s: string): number {
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([KMGTP]i?)?$/);
  if (!m) return 0;
  const num = parseFloat(m[1]);
  const unit = m[2] ?? '';
  const multipliers: Record<string, number> = {
    '': 1,
    'K': 1000, 'M': 1000 ** 2, 'G': 1000 ** 3, 'T': 1000 ** 4, 'P': 1000 ** 5,
    'Ki': 1024, 'Mi': 1024 ** 2, 'Gi': 1024 ** 3, 'Ti': 1024 ** 4, 'Pi': 1024 ** 5,
  };
  return Math.ceil(num * (multipliers[unit] ?? 1));
}

/**
 * Capacity precheck for CNPG instance scale-up.
 *
 * Verifies that adding (target - current) instances, each requiring
 * `sizeBytes` of storage on a system-tagged Longhorn node, can fit
 * the per-node free-to-schedule budget. Returns the worst-case
 * deficit so the operator's Apply HA dialog can show actionable
 * remediation ("free 8 GB on staging1 OR add a server node").
 *
 * Design: even with longhorn-system-local SC (replicas=1), each new
 * instance's PVC needs >= sizeBytes free on at least one tag=system
 * node. We check the K best-fit nodes can each take an instance.
 */
interface CapacityPrecheckResult {
  readonly ok: boolean;
  readonly required: { addedInstances: number; sizeBytesPer: number };
  readonly perNode: ReadonlyArray<{ name: string; freeBytes: number; canFit: boolean }>;
  readonly fittingNodes: number;
  readonly reason?: string;
}

async function precheckCapacityForInstances(
  k8s: K8sClients,
  addedInstances: number,
  sizeBytesPer: number,
): Promise<CapacityPrecheckResult> {
  if (addedInstances <= 0) {
    return {
      ok: true,
      required: { addedInstances: 0, sizeBytesPer },
      perNode: [], fittingNodes: 0,
    };
  }
  interface LhDiskSpec { allowScheduling?: boolean; storageReserved?: number }
  interface LhDiskStatus { storageMaximum?: number; storageScheduled?: number }
  interface LhNode {
    metadata?: { name?: string };
    spec?: { tags?: string[]; allowScheduling?: boolean; disks?: Record<string, LhDiskSpec> };
    status?: { diskStatus?: Record<string, LhDiskStatus> };
  }
  let lhResp: { items?: LhNode[] };
  try {
    lhResp = await k8s.custom.listNamespacedCustomObject({
      group: 'longhorn.io', version: 'v1beta2',
      namespace: 'longhorn-system', plural: 'nodes',
    } as unknown as Parameters<typeof k8s.custom.listNamespacedCustomObject>[0]) as { items?: LhNode[] };
  } catch (err) {
    // Longhorn unavailable — fail open; CNPG provisioner will surface
    // the issue itself. The reconciler's notification path catches it
    // after the fact.
    return {
      ok: true,
      required: { addedInstances, sizeBytesPer },
      perNode: [], fittingNodes: 0,
      reason: `longhorn unavailable: ${(err as Error).message}; precheck skipped`,
    };
  }
  const perNode: Array<{ name: string; freeBytes: number; canFit: boolean }> = [];
  for (const lhNode of lhResp.items ?? []) {
    const name = lhNode.metadata?.name;
    if (!name) continue;
    if (lhNode.spec?.allowScheduling === false) continue;
    // System-tagged only — that's where CNPG PVCs land via the
    // longhorn-system-local SC's nodeSelector.
    if (!(lhNode.spec?.tags ?? []).includes('system')) continue;
    let freeBytes = 0;
    for (const [diskKey, diskSpec] of Object.entries(lhNode.spec?.disks ?? {})) {
      if (diskSpec.allowScheduling === false) continue;
      const stat = lhNode.status?.diskStatus?.[diskKey] ?? {};
      const max = stat.storageMaximum ?? 0;
      const sched = stat.storageScheduled ?? 0;
      const reserved = diskSpec.storageReserved ?? 0;
      freeBytes += Math.max(0, max - sched - reserved);
    }
    perNode.push({ name, freeBytes, canFit: freeBytes >= sizeBytesPer });
  }
  // Each of the new instances will have its OWN PVC with replicas=1
  // (CNPG_DESIRED_REPLICAS) — and CNPG anti-affinity steers each
  // instance onto a distinct server. So we need (addedInstances)
  // DISTINCT system nodes with freeBytes >= sizeBytesPer.
  const fittingNodes = perNode.filter((n) => n.canFit).length;
  const ok = fittingNodes >= addedInstances;
  return {
    ok,
    required: { addedInstances, sizeBytesPer },
    perNode,
    fittingNodes,
    reason: ok ? undefined : `need ${addedInstances} system node(s) with >= ${Math.ceil(sizeBytesPer / 1024 / 1024 / 1024)} GiB free; only ${fittingNodes} qualify`,
  };
}

async function patchCnpgClusters(
  k8s: K8sClients,
  tier: 'local' | 'ha',
  readyServerCount: number,
): Promise<CnpgClusterPatchResult[]> {
  const desired = cnpgInstancesForSystemTier(tier, readyServerCount);
  const results: CnpgClusterPatchResult[] = [];
  for (const c of CNPG_CLUSTERS) {
    let previousInstances = 0;
    try {
      const live = await k8s.custom.getNamespacedCustomObject({
        group: 'postgresql.cnpg.io', version: 'v1',
        namespace: c.namespace, plural: 'clusters', name: c.name,
      }).catch(() => null) as { spec?: { instances?: number; storage?: { size?: string } } } | null;
      if (!live) {
        // CNPG cluster not yet created (manifest still reconciling).
        // Don't fail Apply HA — Flux will reconcile to the correct
        // instance count once the Cluster CR exists.
        results.push({
          namespace: c.namespace, name: c.name,
          previousInstances: 0, newInstances: desired,
          patched: false,
          error: 'cluster CR not found (Flux still reconciling?)',
        });
        continue;
      }
      previousInstances = live.spec?.instances ?? 0;
      if (previousInstances === desired) {
        results.push({
          namespace: c.namespace, name: c.name,
          previousInstances, newInstances: desired,
          patched: false, error: null,
        });
        continue;
      }
      // Capacity precheck — only when SCALING UP. Scaling down doesn't
      // need new storage. Parses sizes like "10Gi", "5Gi", etc.
      const addedInstances = desired - previousInstances;
      if (addedInstances > 0) {
        const sizeStr = live.spec?.storage?.size ?? '10Gi';
        const sizeBytes = parseSizeToBytes(sizeStr);
        const cap = await precheckCapacityForInstances(k8s, addedInstances, sizeBytes);
        if (!cap.ok) {
          const detail = cap.perNode.map((n) => `${n.name}=${(n.freeBytes / 1024 / 1024 / 1024).toFixed(1)}GiB`).join(', ');
          results.push({
            namespace: c.namespace, name: c.name,
            previousInstances, newInstances: desired,
            patched: false,
            error: `INSUFFICIENT_STORAGE: ${cap.reason}. Per-node free: ${detail}. Free up space (delete unused tenants / orphan PVs) or add a server node.`,
          });
          continue;
        }
      }
      const patch = { spec: { instances: desired } };
      await k8s.custom.patchNamespacedCustomObject({
        group: 'postgresql.cnpg.io', version: 'v1',
        namespace: c.namespace, plural: 'clusters',
        name: c.name, body: patch,
      } as unknown as Parameters<typeof k8s.custom.patchNamespacedCustomObject>[0], MERGE_PATCH);
      results.push({
        namespace: c.namespace, name: c.name,
        previousInstances, newInstances: desired,
        patched: true, error: null,
      });
    } catch (err) {
      results.push({
        namespace: c.namespace, name: c.name,
        previousInstances, newInstances: desired,
        patched: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

/**
 * Reconcile the platform-wide Valkey StatefulSet.
 *
 * Two patches in one round:
 *   1. /scale subresource — sets replicas to the tier-driven count.
 *      Same approach as patchStatelessDeployments() to avoid SSA
 *      conflicts with Flux's parent-object reconcile.
 *   2. ConfigMap valkey-config — rewrites the maxmemory directive
 *      in the valkey.conf.tmpl key. Reloader (annotation
 *      reloader.stakater.com/auto: "true" on the StatefulSet) rolls
 *      the pods automatically when the ConfigMap content hash
 *      changes, so the new memory cap takes effect without an
 *      operator-side `kubectl rollout restart`.
 *
 * Returns null if the StatefulSet doesn't exist (fresh install
 * before Flux reconciles base/valkey/, or production overlay
 * doesn't include it). The reconciler should not error in that
 * case — the apply has nothing to do, and Flux will reconcile
 * to the desired state once the manifest exists.
 */
async function patchValkey(
  k8s: K8sClients,
  tier: 'local' | 'ha',
  readyServerCount: number,
): Promise<ValkeyPatchResult | null> {
  const idealReplicas = valkeyReplicasForSystemTier(tier, readyServerCount);
  const desiredMaxMemoryBytes = valkeyMaxMemoryBytesForSystemTier(tier, readyServerCount);
  const desiredMaxMemory = formatValkeyMemoryBytes(desiredMaxMemoryBytes);

  let previousReplicas = 0;
  let previousMaxMemory: string | null = null;

  // Probe the StatefulSet first — if it doesn't exist, return null
  // so the caller treats this as a no-op (e.g. production overlay
  // pending the rollout, or fresh install pre-Flux-reconcile).
  let live: { spec?: { replicas?: number } } | null = null;
  try {
    live = await k8s.apps.readNamespacedStatefulSet({
      namespace: VALKEY_NAMESPACE, name: VALKEY_STATEFULSET,
    }) as unknown as { spec?: { replicas?: number } };
  } catch (err) {
    const status = (err as { code?: number }).code ?? (err as { statusCode?: number }).statusCode;
    if (status === 404) return null;
    return {
      namespace: VALKEY_NAMESPACE,
      statefulSetName: VALKEY_STATEFULSET,
      previousReplicas: 0,
      newReplicas: idealReplicas,
      previousMaxMemory: null,
      newMaxMemory: desiredMaxMemory,
      replicasPatched: false,
      configPatched: false,
      error: `read sts failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  previousReplicas = live?.spec?.replicas ?? 0;

  // Transient-flap guard: under HA tier, never shrink Valkey below
  // the previous count when readyServerCount briefly drops under
  // HA_SERVER_THRESHOLD. A scheduled OS reboot taking 1-2 servers
  // NotReady for a few minutes would otherwise scale 3 → 1 and
  // break Sentinel quorum on the next 5-min advisor tick. Scale-up
  // (idealReplicas > previousReplicas) is unaffected — we only
  // suppress shrink-during-flap.
  const isFlapShrink =
    tier === 'ha'
    && readyServerCount < HA_SERVER_THRESHOLD
    && previousReplicas >= HA_SERVER_THRESHOLD
    && idealReplicas < previousReplicas;
  const desiredReplicas = isFlapShrink ? previousReplicas : idealReplicas;

  // Probe the ConfigMap so we can compare current maxmemory before
  // rewriting it. Avoids touching Reloader's content hash when
  // nothing changed (which would trigger a no-op rolling restart).
  let cm: { data?: Record<string, string> } | null = null;
  try {
    cm = await k8s.core.readNamespacedConfigMap({
      namespace: VALKEY_NAMESPACE, name: VALKEY_CONFIGMAP,
    }) as unknown as { data?: Record<string, string> };
  } catch (err) {
    const status = (err as { code?: number }).code ?? (err as { statusCode?: number }).statusCode;
    if (status !== 404) {
      return {
        namespace: VALKEY_NAMESPACE,
        statefulSetName: VALKEY_STATEFULSET,
        previousReplicas,
        newReplicas: idealReplicas,
        previousMaxMemory: null,
        newMaxMemory: desiredMaxMemory,
        replicasPatched: false,
        configPatched: false,
        error: `read configmap failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  const tmpl = cm?.data?.['valkey.conf.tmpl'] ?? '';
  const maxMemoryLine = tmpl.match(/^\s*maxmemory\s+(\S+)\s*$/m);
  previousMaxMemory = maxMemoryLine ? maxMemoryLine[1] : null;

  let replicasPatched = false;
  let configPatched = false;

  // ── 1. /scale subresource ──────────────────────────────────────
  if (previousReplicas !== desiredReplicas) {
    try {
      await k8s.apps.replaceNamespacedStatefulSetScale({
        namespace: VALKEY_NAMESPACE, name: VALKEY_STATEFULSET,
        body: {
          metadata: { name: VALKEY_STATEFULSET, namespace: VALKEY_NAMESPACE },
          spec: { replicas: desiredReplicas },
        },
      } as unknown as Parameters<typeof k8s.apps.replaceNamespacedStatefulSetScale>[0]);
      replicasPatched = true;
    } catch (err) {
      return {
        namespace: VALKEY_NAMESPACE,
        statefulSetName: VALKEY_STATEFULSET,
        previousReplicas,
        newReplicas: idealReplicas,
        previousMaxMemory,
        newMaxMemory: desiredMaxMemory,
        replicasPatched: false,
        configPatched: false,
        error: `scale failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // ── 2. ConfigMap maxmemory rewrite ─────────────────────────────
  if (previousMaxMemory !== desiredMaxMemory && tmpl) {
    const updatedTmpl = tmpl.replace(
      /^(\s*maxmemory\s+)\S+\s*$/m,
      `$1${desiredMaxMemory}`,
    );
    if (updatedTmpl !== tmpl) {
      try {
        await k8s.core.patchNamespacedConfigMap({
          namespace: VALKEY_NAMESPACE, name: VALKEY_CONFIGMAP,
          body: { data: { 'valkey.conf.tmpl': updatedTmpl } },
        } as unknown as Parameters<typeof k8s.core.patchNamespacedConfigMap>[0], MERGE_PATCH);
        configPatched = true;
      } catch (err) {
        return {
          namespace: VALKEY_NAMESPACE,
          statefulSetName: VALKEY_STATEFULSET,
          previousReplicas,
          newReplicas: idealReplicas,
          previousMaxMemory,
          newMaxMemory: desiredMaxMemory,
          replicasPatched,
          configPatched: false,
          error: `configmap patch failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    } else {
      // Template doesn't match the maxmemory line pattern at all —
      // the regex replace was a no-op. The cap will never apply.
      // Surface this as a structured error rather than silently
      // marking configPatched=false.
      return {
        namespace: VALKEY_NAMESPACE,
        statefulSetName: VALKEY_STATEFULSET,
        previousReplicas,
        newReplicas: desiredReplicas,
        previousMaxMemory,
        newMaxMemory: desiredMaxMemory,
        replicasPatched,
        configPatched: false,
        error: `valkey-config has no recognisable "maxmemory" line — manual review needed (memory cap will not apply)`,
      };
    }
  }

  return {
    namespace: VALKEY_NAMESPACE,
    statefulSetName: VALKEY_STATEFULSET,
    previousReplicas,
    newReplicas: desiredReplicas,
    previousMaxMemory,
    newMaxMemory: desiredMaxMemory,
    replicasPatched,
    configPatched,
    error: null,
  };
}

// Public re-export so the scheduler tick can also call patchValkey
// directly (without going through applyPolicy's full cluster-state
// read). Used by the readyServerCount-change watch path.
export { patchValkey };
