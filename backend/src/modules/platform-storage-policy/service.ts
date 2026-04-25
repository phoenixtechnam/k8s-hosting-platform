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

const SINGLETON_ID = 'singleton';
const HA_SERVER_THRESHOLD = 3;

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
      volumes.push({
        namespace: sts.namespace,
        pvcName: name,
        volumeName: lhVolName,
        currentReplicas,
        desiredReplicas,
        healthy,
        phase: state,
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

// Walk the per-PVC volumes from readClusterState and patch each
// longhorn.io Volume's .spec.numberOfReplicas to match the policy.
// Idempotent: if currentReplicas already matches desiredReplicas the
// patch is skipped (no-op API call avoided).
export async function applyPolicy(
  k8s: K8sClients,
  db: Database,
): Promise<ApplyPatchResult[]> {
  const state = await readClusterState(k8s, db);
  const results: ApplyPatchResult[] = [];

  for (const v of state.volumes) {
    if (v.currentReplicas === v.desiredReplicas) {
      results.push({
        namespace: v.namespace,
        volumeName: v.volumeName,
        previousReplicas: v.currentReplicas,
        newReplicas: v.desiredReplicas,
        patched: false,
        error: null,
      });
      continue;
    }
    const patch = { spec: { numberOfReplicas: v.desiredReplicas } };
    try {
      // Match the `as unknown as Parameters<...>[0]` double-cast used in
      // longhorn-reconciler.ts — the @kubernetes/client-node v1.4 typing
      // for patchNamespacedCustomObject doesn't accept a plain object
      // literal here. Single-cast compiles by accident and silently
      // narrows; double-cast is the documented escape hatch.
      await k8s.custom.patchNamespacedCustomObject({
        group: 'longhorn.io', version: 'v1beta2',
        namespace: 'longhorn-system', plural: 'volumes',
        name: v.volumeName, body: patch,
      } as unknown as Parameters<typeof k8s.custom.patchNamespacedCustomObject>[0], MERGE_PATCH);
      results.push({
        namespace: v.namespace,
        volumeName: v.volumeName,
        previousReplicas: v.currentReplicas,
        newReplicas: v.desiredReplicas,
        patched: true,
        error: null,
      });
    } catch (err) {
      results.push({
        namespace: v.namespace,
        volumeName: v.volumeName,
        previousReplicas: v.currentReplicas,
        newReplicas: v.desiredReplicas,
        patched: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}
