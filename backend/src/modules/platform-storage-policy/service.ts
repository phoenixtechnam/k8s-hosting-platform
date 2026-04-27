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
export const PLATFORM_STATEFULSETS: ReadonlyArray<{ namespace: string; pvcPrefix: string }> = [
  { namespace: 'platform', pvcPrefix: 'data-postgres' },     // data-postgres-0, ...-1, ...
  { namespace: 'mail', pvcPrefix: 'data-stalwart-mail' },    // data-stalwart-mail-0
];

// 1 → "local" tier, 3 → "ha" tier. We use 3 (not 2) for system to
// match the longhorn-system-ha StorageClass — the platform's
// reliability budget justifies the extra replica.
const REPLICAS_FOR: Record<'local' | 'ha', number> = { local: 1, ha: 3 };

// Stateless platform Deployments that scale 2↔3 with the tier.
// Adding topologySpreadConstraints on each scale-up so a 3-replica
// rollout lands one pod per server. List is exhaustive — these are
// every platform-namespace Deployment whose loss would degrade
// admin/client panel function.
const STATELESS_DEPLOYMENTS: ReadonlyArray<{ namespace: string; name: string }> = [
  { namespace: 'platform', name: 'admin-panel' },
  { namespace: 'platform', name: 'client-panel' },
  { namespace: 'platform', name: 'platform-api' },
  { namespace: 'platform', name: 'oauth2-proxy' },
  { namespace: 'platform', name: 'dex' },
];
// Single-server (local) installs default to 1 replica per stateless
// service — pre-HA. Going to 2 on a single node provides no fault
// isolation (both pods on the same node) and only doubles memory + the
// rolling-deploy gap. HA tier (3+ servers) gets 3 because that's the
// only count that survives a node failure DURING a rolling update
// (2 replicas + maxUnavailable=1 + node failure can hit 0).
const DEPLOYMENT_REPLICAS_FOR: Record<'local' | 'ha', number> = { local: 1, ha: 3 };

// CNPG cluster (Postgres). Apply HA flips spec.instances 1↔3 — CNPG
// streams replication from primary, no manual data migration needed.
const CNPG_CLUSTERS: ReadonlyArray<{ namespace: string; name: string }> = [
  { namespace: 'platform', name: 'postgres' },
];
const CNPG_INSTANCES_FOR: Record<'local' | 'ha', number> = { local: 1, ha: 3 };

const SINGLETON_ID = 'singleton';
const HA_SERVER_THRESHOLD = 3;

// topologySpreadConstraints applied to the stateless Deployments
// when scaling to HA. ScheduleAnyway (not DoNotSchedule) so a
// drained node doesn't wedge a pod Pending — small skew during
// recovery is acceptable.
const HA_TOPOLOGY_SPREAD = [
  {
    maxSkew: 1,
    topologyKey: 'kubernetes.io/hostname',
    whenUnsatisfiable: 'ScheduleAnyway',
    labelSelector: { matchLabels: {} as Record<string, string> }, // filled per-deployment
  },
];

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
  const desiredReplicas = REPLICAS_FOR[policy.systemTier];

  // Count Ready server nodes by label
  // (platform.phoenix-host.net/node-role=server) so workers don't
  // bump the recommendation. A 3-server quorum is the threshold.
  const nodes = await k8s.core.listNode();
  let readyServerCount = 0;
  for (const node of nodes.items ?? []) {
    const labels = node.metadata?.labels ?? {};
    const isServer = labels['platform.phoenix-host.net/node-role'] === 'server'
      || (node.spec?.taints ?? []).some((t) => t.key === 'node-role.kubernetes.io/control-plane');
    if (!isServer) continue;
    const ready = (node.status?.conditions ?? []).find((c) => c.type === 'Ready');
    if (ready?.status === 'True') readyServerCount++;
  }
  const totalNodeCount = nodes.items?.length ?? 0;
  const recommendedTier: 'local' | 'ha' = readyServerCount >= HA_SERVER_THRESHOLD ? 'ha' : 'local';

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

export type ApplyPolicyOutcome = {
  volumes: ApplyPatchResult[];
  deployments: DeploymentPatchResult[];
  cnpgClusters: CnpgClusterPatchResult[];
};

// Apply the desired tier to:
//   1) Longhorn volumes (replicas per PVC)
//   2) Stateless platform Deployments (replicas + topologySpread)
//   3) CNPG Cluster (instances)
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
    deployments: await patchStatelessDeployments(k8s, tier),
    cnpgClusters: await patchCnpgClusters(k8s, tier),
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

async function patchStatelessDeployments(
  k8s: K8sClients,
  tier: 'local' | 'ha',
): Promise<DeploymentPatchResult[]> {
  const desired = DEPLOYMENT_REPLICAS_FOR[tier];
  const results: DeploymentPatchResult[] = [];
  for (const d of STATELESS_DEPLOYMENTS) {
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
      // Use the /scale subresource — same path HPAs use. Flux's
      // server-side apply tracks .spec.replicas as a managed field,
      // and a normal MERGE_PATCH from us would lose the war on
      // every reconcile. The /scale subresource has its own field
      // manager rules and reconcile-friendly semantics: setting
      // replicas via /scale doesn't conflict with Flux's SSA on
      // the parent Deployment object.
      await k8s.apps.replaceNamespacedDeploymentScale({
        namespace: d.namespace, name: d.name,
        body: {
          metadata: { name: d.name, namespace: d.namespace },
          spec: { replicas: desired },
        },
      } as unknown as Parameters<typeof k8s.apps.replaceNamespacedDeploymentScale>[0]);
      // topologySpread lives in .spec.template.spec.topologySpread-
      // Constraints — that IS managed by Flux SSA. We don't try to
      // patch it imperatively (would get reverted). Operators who
      // want HA topology spread should set it in the manifest.
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

async function patchCnpgClusters(
  k8s: K8sClients,
  tier: 'local' | 'ha',
): Promise<CnpgClusterPatchResult[]> {
  const desired = CNPG_INSTANCES_FOR[tier];
  const results: CnpgClusterPatchResult[] = [];
  for (const c of CNPG_CLUSTERS) {
    let previousInstances = 0;
    try {
      const live = await k8s.custom.getNamespacedCustomObject({
        group: 'postgresql.cnpg.io', version: 'v1',
        namespace: c.namespace, plural: 'clusters', name: c.name,
      }).catch(() => null) as { spec?: { instances?: number } } | null;
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
