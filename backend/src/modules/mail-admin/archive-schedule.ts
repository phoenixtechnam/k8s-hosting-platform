/**
 * Mail archive scheduler — fixed-interval cron driver for the orchestrator.
 *
 * Data model in system_settings (0107):
 *   mail_archive_schedule_interval      'off' | 'hourly' | 'daily' | 'weekly'
 *   mail_archive_schedule_hour_utc      0..23 (daily + weekly)
 *   mail_archive_schedule_weekday_utc   0..6 / Sun..Sat (weekly only)
 *   mail_archive_last_scheduled_run_at  timestamptz, null until first fire
 *
 * The tick (`maybeFireArchiveSchedule`) is called every 60s from the
 * in-process timer in app.ts. It:
 *   1. Reads the current schedule config from system_settings.
 *   2. Computes the next-fire-at given config + last-fired-at.
 *   3. If now() >= next-fire-at AND no archive run is currently active,
 *      stamps mail_archive_last_scheduled_run_at = now() FIRST (atomic
 *      "claim"), then calls startMailArchive({ mode: 'no_downtime' }).
 *
 * Manual triggers (operator clicking "Create Archive Now") do NOT
 * update last_scheduled_run_at — keeps the cron cadence honest. Only
 * the scheduler bumps it.
 */
import { eq, sql } from 'drizzle-orm';
import { systemSettings } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import {
  type MailArchiveScheduleResponse,
  type MailArchiveScheduleInterval,
  type MailArchiveScheduleUpdate,
  mailArchiveScheduleResponseSchema,
} from '@k8s-hosting/api-contracts';

const SETTINGS_ID = 'system';

interface ScheduleRow {
  interval: MailArchiveScheduleInterval;
  hourUtc: number;
  weekdayUtc: number;
  lastScheduledRunAt: Date | null;
}

async function readSchedule(db: Database): Promise<ScheduleRow> {
  const [row] = await db
    .select({
      interval: systemSettings.mailArchiveScheduleInterval,
      hourUtc: systemSettings.mailArchiveScheduleHourUtc,
      weekdayUtc: systemSettings.mailArchiveScheduleWeekdayUtc,
      lastScheduledRunAt: systemSettings.mailArchiveLastScheduledRunAt,
    })
    .from(systemSettings)
    .where(eq(systemSettings.id, SETTINGS_ID));
  return {
    interval: (row?.interval ?? 'off') as MailArchiveScheduleInterval,
    hourUtc: row?.hourUtc ?? 2,
    weekdayUtc: row?.weekdayUtc ?? 0,
    lastScheduledRunAt: row?.lastScheduledRunAt ?? null,
  };
}

/**
 * Compute when the scheduler should next fire given the current config
 * and last fire time. All times are UTC.
 *
 * Semantics:
 *   - hourly  → next top-of-hour after lastFire (or now() if no fire)
 *   - daily   → today at hourUtc, or tomorrow if that's already past
 *   - weekly  → this week's weekdayUtc at hourUtc, or +7d if past
 *
 * Returns null when interval='off'.
 */
export function computeNextFireAt(
  row: ScheduleRow,
  now: Date = new Date(),
): Date | null {
  if (row.interval === 'off') return null;

  // For hourly: fire at the next top of hour (or every hour starting
  // from lastScheduledRunAt + 1h, whichever is later).
  if (row.interval === 'hourly') {
    const baseline = row.lastScheduledRunAt ?? new Date(0);
    const earliest = new Date(baseline.getTime() + 60 * 60 * 1000);
    // Round up to top of hour.
    const topOfHour = new Date(Date.UTC(
      earliest.getUTCFullYear(),
      earliest.getUTCMonth(),
      earliest.getUTCDate(),
      earliest.getUTCHours(),
      0, 0, 0,
    ));
    if (topOfHour < earliest) topOfHour.setUTCHours(topOfHour.getUTCHours() + 1);
    // Don't fire in the past — if first run (lastScheduledRunAt=null),
    // we should fire at the NEXT top of hour from now, not 1970-01-01.
    if (topOfHour < now) {
      const next = new Date(Date.UTC(
        now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
        now.getUTCHours() + 1, 0, 0, 0,
      ));
      return next;
    }
    return topOfHour;
  }

  // Daily: today at hourUtc, or tomorrow if past.
  if (row.interval === 'daily') {
    const today = new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
      row.hourUtc, 0, 0, 0,
    ));
    if (row.lastScheduledRunAt && sameUtcDay(row.lastScheduledRunAt, today)) {
      // Already fired today — schedule tomorrow.
      return new Date(today.getTime() + 24 * 60 * 60 * 1000);
    }
    if (today <= now) {
      // The hour has already passed today and we haven't fired yet
      // (maybe scheduler just enabled or operator changed hourUtc to
      // earlier today). Schedule tomorrow rather than firing
      // immediately — operators expect "daily at 02:00 UTC" to mean
      // 02:00 UTC, not "right now because I missed it".
      return new Date(today.getTime() + 24 * 60 * 60 * 1000);
    }
    return today;
  }

  // Weekly: this week's weekdayUtc at hourUtc, or +7d if past.
  if (row.interval === 'weekly') {
    const currentDow = now.getUTCDay(); // 0..6
    let daysAhead = row.weekdayUtc - currentDow;
    if (daysAhead < 0) daysAhead += 7;
    const target = new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysAhead,
      row.hourUtc, 0, 0, 0,
    ));
    if (row.lastScheduledRunAt && sameUtcDay(row.lastScheduledRunAt, target)) {
      return new Date(target.getTime() + 7 * 24 * 60 * 60 * 1000);
    }
    if (target <= now) {
      return new Date(target.getTime() + 7 * 24 * 60 * 60 * 1000);
    }
    return target;
  }

  return null;
}

