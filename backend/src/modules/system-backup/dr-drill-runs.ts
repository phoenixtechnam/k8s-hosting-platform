/**
 * DR drill runs CRUD + summary (DR-bundle roadmap, Phase 1).
 *
 * CI (the GitHub Actions workflow at `.github/workflows/dr-drill.yml`)
 * posts to `POST /admin/system-backup/dr-drill/runs` to record each
 * drill execution. The admin DR Drill tab reads history via
 * `GET .../runs` and a small summary via `GET .../runs/summary`.
 *
 * The webhook auth is the same super_admin gate as the rest of the
 * system-backup routes — CI uses a long-lived JWT minted for a
 * dedicated service account. No new auth surface.
 *
 * Persistence keeps the last N runs (no automatic prune yet — drill
 * is weekly, ~50 rows/year — sweeper can prune later if needed).
 */

import { desc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  type DrDrillRun,
  type DrDrillSummary,
  type RecordDrDrillRunRequest,
} from '@k8s-hosting/api-contracts';
import { drDrillRuns, type DrDrillRunRow } from '../../db/schema.js';

const MAX_LIST_ROWS = 12;

/** Insert or update a drill run by id. CI may call this twice for the
 *  same id (once at start with status=running, once at finish). */
export async function recordDrDrillRun(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>,
  input: RecordDrDrillRunRequest,
): Promise<DrDrillRun> {
  await db
    .insert(drDrillRuns)
    .values({
      id: input.id,
      startedAt: new Date(input.startedAt),
      finishedAt: input.finishedAt ? new Date(input.finishedAt) : null,
      status: input.status,
      trigger: input.trigger,
      sourceBundleSha256: input.sourceBundleSha256,
      secretsRestoredCount: input.secretsRestoredCount,
      bundleSizeBytes: input.bundleSizeBytes,
      durationSeconds: input.durationSeconds,
      failureReason: input.failureReason,
      report: input.report,
      runner: input.runner,
    })
    .onConflictDoUpdate({
      target: drDrillRuns.id,
      set: {
        finishedAt: input.finishedAt ? new Date(input.finishedAt) : null,
        status: input.status,
        sourceBundleSha256: input.sourceBundleSha256,
        secretsRestoredCount: input.secretsRestoredCount,
        bundleSizeBytes: input.bundleSizeBytes,
        durationSeconds: input.durationSeconds,
        failureReason: input.failureReason,
        report: input.report,
      },
    });

  const [row] = await db
    .select()
    .from(drDrillRuns)
    .where(eq(drDrillRuns.id, input.id))
    .limit(1);
  if (!row) throw new Error(`recordDrDrillRun: row ${input.id} disappeared after upsert`);
  return rowToContract(row);
}

/** Most recent N drill runs, newest first. */
export async function listDrDrillRuns(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>,
  limit = MAX_LIST_ROWS,
): Promise<DrDrillRun[]> {
  const rows = await db
    .select()
    .from(drDrillRuns)
    .orderBy(desc(drDrillRuns.startedAt))
    .limit(Math.min(Math.max(limit, 1), 100));
  return rows.map(rowToContract);
}

/** Aggregate health used by the admin UI banner + chip colour. */
export async function getDrDrillSummary(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>,
): Promise<DrDrillSummary> {
  const rows = await db
    .select()
    .from(drDrillRuns)
    .orderBy(desc(drDrillRuns.startedAt))
    .limit(MAX_LIST_ROWS);

  let lastSuccessAt: string | null = null;
  let lastFailureAt: string | null = null;
  let consecutiveSuccessCount = 0;
  let consecutiveFailureCount = 0;
  let consecutiveStarted = false;
  let consecutiveLastStatus: 'success' | 'failed' | null = null;
  // streakFrozen flips true the moment the leading-streak type changes.
  // After that we keep iterating only to find lastSuccessAt /
  // lastFailureAt, but never increment the streak counters again
  // (the earlier sentinel approach was buggy — a later row matching
  // the sentinel value would resume the count and overstate the
  // streak).
  let streakFrozen = false;

  let successInWindow = 0;
  let finishedInWindow = 0;
  for (const row of rows) {
    if (row.status === 'success' && lastSuccessAt === null) {
      lastSuccessAt = toIso(row.startedAt);
    }
    if (row.status === 'failed' && lastFailureAt === null) {
      lastFailureAt = toIso(row.startedAt);
    }
    if (row.status === 'success' || row.status === 'failed') {
      finishedInWindow++;
      if (row.status === 'success') successInWindow++;
      // Consecutive streak from the most-recent terminal row backwards.
      if (!consecutiveStarted) {
        consecutiveStarted = true;
        consecutiveLastStatus = row.status;
        if (row.status === 'success') consecutiveSuccessCount = 1;
        else consecutiveFailureCount = 1;
      } else if (!streakFrozen && row.status === consecutiveLastStatus) {
        if (row.status === 'success') consecutiveSuccessCount++;
        else consecutiveFailureCount++;
      } else {
        streakFrozen = true;
      }
    }
  }
  const rollingPassRate = finishedInWindow > 0 ? successInWindow / finishedInWindow : 0;
  return {
    lastSuccessAt,
    lastFailureAt,
    consecutiveSuccessCount,
    consecutiveFailureCount,
    rollingPassRate,
  };
}

function toIso(d: Date | string | null): string | null {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString();
  return new Date(d).toISOString();
}

function rowToContract(row: DrDrillRunRow): DrDrillRun {
  return {
    id: row.id,
    startedAt: toIso(row.startedAt)!,
    finishedAt: toIso(row.finishedAt),
    status: row.status as DrDrillRun['status'],
    trigger: row.trigger as DrDrillRun['trigger'],
    sourceBundleSha256: row.sourceBundleSha256,
    secretsRestoredCount: row.secretsRestoredCount,
    bundleSizeBytes: row.bundleSizeBytes,
    durationSeconds: row.durationSeconds,
    failureReason: row.failureReason,
    // `report` is JSONB in PG; Drizzle returns `unknown` for unconstrained
    // jsonb columns. We don't re-validate via Zod here — the writer
    // (recordDrDrillRun) only accepts schema-validated input. If a
    // future direct-DB writer bypasses that, we'd add Zod re-validation.
    report: row.report as DrDrillRun['report'],
    runner: row.runner,
  };
}

/** Test-only — used by the integration harness to reset state between cases. */
export async function _truncateDrDrillRunsForTests(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>,
): Promise<void> {
  await db.execute(sql`TRUNCATE TABLE dr_drill_runs`);
}
