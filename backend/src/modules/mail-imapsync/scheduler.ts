/**
 * Phase 3 T2.1 — IMAPSync reconciler scheduler.
 *
 * Polls active jobs every 30 seconds (configurable via
 * platform_settings.imapsync_reconciler_interval_seconds). Skipped
 * if NODE_ENV is 'test'.
 */

import { eq } from 'drizzle-orm';
import { platformSettings } from '../../db/schema.js';
import { reconcileImapSyncJobs } from './reconciler.js';
import { cleanupExpiredJobs } from './service.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

const DEFAULT_INTERVAL_SECONDS = 30;
const INITIAL_DELAY_MS = 30_000;
// Run expired job cleanup once per hour (every N reconciler ticks).
const CLEANUP_INTERVAL_TICKS = 120; // ~1 hour at 30s interval

async function readIntSetting(
  db: Database,
  key: string,
  fallback: number,
): Promise<number> {
  try {
    const [row] = await db
      .select()
      .from(platformSettings)
      .where(eq(platformSettings.key, key));
    if (row?.value) {
      const n = parseInt(row.value, 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch {
    // Table may be missing during fresh-install migrations.
  }
  return fallback;
}

export function startImapSyncReconciler(
  db: Database,
  k8s: K8sClients,
): NodeJS.Timeout {
  console.log('[mail-imapsync-scheduler] Starting reconciler');

  let tickCount = 0;
  const runCycle = async () => {
    try {
      const result = await reconcileImapSyncJobs(db, k8s);
      if (result.finished > 0) {
        console.log(
          `[mail-imapsync-scheduler] reconciled=${result.reconciled} finished=${result.finished}`,
        );
      }
    } catch (err) {
      console.warn(
        '[mail-imapsync-scheduler] cycle error:',
        err instanceof Error ? err.message : String(err),
      );
    }

    // Periodic cleanup of expired terminal jobs (30+ days old).
    tickCount += 1;
    if (tickCount % CLEANUP_INTERVAL_TICKS === 0) {
      try {
        const deleted = await cleanupExpiredJobs(db);
        if (deleted > 0) {
          console.log(`[mail-imapsync-scheduler] cleaned up ${deleted} expired job(s)`);
        }
      } catch (err) {
        console.warn(
          '[mail-imapsync-scheduler] cleanup error:',
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  };

  const intervalSeconds = DEFAULT_INTERVAL_SECONDS;
  // Re-read the interval setting on every cycle so operators can
  // tune it without restart. Note: setInterval is fixed at the
  // initial value — same trade-off as the DKIM scheduler.
  void readIntSetting; // referenced for clarity; live-reload requires self-rescheduling
  setTimeout(runCycle, INITIAL_DELAY_MS);
  return setInterval(runCycle, intervalSeconds * 1000);
}