function sameUtcDay(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear()
    && a.getUTCMonth() === b.getUTCMonth()
    && a.getUTCDate() === b.getUTCDate();
}

// ── Public API: read/write the schedule ──────────────────────────────────────

export async function getMailArchiveSchedule(
  db: Database,
): Promise<MailArchiveScheduleResponse> {
  const row = await readSchedule(db);
  const nextFireAt = computeNextFireAt(row);
  return mailArchiveScheduleResponseSchema.parse({
    interval: row.interval,
    hourUtc: row.hourUtc,
    weekdayUtc: row.weekdayUtc,
    lastScheduledRunAt: row.lastScheduledRunAt?.toISOString() ?? null,
    nextFireAt: nextFireAt?.toISOString() ?? null,
  });
}

export async function updateMailArchiveSchedule(
  update: MailArchiveScheduleUpdate,
  db: Database,
): Promise<MailArchiveScheduleResponse> {
  const setClause: Record<string, unknown> = {
    mailArchiveScheduleInterval: update.interval,
  };
  if (update.hourUtc !== undefined) setClause.mailArchiveScheduleHourUtc = update.hourUtc;
  if (update.weekdayUtc !== undefined) setClause.mailArchiveScheduleWeekdayUtc = update.weekdayUtc;
  await db.update(systemSettings)
    .set(setClause)
    .where(eq(systemSettings.id, SETTINGS_ID));
  return getMailArchiveSchedule(db);
}

// ── In-process scheduler tick ─────────────────────────────────────────────────

/**
 * Called every 60s by the in-process timer wired in app.ts. Fires
 * startMailArchive() if a scheduled run is due and no run is currently
 * active.
 *
 * The DB UPDATE in the "claim" step uses a WHERE clause that ensures
 * only one platform-api replica claims the run, even with 3 replicas
 * all running this tick. The conditional update is atomic in
 * Postgres' REPEATABLE READ default.
 */
export async function maybeFireArchiveSchedule(
  db: Database,
  startArchive: () => Promise<{ runId: string }>,
  logger: { info: (msg: string) => void; warn: (msg: string) => void } = console,
): Promise<{ fired: boolean; runId?: string; reason?: string }> {
  const row = await readSchedule(db);
  if (row.interval === 'off') return { fired: false, reason: 'interval=off' };

  const now = new Date();
  const nextFire = computeNextFireAt(row, now);
  if (!nextFire || nextFire > now) {
    return { fired: false, reason: 'not yet due' };
  }

  // Conditional claim: stamp last_scheduled_run_at ONLY if it hasn't
  // changed since we read it. Atomic via the equality check on the
  // previous value (or NULL → NULL). This prevents two replicas firing
  // the same scheduled run when both poll within the same minute.
  let claimSql;
  if (row.lastScheduledRunAt) {
    claimSql = sql`
      UPDATE system_settings
      SET mail_archive_last_scheduled_run_at = ${now}
      WHERE id = ${SETTINGS_ID}
        AND mail_archive_last_scheduled_run_at = ${row.lastScheduledRunAt}
    `;
  } else {
    claimSql = sql`
      UPDATE system_settings
      SET mail_archive_last_scheduled_run_at = ${now}
      WHERE id = ${SETTINGS_ID}
        AND mail_archive_last_scheduled_run_at IS NULL
    `;
  }
  const claim = await db.execute(claimSql);
  const claimed = (claim as unknown as { rowCount?: number }).rowCount ?? 0;
  if (claimed === 0) {
    return { fired: false, reason: 'another replica claimed the run' };
  }

  // We hold the claim — fire the orchestrator. If startMailArchive
  // throws (e.g. another run is active), roll back the claim so the
  // NEXT tick re-evaluates cleanly.
  try {
    logger.info(`[archive-scheduler] firing scheduled archive (interval=${row.interval})`);
    const result = await startArchive();
    return { fired: true, runId: result.runId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[archive-scheduler] startMailArchive threw: ${msg} — rolling back claim`);
    await db.update(systemSettings)
      .set({ mailArchiveLastScheduledRunAt: row.lastScheduledRunAt })
      .where(eq(systemSettings.id, SETTINGS_ID));
    return { fired: false, reason: `startMailArchive failed: ${msg}` };
  }
}
