import { eq, inArray } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { notifications, users, platformStoragePolicy } from '../../db/schema.js';
import { getPolicy, readClusterState } from './service.js';

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
      // Three-way short-circuit: tier already ha, operator pinned local,
      // or already notified — nothing to do.
      if (policy.systemTier === 'ha' || policy.pinnedByAdmin || policy.haRecommendationNotifiedAt) {
        if (!stopped) timer = setTimeout(tick, TICK_MS);
        return;
      }
      const state = await readClusterState(k8s, db);
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
      const message = `Cluster has ${state.readyServerCount} Ready servers — switch platform-storage tier to HA (3 replicas) on the Storage Settings page so the postgres + stalwart-mail volumes survive a single-node outage.`;
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
