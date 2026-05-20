/**
 * cluster-trusted-proxies periodic reconciler.
 *
 * 5-min tick (`unref()`'d timer) that re-converges:
 *   - DB rows (operator + bootstrap)
 *   - ConfigMap `platform/cluster-trusted-proxies`
 *   - Traefik DS args
 *   - admin-panel + tenant-panel pod-template hash annotation
 *
 * The POST / DELETE routes also fire an inline reconcile (not awaited)
 * for instant convergence. The scheduler picks up any failed inline
 * runs on the next tick.
 */
import type * as k8s from '@kubernetes/client-node';
import type { Logger } from 'pino';
import type { Database } from '../../db/index.js';
import {
  reconcileClusterTrustedProxies,
  type ReconcileClients,
} from './reconciler.js';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

export interface SchedulerHandle {
  readonly stop: () => void;
}

export interface SchedulerClients {
  readonly core: k8s.CoreV1Api;
  readonly apps: k8s.AppsV1Api;
}

// Module-level mutual-exclusion gate. The reconciler reads the Traefik
// DS args + JSON-patches by index — two concurrent runs would each
// compute indices from the same snapshot and the second apply would
// target stale positions if the first appended new args. The same gate
// also protects the inline POST/DELETE reconciles in routes.ts via
// `runReconcileExclusive`.
let inflight: Promise<void> | null = null;

export async function runReconcileExclusive(
  db: Database,
  clients: ReconcileClients,
  log: Pick<Logger, 'info' | 'warn' | 'error'>,
): Promise<void> {
  if (inflight) {
    // A reconcile is already running — return immediately. The current
    // run will see whatever DB state exists when it next reads.
    return inflight;
  }
  inflight = (async () => {
    try {
      await reconcileClusterTrustedProxies(db, clients, log);
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function startClusterTrustedProxiesReconciler(
  db: Database,
  clients: SchedulerClients,
  log: Pick<Logger, 'info' | 'warn' | 'error'>,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): SchedulerHandle {
  let cancelled = false;

  const tick = async (): Promise<void> => {
    if (cancelled) return;
    try {
      const reconcileClients: ReconcileClients = {
        core: clients.core,
        apps: clients.apps,
      };
      await runReconcileExclusive(db, reconcileClients, log);
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'cluster-trusted-proxies-scheduler: tick threw',
      );
    }
  };

  setImmediate(tick);

  const timer = setInterval(tick, intervalMs);
  timer.unref();

  log.info(
    { intervalMs },
    'cluster-trusted-proxies-scheduler: started',
  );

  return {
    stop: () => {
      cancelled = true;
      clearInterval(timer);
    },
  };
}
