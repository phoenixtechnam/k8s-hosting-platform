// Top-bar Task Tracker — write helper.
//
// Surfaces call `start / progress / finish` at lifecycle boundaries; this
// module is the only place that writes to the `tasks` table. Per
// migration 0090, ON CONFLICT (kind, ref_id) DO UPDATE makes start()
// idempotent: re-invocations from a retry path return the existing row
// id instead of creating a duplicate.
//
// Visibility model:
//   * scope='admin'   + user_id NOT NULL → that admin's chip
//   * scope='client'  + user_id NOT NULL → that client user's chip
//   * scope='system'  + user_id NULL     → bell + global system view only
//
// Cron-emitted tasks (scope='system') do NOT appear in any user's chip.
// On failure they land in `notifications` for the bell, per the UX
// agreement (chip = my actions; bell = passive arrival).

import { eq, and, sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import { tasks } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import {
  type SafeText,
  type TaskKind,
  type TaskRow,
  type TaskScope,
  type TaskStatus,
  type TaskTarget,
  taskRowSchema,
} from '@k8s-hosting/api-contracts';

// ─── start ───────────────────────────────────────────────────────────────

export interface TaskStartArgs {
  readonly kind: TaskKind | (string & {});
  /**
   * Natural id of the underlying op (e.g., `client_lifecycle_transitions.id`).
   * When set, ON CONFLICT (kind, ref_id) DO UPDATE makes this idempotent.
   */
  readonly refId?: string | null;
  readonly scope: TaskScope;
  /** Initiator user id. Must be NULL when scope='system'. */
  readonly userId: string | null;
  /** Tenant scope for RBAC — set when the task is per-client. */
  readonly clientId?: string | null;
  readonly label: SafeText;
  /** Click-action contract: opens a modal or navigates a route. */
  readonly target: TaskTarget;
  /** Optional initial progress (0..100). */
  readonly progressPct?: number | null;
  /** Optional initial human-readable status text. */
  readonly progressText?: SafeText | null;
  /** Per-kind opaque blob (NEVER secrets). */
  readonly details?: Record<string, unknown> | null;
  /** When set, this task is a child of a fan-out parent. */
  readonly parentTaskId?: string | null;
}

export interface TaskStartResult {
  readonly id: string;
  /** True when an existing row was returned by the idempotency clause. */
  readonly idempotent: boolean;
}

export async function start(db: Database, args: TaskStartArgs): Promise<TaskStartResult> {
  if (args.scope === 'system' && args.userId !== null) {
    throw new Error('tasks.start: scope=system requires user_id=null');
  }
  if (args.scope !== 'system' && !args.userId) {
    throw new Error(`tasks.start: scope=${args.scope} requires user_id`);
  }

  const id = crypto.randomUUID();
  const status: TaskStatus = 'running';
  const refId = args.refId ?? null;

  // Idempotency path: when refId is set, the partial unique index
  // (kind, ref_id) WHERE ref_id IS NOT NULL lets us UPSERT. When refId
  // is NULL, every start() is a fresh row (intended).
  if (refId !== null) {
    const rows = await db
      .insert(tasks)
      .values({
        id,
        kind: args.kind,
        refId,
        scope: args.scope,
        userId: args.userId ?? null,
        clientId: args.clientId ?? null,
        label: args.label,
        status,
        progressPct: args.progressPct ?? null,
        progressText: args.progressText ?? null,
        target: args.target as Record<string, unknown>,
        details: args.details ?? null,
        parentTaskId: args.parentTaskId ?? null,
      })
      .onConflictDoUpdate({
        target: [tasks.kind, tasks.refId],
        // Refresh updated_at so the SSE delta fires; preserve the row id.
        // Don't trample status/finished_at if the previous row was
        // already terminal — surfaces shouldn't restart a finished task
        // through the same refId, but if they do, treat it as a re-run
        // and reset status to running.
        //
        // INTENTIONALLY OMITTED: `parentTaskId`, `userId`, `scope`,
        // `clientId`. These are set on INSERT and treated as immutable
        // for the row's lifetime. A re-`start` against the same refId
        // never re-parents the row or reassigns ownership — that would
        // break the chip's fan-out fold + RBAC scoping. Surfaces that
        // need to associate a row with a different parent must use a
        // different refId.
        set: {
          status,
          label: args.label,
          target: args.target as Record<string, unknown>,
          progressPct: args.progressPct ?? null,
          progressText: args.progressText ?? null,
          finishedAt: null,
          errorMessage: null,
          updatedAt: sql`NOW()`,
        },
      })
      .returning({ id: tasks.id });

    if (rows.length === 0) {
      // Should never happen — INSERT … ON CONFLICT DO UPDATE always
      // returns the row. Defensive throw to surface a schema regression.
      throw new Error('tasks.start: upsert returned no rows');
    }
    return { id: rows[0].id, idempotent: rows[0].id !== id };
  }

  await db.insert(tasks).values({
    id,
    kind: args.kind,
    refId: null,
    scope: args.scope,
    userId: args.userId ?? null,
    clientId: args.clientId ?? null,
    label: args.label,
    status,
    progressPct: args.progressPct ?? null,
    progressText: args.progressText ?? null,
    target: args.target as Record<string, unknown>,
    details: args.details ?? null,
    parentTaskId: args.parentTaskId ?? null,
  });
  return { id, idempotent: false };
}

// ─── progress ────────────────────────────────────────────────────────────

export interface TaskProgressArgs {
  readonly pct?: number | null;
  readonly text?: SafeText | null;
  /** Merge-patch into the existing details JSONB. */
  readonly detailsPatch?: Record<string, unknown> | null;
}

export async function progress(db: Database, id: string, args: TaskProgressArgs): Promise<void> {
  const update: Record<string, unknown> = { updatedAt: sql`NOW()` };
  if (args.pct !== undefined) {
    if (args.pct !== null && (args.pct < 0 || args.pct > 100 || !Number.isFinite(args.pct))) {
      throw new Error(`tasks.progress: pct must be 0..100 or null, got ${args.pct}`);
    }
    update.progressPct = args.pct;
  }
  if (args.text !== undefined) {
    update.progressText = args.text;
  }
  if (args.detailsPatch !== undefined && args.detailsPatch !== null) {
    // Merge the patch into the existing JSONB. Use the pg jsonb || op
    // for an in-place merge so we don't have to read-then-write.
    update.details = sql`COALESCE(${tasks.details}, '{}'::jsonb) || ${JSON.stringify(args.detailsPatch)}::jsonb`;
  }

  await db.update(tasks).set(update).where(eq(tasks.id, id));
}

// ─── finish ──────────────────────────────────────────────────────────────

export interface TaskFinishArgs {
  readonly status: 'succeeded' | 'failed' | 'cancelled';
  readonly error?: string | null;
  /** Final details merge-patch. */
  readonly detailsPatch?: Record<string, unknown> | null;
  /** Final progress text (e.g., "12 / 12"). */
  readonly text?: SafeText | null;
  /**
   * Set `cleared_at = NOW()` atomically with the status flip so the
   * task vanishes from the chip immediately rather than lingering for
   * the 5-min terminal window. Used for failure UX where the surface
   * is a notification (bell), not the chip — keeps the chip focused
   * on in-flight work and removes the dead row the moment we know it
   * failed. See orchestrator `runBundle` finishByRef call.
   */
  readonly clearImmediately?: boolean;
}

/**
 * Finish a task by its underlying op's natural id (`refId`). Lets
 * surfaces that don't keep the task uuid around (most of them — we
 * don't currently round-trip through service.start's return) call
 * `finishByRef('client.transition', transitionId, { status })` without
 * an extra SELECT.
 */
function buildFinishUpdate(args: TaskFinishArgs): Record<string, unknown> {
  const update: Record<string, unknown> = {
    status: args.status,
    finishedAt: sql`NOW()`,
    updatedAt: sql`NOW()`,
    errorMessage: args.error ?? null,
  };
  if (args.text !== undefined) update.progressText = args.text;
  if (args.status === 'succeeded') update.progressPct = 100;
  if (args.detailsPatch !== undefined && args.detailsPatch !== null) {
    update.details = sql`COALESCE(${tasks.details}, '{}'::jsonb) || ${JSON.stringify(args.detailsPatch)}::jsonb`;
  }
  if (args.clearImmediately) update.clearedAt = sql`NOW()`;
  return update;
}

export async function finishByRef(
  db: Database,
  kind: string,
  refId: string,
  args: TaskFinishArgs,
): Promise<void> {
  await db
    .update(tasks)
    .set(buildFinishUpdate(args))
    .where(and(eq(tasks.kind, kind), eq(tasks.refId, refId)));
}

export async function finish(db: Database, id: string, args: TaskFinishArgs): Promise<void> {
  await db.update(tasks).set(buildFinishUpdate(args)).where(eq(tasks.id, id));
}

// ─── tracked() — try/finally sugar ───────────────────────────────────────

/**
 * Wrap a long-running operation so the helper enforces start/finish
 * pairing with proper error handling. Returns the inner function's
 * resolved value; rethrows on failure after marking the task failed.
 *
 *   await tracked(db, { kind, refId, ... }, async (taskId) => {
 *     await tasks.progress(db, taskId, { pct: 33, text: toSafeText('step 1/3') });
 *     ...
 *   });
 */
export async function tracked<T>(
  db: Database,
  startArgs: TaskStartArgs,
  fn: (taskId: string) => Promise<T>,
): Promise<T> {
  const { id } = await start(db, startArgs);
  try {
    const result = await fn(id);
    await finish(db, id, { status: 'succeeded' });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Cap error message at 4 KB to keep payload bounded; the full error
    // is already in request.log.error().
    await finish(db, id, { status: 'failed', error: message.slice(0, 4096) });
    throw err;
  }
}

// ─── reads (snapshot) ────────────────────────────────────────────────────

/**
 * Snapshot for the chip: in-flight + recently terminal (≤ 5 min) + not
 * cleared. Caller must filter by user/client scope before serializing.
 */
export interface SnapshotFilter {
  readonly userId: string;
  readonly clientId?: string | null;
  /** Include `scope='admin'` rows where user_id != filter.userId? Off by default. */
  readonly includeOtherAdmins?: boolean;
  /** Cap on returned rows. Default 100, hard max 100 (enforced by API contract). */
  readonly limit?: number;
  /** When set, only rows with updated_at > since are returned. */
  readonly since?: Date | null;
}

const RECENT_TERMINAL_WINDOW_MS = 5 * 60 * 1000;

export async function snapshot(db: Database, filter: SnapshotFilter): Promise<TaskRow[]> {
  const limit = Math.min(filter.limit ?? 100, 100);
  const sinceClause = filter.since ? sql`AND updated_at > ${filter.since}` : sql``;
  const includeOtherAdmins = filter.includeOtherAdmins ?? false;
  const cutoff = new Date(Date.now() - RECENT_TERMINAL_WINDOW_MS);

  // Single query with WHERE that hits one of the partial indexes from
  // 0090_tasks.sql. We deliberately don't UNION user-scope and
  // admin-broadcast — there's no broadcast in Phase 1; PITR is shown
  // only to its initiator (per UX agreement, easier to expand later).
  // includeOtherAdmins is reserved for a future "system-tasks tray".
  void includeOtherAdmins;

  const rows = await db.execute<{
    id: string;
    kind: string;
    ref_id: string | null;
    scope: string;
    user_id: string | null;
    client_id: string | null;
    label: string;
    status: string;
    progress_pct: number | null;
    progress_text: string | null;
    target: Record<string, unknown>;
    error_message: string | null;
    details: Record<string, unknown> | null;
    started_at: Date;
    updated_at: Date;
    finished_at: Date | null;
    cleared_at: Date | null;
    parent_task_id: string | null;
  }>(sql`
    SELECT id, kind, ref_id, scope, user_id, client_id, label, status,
           progress_pct, progress_text, target, error_message, details,
           started_at, updated_at, finished_at, cleared_at, parent_task_id
      FROM tasks
     WHERE user_id = ${filter.userId}
       AND (
         status IN ('queued','running')
         OR (finished_at IS NOT NULL AND finished_at > ${cutoff} AND cleared_at IS NULL)
       )
       ${sinceClause}
     ORDER BY updated_at DESC
     LIMIT ${limit}
  `);

  const all = (rows.rows ?? rows as unknown as Array<typeof rows extends { rows: infer R } ? R : never>)
    .map(toTaskRow)
    .filter((r): r is TaskRow => r !== null);

  // Fan-out folding: when a parent task is visible in the result, hide
  // its children. The popover can re-fetch children on click via the
  // bulk modal which queries by bulkOpId. This keeps the chip tidy
  // during a 50-client bulk op (1 parent vs. 51 rows).
  const visibleIds = new Set(all.map((t) => t.id));
  return all.filter((t) => !t.parentTaskId || !visibleIds.has(t.parentTaskId));
}

function toTaskRow(row: Record<string, unknown>): TaskRow | null {
  // Drizzle's execute() returns snake-case column keys. Map to camelCase
  // and run through the zod schema to enforce the contract on the way
  // out (cheap insurance against accidental DB drift).
  const candidate = {
    id: row.id,
    kind: row.kind,
    refId: row.ref_id,
    scope: row.scope,
    userId: row.user_id,
    clientId: row.client_id,
    label: row.label,
    status: row.status,
    progressPct: row.progress_pct,
    progressText: row.progress_text,
    target: row.target,
    errorMessage: row.error_message,
    details: row.details,
    startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : row.started_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    finishedAt:
      row.finished_at instanceof Date ? row.finished_at.toISOString() : row.finished_at ?? null,
    clearedAt:
      row.cleared_at instanceof Date ? row.cleared_at.toISOString() : row.cleared_at ?? null,
    parentTaskId: row.parent_task_id,
  };
  const parsed = taskRowSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

// ─── clear ───────────────────────────────────────────────────────────────

export async function clear(db: Database, userId: string, ids?: readonly string[]): Promise<number> {
  if (ids && ids.length > 0) {
    const result = await db
      .update(tasks)
      .set({ clearedAt: sql`NOW()` })
      .where(
        and(
          eq(tasks.userId, userId),
          // Only terminal rows can be cleared.
          sql`${tasks.status} IN ('succeeded','failed','cancelled')`,
          sql`${tasks.id} = ANY(${ids})`,
        ),
      )
      .returning({ id: tasks.id });
    return result.length;
  }
  // Clear-all-completed
  const result = await db
    .update(tasks)
    .set({ clearedAt: sql`NOW()` })
    .where(
      and(
        eq(tasks.userId, userId),
        sql`${tasks.status} IN ('succeeded','failed','cancelled')`,
        sql`${tasks.clearedAt} IS NULL`,
      ),
    )
    .returning({ id: tasks.id });
  return result.length;
}

// ─── retention / orphan reaper ───────────────────────────────────────────

export interface RetentionResult {
  readonly deletedTerminal: number;
  readonly reapedOrphans: number;
}

const TERMINAL_RETENTION_DAYS = 7;
const ORPHAN_REAP_HOURS = 24;

export async function runRetention(db: Database): Promise<RetentionResult> {
  // 1. Reap orphans first — a stuck running row should land in the
  //    deletion bucket on the next cycle if it's been finished long enough.
  const orphans = await db
    .update(tasks)
    .set({
      status: 'failed',
      finishedAt: sql`NOW()`,
      updatedAt: sql`NOW()`,
      errorMessage: 'Task reaped — no progress in over 24 hours',
    })
    .where(
      and(
        sql`${tasks.status} IN ('queued','running')`,
        sql`${tasks.startedAt} < NOW() - INTERVAL '${sql.raw(String(ORPHAN_REAP_HOURS))} hours'`,
      ),
    )
    .returning({ id: tasks.id });

  // 2. Delete old terminal rows.
  const deleted = await db
    .delete(tasks)
    .where(
      and(
        sql`${tasks.status} IN ('succeeded','failed','cancelled')`,
        sql`${tasks.finishedAt} < NOW() - INTERVAL '${sql.raw(String(TERMINAL_RETENTION_DAYS))} days'`,
      ),
    )
    .returning({ id: tasks.id });

  return { deletedTerminal: deleted.length, reapedOrphans: orphans.length };
}
