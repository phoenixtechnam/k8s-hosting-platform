import { platformSettings } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { reconcileMailboxUsage } from './service.js';
import { checkQuotaThresholds } from './quota-notifications.js';
import type { Database } from '../../db/index.js';

const DEFAULT_INTERVAL_MINUTES = 15;
const INITIAL_DELAY_MS = 60_000; // Wait 1 minute after startup before first run

/**
 * Phase 3.D.2 — mailbox used_mb reconciliation scheduler.
 *
 * Runs reconcileMailboxUsage() on a configurable interval. The
 * default is 15 minutes; override via platform_settings key
 * `mailbox_usage_sync_interval_minutes`. The setting is re-read
 * at the END of each cycle and the next setTimeout is scheduled
 * with the fresh value, so admins can change the interval and
 * the new value takes effect on the NEXT cycle (no restart
 * needed).
 *
 * The user asked specifically that this NOT run too often, hence
 * the 15-minute default and configurable knob.
 *
 * Phase 3 T5.3: after each reconcile, also runs
 * checkQuotaThresholds() so a mailbox crossing 80/90/100% fires
 * exactly one notification per crossing.
 */

interface SchedulerHandle {
  /** Stop the chain. The current pending timeout is cancelled. */
  stop: () => void;
}

const handles = new WeakMap<NodeJS.Timeout, SchedulerHandle>();

export function startMailStatsScheduler(db: Database): NodeJS.Timeout {
  console.log('[mail-stats-scheduler] Starting mailbox usage reconciler');

  // State container so the self-rescheduling chain can be
  // cancelled cleanly via stopMailStatsScheduler.
  const state: {
    pending: NodeJS.Timeout | null;
    stopped: boolean;
  } = { pending: null, stopped: false };

  const readIntervalMinutes = async (): Promise<number> => {
    try {
      const [row] = await db
        .select()
        .from(platformSettings)
        .where(eq(platformSettings.key, 'mailbox_usage_sync_interval_minutes'));
      if (row?.value) {
        const parsed = parseInt(row.value, 10);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
      }
    } catch {
      // Table missing during fresh-install migrations — fall through.
    }
    return DEFAULT_INTERVAL_MINUTES;
  };

  const runCycle = async (): Promise<void> => {
    if (state.stopped) return;
    try {
      const result = await reconcileMailboxUsage(db);
      console.log(
        `[mail-stats-scheduler] Usage sync complete: synced=${result.synced} failed=${result.failed}`,
      );

      // Phase 3 T5.3: after reconciling used_mb, walk the
      // updated mailboxes for newly-crossed quota thresholds.
      // Fires at most one notification per (mailbox, threshold)
      // crossing thanks to the mailbox_quota_events dedupe table.
      try {
        const quota = await checkQuotaThresholds(db);
        if (quota.fired > 0 || quota.cleared > 0) {
          console.log(
            `[mail-stats-scheduler] Quota notifications: fired=${quota.fired} cleared=${quota.cleared} skipped=${quota.skipped}`,
          );
        }
      } catch (err) {
        console.warn(
          '[mail-stats-scheduler] quota check error:',
          err instanceof Error ? err.message : String(err),
        );
      }
    } catch (err) {
      console.warn(
        '[mail-stats-scheduler] Cycle error:',
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      if (!state.stopped) {
        // Self-reschedule using the LATEST setting value so live
        // changes to mailbox_usage_sync_interval_minutes take
        // effect on the next cycle without a backend restart.
        const next = await readIntervalMinutes();
        state.pending = setTimeout(runCycle, next * 60 * 1000);
        // Re-register the latest pending under the original
        // returned handle so stopMailStatsScheduler can find it.
        if (firstHandle) handles.set(firstHandle, controlHandle);
      }
    }
  };

  // Delayed first run so the app is fully started.
  state.pending = setTimeout(runCycle, INITIAL_DELAY_MS);
  const firstHandle = state.pending;

  const controlHandle: SchedulerHandle = {
    stop: () => {
      state.stopped = true;
      if (state.pending) clearTimeout(state.pending);
    },
  };
  handles.set(firstHandle, controlHandle);

  return firstHandle;
}

/**
 * Stop a running mail-stats scheduler started via
 * startMailStatsScheduler. Halts the self-rescheduling chain so
 * graceful shutdown completes cleanly. A bare clearTimeout on the
 * returned handle is NOT enough because the chain re-arms itself.
 */
export function stopMailStatsScheduler(handle: NodeJS.Timeout): void {
  const ctrl = handles.get(handle);
  if (ctrl) {
    ctrl.stop();
    handles.delete(handle);
  } else {
    // Fall back to plain clearTimeout for any caller using the
    // pre-Phase-3 fixed-interval contract.
    clearTimeout(handle);
  }
}
