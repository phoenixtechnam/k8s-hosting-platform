import { platformSettings } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { reconcileMailboxUsage } from './service.js';
import type { Database } from '../../db/index.js';

const DEFAULT_INTERVAL_MINUTES = 15;
const INITIAL_DELAY_MS = 60_000; // Wait 1 minute after startup before first run

/**
 * Phase 3.D.2 — mailbox used_mb reconciliation scheduler.
 *
 * Runs reconcileMailboxUsage() on a configurable interval. The
 * default is 15 minutes; override via platform_settings key
 * `mailbox_usage_sync_interval_minutes` (read once on each cycle so
 * admins can change it without restarting the backend).
 *
 * The user asked specifically that this NOT run too often, hence the
 * 15-minute default and configurable knob.
 */
export function startMailStatsScheduler(db: Database): NodeJS.Timeout {
  console.log('[mail-stats-scheduler] Starting mailbox usage reconciler');

  let intervalMinutes = DEFAULT_INTERVAL_MINUTES;

  const runCycle = async () => {
    try {
      // Re-read interval setting each cycle
      const [row] = await db
        .select()
        .from(platformSettings)
        .where(eq(platformSettings.key, 'mailbox_usage_sync_interval_minutes'));
      if (row?.value) {
        const parsed = parseInt(row.value, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          intervalMinutes = parsed;
        }
      }

      const result = await reconcileMailboxUsage(db);
      console.log(
        `[mail-stats-scheduler] Usage sync complete: synced=${result.synced} failed=${result.failed}`,
      );
    } catch (err) {
      console.warn(
        '[mail-stats-scheduler] Cycle error:',
        err instanceof Error ? err.message : String(err),
      );
    }
  };

  // Delayed first run so the app is fully started
  setTimeout(runCycle, INITIAL_DELAY_MS);

  // Re-schedule every interval. Using setInterval with a fixed window
  // is fine because the reconciler already handles per-mailbox errors.
  return setInterval(runCycle, intervalMinutes * 60 * 1000);
}
