import { eq, inArray } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { notifications, users, platformStoragePolicy } from '../../db/schema.js';
import { getPolicy, readClusterState, applyPolicy } from './service.js';

// M13 Phase 6: emit a one-time admin notification when the cluster
// reaches HA size (>=3 Ready servers) AND policy is still 'local' AND
// the operator hasn't pinned the choice. Persists `ha_recommendation_
// notified_at` so backend restarts don't re-spam.

const TICK_MS = 5 * 60 * 1000;     // every 5 min
const INITIAL_DELAY_MS = 90_000;   // wait past the migration-startup window

export function startStoragePolicyAdvisor(db: Database, k8s: K8sClients): { stop: () => void } {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  console.log('[storage-policy-advisor] starting (5min cadence)');

  const tick = async () => {
    if (stopped) return;
    try {
      const policy = await getPolicy(db);
      const state = await readClusterState(k8s, db);

      // Drift correction: re-apply the current policy to the live
      // cluster every tick. Catches new PVCs (PITR rebuild, fresh
      // CNPG instance), node count changes (HA replica count tracks
      // readyServerCount dynamically), and config drift from manual
      // kubectl edits. Idempotent — patchLonghornVolumes etc. skip
      // when the live state already matches desired. Without this,
      // the cluster only converges when an operator clicks "Apply
      // Tier" in the UI; in practice that means stale state most of
      // the time.
      //
      // Skip volumes that aren't `attached` yet (provisioning,
      // detached for restore, etc.) — patching their replica count
      // mid-rebuild thrashes the reconcile and floods the log with
      // spurious "drift detected" entries until Longhorn converges
      // naturally. Once attached we can safely diff currentReplicas
      // against desiredReplicas.
      const drift = state.volumes.some(
        (v) => v.phase === 'attached' && (v.currentReplicas !== v.desiredReplicas || v.hasOffSystemReplica),
      );
      if (drift) {
        console.log(`[storage-policy-advisor] drift detected — applying ${policy.systemTier} tier`);
        try {
          const outcome = await applyPolicy(k8s, db);
          const patched = outcome.volumes.filter((v) => v.patched).length
            + outcome.deployments.filter((d) => d.patched).length
            + outcome.cnpgClusters.filter((c) => c.patched).length;
          console.log(`[storage-policy-advisor] reconciled ${patched} resource(s)`);
        } catch (err) {
          console.error('[storage-policy-advisor] reconcile failed:', (err as Error).message);
        }
      }

      // Recommendation: notify ONCE when cluster reaches HA size and
      // policy is still local + un-pinned. Three-way short-circuit:
      // tier already ha, operator pinned local, or already notified.
      if (policy.systemTier === 'ha' || policy.pinnedByAdmin || policy.haRecommendationNotifiedAt) {
        if (!stopped) timer = setTimeout(tick, TICK_MS);
        return;
      }
      if (state.recommendedTier !== 'ha') {
        if (!stopped) timer = setTimeout(tick, TICK_MS);
        return;
      }
      // Cluster reached HA size. Stamp first so a process kill / DB
      // hiccup partway through the fan-out doesn't re-spam admins on
      // the next tick. Failure inserts on individual notifications are
      // already each-caught below; if every notification fails the
      // operator can re-trigger via "Apply HA" in the UI anyway.
      await db.update(platformStoragePolicy)
        .set({ haRecommendationNotifiedAt: new Date() })
        .where(eq(platformStoragePolicy.id, 'singleton'));
      const adminRows = await db.select({ id: users.id }).from(users).where(inArray(users.roleName, ['super_admin', 'admin']));
      const message = `Cluster has ${state.readyServerCount} Ready servers — switch platform-storage tier to HA on the Storage Settings page. HA replicates system volumes to every server (4 servers = 4 replicas = 2-failure tolerance).`;
      for (const a of adminRows) {
        await db.insert(notifications).values({
          id: crypto.randomUUID(),
          userId: a.id,
          type: 'warning',
          title: 'Cluster reached HA size — recommend platform-storage HA',
          message,
          resourceType: 'platform_storage_policy',
          resourceId: 'singleton',
        }).catch((err) => {
          console.error('[storage-policy-advisor] notification insert failed:', (err as Error).message);
        });
      }
      console.log(`[storage-policy-advisor] notified ${adminRows.length} admin(s) — recommend HA at ${state.readyServerCount} servers`);
    } catch (err) {
      console.error('[storage-policy-advisor] tick failed:', (err as Error).message);
    }
    if (!stopped) timer = setTimeout(tick, TICK_MS);
  };

  timer = setTimeout(tick, INITIAL_DELAY_MS);
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer); } };
}
