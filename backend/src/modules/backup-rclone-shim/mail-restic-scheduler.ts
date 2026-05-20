/**
 * mail-restic via shim reconciler scheduler (R-X8).
 *
 * Same shape as the other -scheduler.ts wrappers — 5-min tick,
 * setImmediate cold-start, try/catch boundary.
 */

import type { Logger } from 'pino';

import type { Database } from '../../db/index.js';
import {
  reconcileMailResticShim,
  type MailResticShimClients,
} from './mail-restic.js';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

export interface MailResticShimSchedulerHandle {
  readonly stop: () => void;
}

export function startMailResticShimReconciler(
  db: Database,
  clients: MailResticShimClients,
  log: Pick<Logger, 'info' | 'warn' | 'error'>,
  opts: { intervalMs?: number } = {},
): MailResticShimSchedulerHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  let cancelled = false;

  const tick = async (): Promise<void> => {
    if (cancelled) return;
    try {
      await reconcileMailResticShim(db, clients, log);
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'mail-restic-shim-scheduler: tick threw',
      );
    }
  };

  setImmediate(tick);
  const timer = setInterval(tick, intervalMs);
  timer.unref();

  log.info({ intervalMs }, 'mail-restic-shim-scheduler: started');

  return {
    stop: () => {
      cancelled = true;
      clearInterval(timer);
    },
  };
}
