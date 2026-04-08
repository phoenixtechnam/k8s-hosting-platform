import { eq } from 'drizzle-orm';
import { platformSettings } from '../../db/schema.js';
import {
  autoRotatePrimaryDomains,
  retireOldKeys,
  purgeRetiredKeys,
} from './service.js';
import type { Database } from '../../db/index.js';

/**
 * Phase 3 T1.1 — DKIM key rotation scheduler.
 *
 * Runs once per cycle:
 *   1. autoRotatePrimaryDomains — generate a new key for any
 *      primary-mode email domain whose newest active key is older
 *      than `dkim_rotation_age_days` (default 90).
 *   2. retireOldKeys           — transition active keys older than
 *      `dkim_grace_days` (default 7) to retired, provided the
 *      domain still has at least one other active key.
 *   3. purgeRetiredKeys        — delete retired rows older than
 *      `dkim_retention_days` (default 30).
 *
 * Only primary-mode domains are auto-rotated. cname/secondary mode
 * domains stay pending until the admin activates manually via the
 * API — the platform cannot publish to an external DNS provider it
 * does not control.
 *
 * The cycle interval is controlled by `dkim_scheduler_interval_hours`
 * (default 6). The operator can reduce this during testing and bump
 * it back up in production.
 */

const DEFAULT_INTERVAL_HOURS = 6;
const INITIAL_DELAY_MS = 120_000; // 2 minutes after startup

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
    // Table may not exist yet during migrations — fall back silently.
  }
  return fallback;
}

export function startDkimScheduler(
  db: Database,
  encryptionKey: string,
): NodeJS.Timeout {
  console.log('[email-dkim-scheduler] Starting DKIM rotation scheduler');

  let intervalHours = DEFAULT_INTERVAL_HOURS;

  const runCycle = async () => {
    try {
      intervalHours = await readIntSetting(
        db,
        'dkim_scheduler_interval_hours',
        DEFAULT_INTERVAL_HOURS,
      );
      const rotationAgeDays = await readIntSetting(
        db,
        'dkim_rotation_age_days',
        90,
      );
      const graceDays = await readIntSetting(db, 'dkim_grace_days', 7);
      const retentionDays = await readIntSetting(db, 'dkim_retention_days', 30);

      const rot = await autoRotatePrimaryDomains(db, encryptionKey, {
        rotationAgeDays,
      });
      console.log(
        `[email-dkim-scheduler] Rotation scan: rotated=${rot.rotated} errors=${rot.errors}`,
      );

      const ret = await retireOldKeys(db, { graceDays });
      if (ret.retired > 0) {
        console.log(`[email-dkim-scheduler] Retired ${ret.retired} old keys`);
      }

      const pur = await purgeRetiredKeys(db, { retentionDays });
      if (pur.purged > 0) {
        console.log(`[email-dkim-scheduler] Purged ${pur.purged} retired keys`);
      }
    } catch (err) {
      console.warn(
        '[email-dkim-scheduler] Cycle error:',
        err instanceof Error ? err.message : String(err),
      );
    }
  };

  setTimeout(runCycle, INITIAL_DELAY_MS);
  return setInterval(runCycle, intervalHours * 60 * 60 * 1000);
}
