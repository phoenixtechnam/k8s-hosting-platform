/**
 * postgres-objectstore reconciler scheduler (R-X6).
 *
 * Mirrors the shape of `scheduler.ts` for the shim ConfigMap +
 * `webmail-feature-css/scheduler.ts`: setImmediate-then-setInterval,
 * unref() timer, try/catch boundary, never throws into the runner.
 *
 * Default cadence 5 minutes. The reconciler is idempotent — same
 * inputs produce the same apiserver state (CR spec is fully
 * replaced via merge-patch, the Secret data map via JSON-Patch
 * replace).
 */

import type { Logger } from 'pino';

import type { Database } from '../../db/index.js';
import {
  reconcilePostgresObjectStore,
  type PostgresObjectStoreClients,
} from './postgres-objectstore.js';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

export interface PostgresObjectStoreSchedulerHandle {
  readonly stop: () => void;
}

export interface PostgresObjectStoreSchedulerOpts {
  readonly intervalMs?: number;
}

export function startPostgresObjectStoreReconciler(
  db: Database,
  clients: PostgresObjectStoreClients,
  log: Pick<Logger, 'info' | 'warn' | 'error'>,
  opts: PostgresObjectStoreSchedulerOpts = {},
): PostgresObjectStoreSchedulerHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  let cancelled = false;

  const tick = async (): Promise<void> => {
    if (cancelled) return;
    try {
      await reconcilePostgresObjectStore(db, clients, log);
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'postgres-objectstore-scheduler: tick threw',
      );
    }
  };

  setImmediate(tick);

  const timer = setInterval(tick, intervalMs);
  timer.unref();

  log.info(
    { intervalMs },
    'postgres-objectstore-scheduler: started',
  );

  return {
    stop: () => {
      cancelled = true;
      clearInterval(timer);
    },
  };
}
