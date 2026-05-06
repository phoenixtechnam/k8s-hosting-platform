/**
 * System Backup Phase 4b — scheduled pg_dump exports.
 *
 * 5-min tick that:
 *   1. Reads enabled rows from system_pg_dump_schedules where
 *      next_run_at <= now().
 *   2. For each, dispatches a pg-dump Job via the existing
 *      pg-dump-job-spawner (same code path the manual UI uses).
 *   3. Updates last_run_at + last_run_id + next_run_at.
 *
 * Cron is 5-field UNIX style (minute hour dom month dow). We ship a
 * minimal next-fire computer that handles the operator-facing presets
 * exactly and degrades to a 1-hour floor for anything else — good
 * enough for the supported UI + safe against runaway schedules.
 */

import { and, eq, lte, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Database } from '../../db/index.js';
import {
  systemPgDumpSchedules,
  systemBackupRuns,
  auditLogs,
  backupConfigurations,
} from '../../db/schema.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { createPgDumpJob } from './pg-dump-job-spawner.js';
import { getPlatformApiImage } from '../postgres-restore/service.js';

const TICK_INTERVAL_MS = 60_000; // 1 min poll for due schedules
const MIN_INTERVAL_MS  = 60 * 60 * 1000; // 1h floor — protects against runaway

interface Logger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/**
 * Compute the next firing time for a 5-field cron given a base time.
 * Supports the operator-facing presets exactly; falls back to base+1h
 * for unsupported expressions so we never busy-loop.
 */
export function nextFireAt(cron: string, base: Date): Date {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return new Date(base.getTime() + MIN_INTERVAL_MS);
  const [min, hour, dom, mon, dow] = parts;

  const b = new Date(base);
  b.setSeconds(0, 0);

  // Pattern: `*/N * * * *` — every N minutes. Floor of 5 min protects
  // against busy-loop if a future code path bypasses the route's Zod
  // (e.g. a direct SQL insert with `*/1`). The 1-min tick interval
  // wouldn't keep up with sub-5-min dispatches anyway.
  const everyN = /^\*\/(\d+)$/.exec(min);
  if (everyN && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    const n = Math.max(5, parseInt(everyN[1], 10));
    return new Date(b.getTime() + n * 60_000);
  }

  // Pattern: `0 H * * *` — daily at H:00
  if (min === '0' && /^\d+$/.test(hour) && dom === '*' && mon === '*' && dow === '*') {
    const h = parseInt(hour, 10);
    const next = new Date(b);
    next.setHours(h, 0, 0, 0);
    if (next <= b) next.setDate(next.getDate() + 1);
    return next;
  }

  // Pattern: `0 H * * D` — weekly on day-of-week D at H:00
  if (min === '0' && /^\d+$/.test(hour) && dom === '*' && mon === '*' && /^\d+$/.test(dow)) {
    const h = parseInt(hour, 10);
    const targetDow = parseInt(dow, 10) % 7;
    const next = new Date(b);
    next.setHours(h, 0, 0, 0);
    while (next <= b || next.getDay() !== targetDow) {
      next.setDate(next.getDate() + 1);
    }
    return next;
  }

  // Pattern: `0 H D * *` — monthly on day D at H:00
  if (min === '0' && /^\d+$/.test(hour) && /^\d+$/.test(dom) && mon === '*' && dow === '*') {
    const h = parseInt(hour, 10);
    const d = parseInt(dom, 10);
    const next = new Date(b);
    next.setDate(d);
    next.setHours(h, 0, 0, 0);
    if (next <= b) {
      next.setMonth(next.getMonth() + 1);
    }
    return next;
  }

  // Unsupported — refuse to busy-loop.
  return new Date(b.getTime() + MIN_INTERVAL_MS);
}

interface DispatchInputs {
  readonly db: Database;
  readonly k8s: K8sClients;
}

