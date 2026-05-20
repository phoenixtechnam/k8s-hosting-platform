/**
 * backup-rclone-shim periodic reconciler.
 *
 * Mirrors `startWebmailFeatureCssReconciler`'s pattern:
 *   - Boots immediately via `setImmediate(tick)` so cold-start
 *     convergence shares the same code path as the periodic tick.
 *   - Runs every 5 minutes (`unref()`'d timer so process exit isn't
 *     blocked).
 *   - Errors caught at the boundary; never throws into the
 *     interval-runner.
 *
 * Idempotent: when `inputHash` is unchanged the reconciler refreshes
 * the status ConfigMap's `reconciledAt` and bails before any
 * ConfigMap / Secret / DaemonSet write.
 *
 * Future: the rotation CLI + admin-panel assignment-CRUD endpoints
 * MAY also call `reconcileBackupRcloneShim` inline for instant
 * convergence on user-initiated changes; the periodic scheduler then
 * acts as the drift safety-net.
 */
import type { Logger } from 'pino';

import type { Database } from '../../db/index.js';
import {
  reconcileBackupRcloneShim,
  type ShimReconcileClients,
} from './reconciler.js';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

export interface BackupRcloneShimSchedulerHandle {
  readonly stop: () => void;
}

export interface BackupRcloneShimSchedulerOpts {
  readonly intervalMs?: number;
}

export function startBackupRcloneShimReconciler(
  db: Database,
  clients: ShimReconcileClients,
  encryptionKey: string,
  log: Pick<Logger, 'info' | 'warn' | 'error'>,
  opts: BackupRcloneShimSchedulerOpts = {},
): BackupRcloneShimSchedulerHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  let cancelled = false;

  const tick = async (): Promise<void> => {
    if (cancelled) return;
    try {
      await reconcileBackupRcloneShim(db, clients, encryptionKey, log);
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'backup-rclone-shim-scheduler: tick threw',
      );
    }
  };

  setImmediate(tick);

  const timer = setInterval(tick, intervalMs);
  timer.unref();

  log.info(
    { intervalMs },
    'backup-rclone-shim-scheduler: started',
  );

  return {
    stop: () => {
      cancelled = true;
      clearInterval(timer);
    },
  };
}

// Re-export the reconciler clients type so callers don't need to
// reach into reconciler.ts.
export type { ShimReconcileClients } from './reconciler.js';
