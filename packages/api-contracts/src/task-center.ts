// Top-bar Task Tracker — UI-projection of long-running operations.
// Backed by the `tasks` table (migration 0090). The helper module on the
// backend (modules/tasks/) is the only writer; routes here expose:
//   GET    /api/v1/me/tasks               (snapshot — running + recent terminal)
//   GET    /api/v1/me/tasks/stream        (SSE — live deltas via pg_notify)
//   POST   /api/v1/me/tasks/clear         (mark all completed cleared)
//   POST   /api/v1/me/tasks/:id/clear     (mark single task cleared)

import { z } from 'zod';

// ─── Branded SafeText ────────────────────────────────────────────────────
//
// `label`, `progress_text`, and other operator-visible strings must NEVER
// carry secrets. We brand strings produced by `toSafeText()` with a unique
// symbol so the type system rejects raw `string` at write boundaries.
// At runtime, `toSafeText` regex-screens for the obvious tokens; full
// review-time review remains the primary control.

declare const __safeTextBrand: unique symbol;
export type SafeText = string & { readonly [__safeTextBrand]: 'SafeText' };

// Patterns that are obvious "you put a secret in the label" tells.
// Belt-and-braces — type system catches misuse at compile time, regex
// catches obvious mistakes at runtime.
const SAFE_TEXT_FORBIDDEN: readonly RegExp[] = [
  /password\s*[:=]/i,
  /\bsecret\s*[:=]/i,
  /\btoken\s*[:=]/i,
  /\bbearer\s+[a-z0-9._-]{16,}/i,
  /\bapikey\s*[:=]/i,
  /\bauthorization\s*[:=]/i,
  // Obvious bcrypt / JWT shapes.
  /\$2[aby]?\$\d{1,2}\$/,
  /\beyJ[a-zA-Z0-9_-]{10,}\./,
];

/**
 * Brand a string as SafeText after a runtime regex screen. Throws on
 * obvious secret leakage. The check is deliberately conservative — false
 * positives are easy to fix at the call site; false negatives are bad.
 */
export function toSafeText(input: string): SafeText {
  for (const re of SAFE_TEXT_FORBIDDEN) {
    if (re.test(input)) {
      throw new Error(
        `toSafeText: input matched a forbidden pattern (${re}). ` +
        'Task labels must never carry secrets / tokens / passwords.',
      );
    }
  }
  return input as SafeText;
}

// ─── Enums ───────────────────────────────────────────────────────────────

export const taskStatusEnum = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);
export type TaskStatus = z.infer<typeof taskStatusEnum>;

export const taskScopeEnum = z.enum(['admin', 'client', 'system']);
export type TaskScope = z.infer<typeof taskScopeEnum>;

// `kind` is open-ended (any 64-char string) but we maintain a registry
// here so the frontend modal registry can switch on it without per-kind
// magic numbers. Adding a new kind requires a PR touching this file —
// that's the intended friction.
export const TASK_KIND_REGISTRY = [
  'client.suspend.bulk',
  'client.reactivate.bulk',
  'client.delete.bulk',
  'client.transition',
  'client.provision',
  'storage.grow',
  'storage.shrink',
  'storage.snapshot',
  'storage.restore',
  'storage.tier-flip',
  'backup.run',
  'postgres.pitr',
  'dns.verify',
  'mail.rotate',
  'cache.purge',
  'restore.cart',
] as const;
export type TaskKind = (typeof TASK_KIND_REGISTRY)[number];

// ─── Target (click-action contract) ──────────────────────────────────────

export const taskTargetSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('modal'),
    /** Key into the frontend modal registry (frontend/src/tasks/modal-registry.ts). */
    modal: z.string().min(1).max(64),
    /** Props passed to the modal component on click. JSON-serialisable only. */
    modalProps: z.record(z.string(), z.unknown()).default({}),
  }),
  z.object({
    type: z.literal('route'),
    /** Frontend route to navigate to on click (relative path with optional ?query). */
    href: z.string().min(1).max(2000),
  }),
]);
export type TaskTarget = z.infer<typeof taskTargetSchema>;

// ─── Row schema ──────────────────────────────────────────────────────────

export const taskRowSchema = z.object({
  id: z.string().uuid(),
  kind: z.string().min(1).max(64),
  refId: z.string().min(1).max(64).nullable(),
  scope: taskScopeEnum,
  userId: z.string().uuid().nullable(),
  clientId: z.string().uuid().nullable(),
  label: z.string().min(1),
  status: taskStatusEnum,
  progressPct: z.number().int().min(0).max(100).nullable(),
  progressText: z.string().nullable(),
  target: taskTargetSchema,
  errorMessage: z.string().nullable(),
  details: z.record(z.string(), z.unknown()).nullable(),
  startedAt: z.string(),
  updatedAt: z.string(),
  finishedAt: z.string().nullable(),
  clearedAt: z.string().nullable(),
  parentTaskId: z.string().uuid().nullable(),
});
export type TaskRow = z.infer<typeof taskRowSchema>;

// ─── Response envelopes ──────────────────────────────────────────────────

/**
 * GET /api/v1/me/tasks?since=<iso>
 *
 * Returns the chip's working set: in-flight tasks + tasks that finished
 * recently (≤ 5 min) and are not yet cleared. The `since` cursor is
 * optional; when provided, only rows updated after that timestamp are
 * returned (cheap repolls).
 *
 * Server caps at MAX_TASK_ROWS regardless of `since`.
 */
export const MAX_TASK_ROWS = 100;

export const meTasksSnapshotResponseSchema = z.object({
  data: z.object({
    tasks: z.array(taskRowSchema).max(MAX_TASK_ROWS),
    /** Server's "now" — clients pass back as `since` on the next poll. */
    serverTime: z.string(),
  }),
});
export type MeTasksSnapshotResponse = z.infer<typeof meTasksSnapshotResponseSchema>;

/**
 * SSE event payload pushed on `tasks_user_<userId>` notifies. Lean by
 * design — full row state is fetched out-of-band by the client when it
 * needs more than {id, status, progress}.
 */
export const taskSseEventSchema = z.object({
  id: z.string().uuid(),
  kind: z.string().min(1).max(64),
  status: taskStatusEnum,
  progressPct: z.number().int().min(0).max(100).nullable().optional(),
  updatedAt: z.string(),
  finishedAt: z.string().nullable().optional(),
});
export type TaskSseEvent = z.infer<typeof taskSseEventSchema>;

// ─── Clear ─────────────────────────────────────────────────────────────

export const clearTasksRequestSchema = z.object({
  /** When omitted, clears all completed (non-running) tasks for the caller. */
  ids: z.array(z.string().uuid()).max(MAX_TASK_ROWS).optional(),
});
export type ClearTasksRequest = z.infer<typeof clearTasksRequestSchema>;

export const clearTasksResponseSchema = z.object({
  data: z.object({
    clearedCount: z.number().int().min(0),
  }),
});
export type ClearTasksResponse = z.infer<typeof clearTasksResponseSchema>;