export async function runPgDumpScheduleTick(
  inputs: DispatchInputs, logger: Logger,
): Promise<{ dispatched: number }> {
  const { db, k8s } = inputs;
  const now = new Date();

  // Pick due schedules — single SELECT with a LIMIT so a backed-up
  // queue can't issue dozens of K8s Job creates in one tick.
  const due = await db
    .select()
    .from(systemPgDumpSchedules)
    .where(and(
      eq(systemPgDumpSchedules.enabled, true),
      lte(systemPgDumpSchedules.nextRunAt, now),
    ))
    .limit(10);
  if (due.length === 0) return { dispatched: 0 };

  let dispatched = 0;
  for (const s of due) {
    try {
      // Cross-replica CAS lock: the only way to "claim" this schedule
      // for dispatch on this tick is to atomically advance its
      // next_run_at AND see exactly 1 row affected. With 3 platform-api
      // replicas all running this loop, only one will succeed; the
      // others will get 0 rows back and skip.
      const computedNext = nextFireAt(s.cronSchedule, now);
      const claim = await db
        .update(systemPgDumpSchedules)
        .set({ nextRunAt: computedNext })
        .where(and(
          eq(systemPgDumpSchedules.id, s.id),
          eq(systemPgDumpSchedules.nextRunAt, s.nextRunAt!),
        ))
        .returning({ id: systemPgDumpSchedules.id });
      if (claim.length === 0) {
        // Another replica beat us. Skip silently — they'll dispatch.
        continue;
      }

      // Validate target still active.
      const cfgRows = await db
        .select({
          id: backupConfigurations.id,
          active: backupConfigurations.active,
        })
        .from(backupConfigurations)
        .where(eq(backupConfigurations.id, s.targetConfigId))
        .limit(1);
      if (!cfgRows[0]?.active) {
        logger.warn({ scheduleId: s.id }, '[pg-dump-scheduler] target inactive, skipping');
        continue;
      }

      const runId = randomUUID();
      const image = await getPlatformApiImage(k8s);

      // Insert pending run + audit row in same tx (matches the manual
      // POST route's pattern).
      await db.transaction(async (tx) => {
        await tx.insert(systemBackupRuns).values({
          id: runId,
          kind: 'pg_dump',
          status: 'pending',
          operatorUserId: s.operatorUserId,
          sourceNamespace: s.sourceNamespace,
          sourceCluster:   s.sourceCluster,
          sourceDatabase:  s.sourceDatabase,
          targetConfigId:  s.targetConfigId,
        });
        await tx.insert(auditLogs).values({
          id: randomUUID(),
          actionType: 'system_backup_pg_dump_scheduled',
          resourceType: 'system_backup_run',
          resourceId: runId,
          actorId: s.operatorUserId ?? '',
          actorType: 'user',
          httpMethod: 'CRON',
          httpPath: '/system-pg-dump-scheduler/tick',
          httpStatus: 202,
          changes: { scheduleId: s.id, cron: s.cronSchedule },
          ipAddress: null,
        });
      });

      const job = await createPgDumpJob(k8s, {
        runId,
        namespace: s.sourceNamespace,
        cluster:   s.sourceCluster,
        database:  s.sourceDatabase,
        targetConfigId: s.targetConfigId,
        actorUserId: s.operatorUserId,
        image,
      });

      await db.update(systemBackupRuns)
        .set({ status: 'running', jobName: job.jobName })
        .where(eq(systemBackupRuns.id, runId));

      // next_run_at was already advanced by the CAS claim above — only
      // need to record last_run_at and last_run_id here.
      await db.update(systemPgDumpSchedules)
        .set({ lastRunAt: now, lastRunId: runId })
        .where(eq(systemPgDumpSchedules.id, s.id));
      dispatched += 1;
    } catch (err) {
      logger.error({ err, scheduleId: s.id }, '[pg-dump-scheduler] dispatch failed');
      // Push next run forward so a single failure doesn't busy-loop.
      await db
        .update(systemPgDumpSchedules)
        .set({ nextRunAt: nextFireAt(s.cronSchedule, now) })
        .where(eq(systemPgDumpSchedules.id, s.id))
        .catch(() => undefined);
    }
  }
  return { dispatched };
}

export function startPgDumpScheduler(
  db: Database, k8s: K8sClients, logger: Logger,
): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const r = await runPgDumpScheduleTick({ db, k8s }, logger);
      if (r.dispatched > 0) {
        logger.info({ dispatched: r.dispatched }, '[pg-dump-scheduler] dispatched');
      }
    } catch (err) {
      logger.warn({ err }, '[pg-dump-scheduler] tick failed');
    }
    if (!stopped) timer = setTimeout(tick, TICK_INTERVAL_MS);
  };
  timer = setTimeout(tick, TICK_INTERVAL_MS);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

// Suppress sql import noise — left for future raw-SQL escapes in this module.
void sql;
