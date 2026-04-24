import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { syncNodesOnce } from './k8s-sync.js';

// Match the cadence described in migration 0046 — operators expect
// `last_seen_at` to lag by at most ~60s from kubectl state. 10s
// initial delay lets platform-api finish startup before hitting the
// API server.
const SYNC_INTERVAL_MS = 60 * 1000;
const INITIAL_DELAY_MS = 10 * 1000;

export function startNodeSyncReconciler(db: Database, k8s: K8sClients): { stop: () => void } {
  console.log('[node-sync] starting reconciler (60s cadence)');

  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      const count = await syncNodesOnce(db, k8s);
      // Quiet on steady-state; only log meaningful changes. The
      // node count rarely changes, so a debug-level log per tick
      // would just be noise.
      if (count === 0) {
        console.warn('[node-sync] 0 nodes returned — API server disconnect?');
      }
    } catch (err) {
      console.error('[node-sync] tick failed:', (err as Error).message);
    }
    if (!stopped) timer = setTimeout(tick, SYNC_INTERVAL_MS);
  };

  timer = setTimeout(tick, INITIAL_DELAY_MS);

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
