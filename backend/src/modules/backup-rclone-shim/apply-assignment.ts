/**
 * Apply-assignment orchestrator (R-X5).
 *
 * Operator-facing wrapper around the drain → DB write → reconcile →
 * verify-ready pipeline that runs when a shim-class target binding
 * changes. The single PUT route in `routes.ts` lands here.
 *
 * Pipeline:
 *
 *   ┌─────────────┐  ┌────────┐  ┌────────────┐  ┌──────────┐  ┌────────────┐
 *   │ task.start  │→ │ drain  │→ │ DB replace │→ │ reconcile│→ │ verify     │
 *   │ (admin chip)│  │ (5min) │  │   -set     │  │  pickup  │  │   ready    │
 *   └─────────────┘  └────────┘  └────────────┘  └──────────┘  └────────────┘
 *                         │
 *                         └─ on timeout → notification (bell) + force-apply
 *
 * Why drain BEFORE the DB write:
 *   The drain wait protects in-flight backups that are still streaming
 *   bytes through the OLD upstream via the OLD rclone config. The
 *   reconciler reads the DB → renders → rolls. So:
 *      1. Drain (in-flight backups complete via OLD config)
 *      2. DB write (new binding visible)
 *      3. Reconcile (renders new config + DaemonSet rolls)
 *      4. New backups start with NEW config
 *   If we wrote the DB first, the periodic reconciler tick could fire
 *   in the gap between write and our explicit reconcile call, rolling
 *   the DaemonSet underneath the still-running drain wait.
 *
 * Verify-ready bound: 120 s. Long enough for a 4-node DaemonSet to
 * recycle (Pod startup ≈ 15 s × 4), short enough that operators don't
 * watch a spinner forever if the DS gets wedged. On timeout, the apply
 * still returns success (the DB + reconciler did their jobs) but the
 * task carries a warning detail.
 */

import { and, eq } from 'drizzle-orm';
import type * as k8s from '@kubernetes/client-node';
import type { Logger } from 'pino';

import {
  type BackupShimClass,
  type DrainPhase,
  type DrainStatus,
  type ShimAssignmentRow,
  DRAIN_TIMEOUT_SECONDS_DEFAULT,
  DRAIN_TIMEOUT_SECONDS_MAX,
  DRAIN_TIMEOUT_SECONDS_MIN,
  toSafeText,
} from '@k8s-hosting/api-contracts';

import type { Database } from '../../db/index.js';
import { backupConfigurations, backupTargetAssignments } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { createNotification } from '../notifications/service.js';
import * as tasks from '../tasks/service.js';
import {
  formatDrainProgressText,
  formatDrainTimeoutNotification,
  waitForBackupDrain,
  type DrainResult,
} from './drain.js';
import {
  reconcileBackupRcloneShim,
  type ShimReconcileClients,
  type ShimReconcileResult,
} from './reconciler.js';
import { SHIM_DAEMONSET_NAME, SHIM_NAMESPACE } from './service.js';

// ---------------------------------------------------------------------------
// Verify-ready
// ---------------------------------------------------------------------------

const DEFAULT_VERIFY_READY_TIMEOUT_MS = 120_000;
const DEFAULT_VERIFY_READY_POLL_MS = 2000;

export interface VerifyReadyResult {
  readonly ready: boolean;
  readonly desired: number;
  readonly updated: number;
  readonly available: number;
  readonly elapsedMs: number;
}

interface DaemonSetStatusShape {
  status?: {
    desiredNumberScheduled?: number;
    currentNumberScheduled?: number;
    updatedNumberScheduled?: number;
    numberAvailable?: number;
    numberReady?: number;
  };
  spec?: {
    template?: {
      metadata?: {
        annotations?: Record<string, string>;
      };
    };
  };
}

/**
 * Poll the shim DaemonSet until the rollout settles or the timeout
 * elapses. A "settled" rollout means every desired Pod is updated
 * AND ready. We require BOTH because:
 *
 *   - updatedNumberScheduled ≥ desired   → annotation reached every node
 *   - numberReady ≥ desired              → new Pod templates accepted
 *
 * Reading either field alone hides the case where the new template
 * rolled out but the readiness probe is failing (e.g. ConfigMap
 * mismatch, image pull error).
 */
export async function waitForShimReady(
  apps: k8s.AppsV1Api,
  log: Pick<Logger, 'info' | 'warn'>,
  opts: {
    pollIntervalMs?: number;
    timeoutMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<VerifyReadyResult> {
  const poll = opts.pollIntervalMs ?? DEFAULT_VERIFY_READY_POLL_MS;
  const timeout = opts.timeoutMs ?? DEFAULT_VERIFY_READY_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const start = now();
  let last: VerifyReadyResult = { ready: false, desired: 0, updated: 0, available: 0, elapsedMs: 0 };

  while (now() - start < timeout) {
    try {
      const live = (await apps.readNamespacedDaemonSet({
        namespace: SHIM_NAMESPACE,
        name: SHIM_DAEMONSET_NAME,
      } as unknown as Parameters<typeof apps.readNamespacedDaemonSet>[0])) as DaemonSetStatusShape;
      const desired = live.status?.desiredNumberScheduled ?? 0;
      const updated = live.status?.updatedNumberScheduled ?? 0;
      const available = live.status?.numberAvailable ?? live.status?.numberReady ?? 0;
      last = { ready: false, desired, updated, available, elapsedMs: now() - start };
      // Edge case: desired=0 means no eligible nodes. Treat as ready —
      // the rollout has nothing to do. UI surface should warn separately.
      if (desired === 0) {
        log.warn(
          { name: SHIM_DAEMONSET_NAME },
          'backup-rclone-shim apply: DaemonSet has desired=0 — no eligible nodes; treating as ready',
        );
        return { ...last, ready: true };
      }
      if (updated >= desired && available >= desired) {
        return { ...last, ready: true };
      }
    } catch (err) {
      // 404 = DaemonSet not yet applied (fresh cluster pre-Flux first
      // sync). Treat as ready — the reconciler will materialise on the
      // next tick once Flux applies. The status CM already carries the
      // STATE_NO_ASSIGNMENTS / STATE_ERROR signal for operators.
      const code = (err as { statusCode?: number; code?: number })?.statusCode
        ?? (err as { code?: number })?.code;
      if (code === 404) {
        log.warn(
          { name: SHIM_DAEMONSET_NAME },
          'backup-rclone-shim apply: DaemonSet not found — Flux has not applied yet (verify-ready skipped)',
        );
        return { ready: true, desired: 0, updated: 0, available: 0, elapsedMs: now() - start };
      }
      // Transient read errors — keep polling.
    }
    await sleep(poll);
  }

  log.warn(
    { ...last },
    'backup-rclone-shim apply: verify-ready timeout (DaemonSet did not settle)',
  );
  return last;
}

// ---------------------------------------------------------------------------
// Input / output types
// ---------------------------------------------------------------------------

export interface ApplyShimAssignmentArgs {
  readonly className: BackupShimClass;
  /** Target id to bind. `null` = unassign (shim sleeps for this class). */
  readonly targetId: string | null;
  /** Skip the drain wait. Operator escape hatch. */
  readonly force: boolean;
  /** Optional per-operation override of the target's drain timeout. */
  readonly drainTimeoutSecondsOverride?: number;
  /** Initiator user id — receives the bell notification on drain timeout. */
  readonly userId: string;
}

export interface ApplyShimAssignmentResult {
  readonly assignment: ShimAssignmentRow;
  readonly taskId: string;
  readonly drain: DrainStatus;
  readonly reconcile: ShimReconcileResult;
  readonly verify: VerifyReadyResult;
}

export interface ApplyShimAssignmentDeps {
  readonly db: Database;
  readonly k8s: ShimReconcileClients;
  readonly encryptionKey: string;
  readonly log: Pick<Logger, 'info' | 'warn' | 'error'>;
  /** Test-only injections. */
  readonly drainSleep?: (ms: number) => Promise<void>;
  readonly drainNow?: () => number;
  readonly verifyPollIntervalMs?: number;
  readonly verifyTimeoutMs?: number;
  readonly verifySleep?: (ms: number) => Promise<void>;
  readonly verifyNow?: () => number;
  readonly drainPollIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * The orchestrator. Throws ApiError on input validation failures
 * (caller surfaces these as 4xx); throws on infrastructure failures
 * (caller surfaces as 5xx); never throws inside the task lifecycle —
 * a thrown error inside `tracked()` marks the task as `failed` and
 * rethrows.
 */
export async function applyShimAssignmentChange(
  deps: ApplyShimAssignmentDeps,
  args: ApplyShimAssignmentArgs,
): Promise<ApplyShimAssignmentResult> {
  const { db, k8s: k8sClients, encryptionKey, log } = deps;

  // ─── 1. Validate target ─────────────────────────────────────────
  let targetRow: typeof backupConfigurations.$inferSelect | null = null;
  if (args.targetId !== null) {
    const [row] = await db
      .select()
      .from(backupConfigurations)
      .where(eq(backupConfigurations.id, args.targetId))
      .limit(1);
    if (!row) {
      throw new ApiError(
        'TARGET_NOT_FOUND',
        `backup_configurations row '${args.targetId}' not found`,
        400,
      );
    }
    if (row.enabled !== 1) {
      throw new ApiError(
        'TARGET_DISABLED',
        `backup_configurations row '${args.targetId}' is disabled — enable it before binding to a shim class`,
        400,
      );
    }
    targetRow = row;
  }

  // ─── 2. Resolve effective drain timeout ─────────────────────────
  const effectiveSeconds = resolveDrainTimeoutSeconds(
    args.drainTimeoutSecondsOverride,
    targetRow?.drainTimeoutSeconds ?? null,
  );
  const effectiveMs = args.force ? 0 : effectiveSeconds * 1000;

  // ─── 3. Start tracked task ──────────────────────────────────────
  const label = toSafeText(
    args.targetId === null
      ? `Unassign ${args.className.toUpperCase()} backup target`
      : `Switch ${args.className.toUpperCase()} backup target to ${targetRow?.name ?? args.targetId}`,
  );
  const { id: taskId } = await tasks.start(db, {
    kind: 'backup.shim.target-switch',
    refId: `shim:${args.className}:${Date.now()}`,
    scope: 'admin',
    userId: args.userId,
    label,
    target: {
      type: 'modal',
      modal: 'shim-target-switch',
      modalProps: { className: args.className },
    },
    progressPct: 0,
    progressText: toSafeText('Starting target switch'),
    details: {
      className: args.className,
      targetId: args.targetId,
      targetName: targetRow?.name ?? null,
      force: args.force,
      drainTimeoutSeconds: effectiveSeconds,
    },
  });

  try {
    // ─── 4. Drain ────────────────────────────────────────────────
    await tasks.progress(db, taskId, {
      pct: 5,
      text: toSafeText('Waiting for in-flight backups to drain'),
    });
    const drainResult: DrainResult = await waitForBackupDrain(db, log, {
      timeoutMs: effectiveMs,
      classes: [args.className],
      pollIntervalMs: deps.drainPollIntervalMs,
      sleep: deps.drainSleep,
      now: deps.drainNow,
    });
    await tasks.progress(db, taskId, {
      pct: 30,
      text: toSafeText(formatDrainProgressText(drainResult.inflightSamples)),
      detailsPatch: {
        drain: drainResultToStatus(drainResult),
      },
    });
    if (drainResult.phase === 'drain_timeout_forced') {
      const note = formatDrainTimeoutNotification(args.className, drainResult);
      await createNotification(db, {
        userId: args.userId,
        type: 'warning',
        title: note.title,
        message: note.body,
        resourceType: 'backup-rclone-shim',
        resourceId: args.className,
      });
    }

    // ─── 5. DB write (replace-set) ───────────────────────────────
    await tasks.progress(db, taskId, {
      pct: 40,
      text: toSafeText('Writing assignment'),
    });
    const assignment = await writeAssignment(db, args.className, args.targetId);

    // ─── 6. Reconcile (immediate, not waiting for 5-min tick) ────
    await tasks.progress(db, taskId, {
      pct: 60,
      text: toSafeText('Rendering shim config'),
    });
    const reconcile = await reconcileBackupRcloneShim(
      db,
      k8sClients,
      encryptionKey,
      log,
    );
    if (reconcile.state === 'STATE_ERROR') {
      // Surface the error to the task but don't roll back the DB —
      // the reconciler will self-heal on next tick. Bell-notify the
      // operator so the "succeeded but degraded" outcome isn't lost
      // when the modal closes.
      //
      // The reconciler's `errorMessage` is built from caught errors
      // including decryption failures; raw error strings may leak
      // ciphertext fragments or other secret-shaped material. Run
      // through `sanitiseReconcileError` before persisting + notifying.
      const safeMessage = sanitiseReconcileError(reconcile.errorMessage);
      await tasks.progress(db, taskId, {
        pct: 70,
        text: toSafeText(`Reconcile reported STATE_ERROR (will self-heal)`),
        detailsPatch: { reconcileError: safeMessage },
      });
      try {
        await createNotification(db, {
          userId: args.userId,
          type: 'warning',
          title: `Shim reconcile error (${args.className.toUpperCase()})`,
          message:
            `The DB binding was updated but the shim reconciler reported ` +
            `STATE_ERROR: ${safeMessage}. ` +
            `The 5-minute periodic reconciler will retry; verify upstream ` +
            `connectivity on the target and check the shim status tab.`,
          resourceType: 'backup-rclone-shim',
          resourceId: args.className,
        });
      } catch {
        // Notification creation is best-effort; the task detail is the
        // authoritative record.
      }
    } else if (reconcile.state === 'STATE_MISSING_KEY') {
      throw new ApiError(
        'SHIM_KEY_MISSING',
        'BACKUP_TARGET_KEY Secret is missing; cannot render shim config. Re-run bootstrap.sh or restore from secrets bundle.',
        409,
      );
    }

    // ─── 7. Verify shim ready ────────────────────────────────────
    await tasks.progress(db, taskId, {
      pct: 80,
      text: toSafeText('Waiting for shim DaemonSet to roll'),
    });
    const verify = await waitForShimReady(k8sClients.apps, log, {
      pollIntervalMs: deps.verifyPollIntervalMs,
      timeoutMs: deps.verifyTimeoutMs,
      sleep: deps.verifySleep,
      now: deps.verifyNow,
    });
    if (!verify.ready) {
      log.warn(
        { verify },
        'backup-rclone-shim apply: DaemonSet did not settle within verify timeout',
      );
    }

    await tasks.progress(db, taskId, {
      pct: 100,
      text: toSafeText(
        verify.ready
          ? 'Shim target switched successfully'
          : 'Shim target switched (verify-ready timed out; DaemonSet still rolling)',
      ),
      detailsPatch: {
        verify,
        reconcileState: reconcile.state,
      },
    });
    await tasks.finish(db, taskId, {
      status: 'succeeded',
      text: toSafeText(
        verify.ready
          ? 'Target switch complete'
          : 'Target switch complete (verify-ready timed out)',
      ),
    });

    return {
      assignment,
      taskId,
      drain: drainResultToStatus(drainResult),
      reconcile,
      verify,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await tasks.finish(db, taskId, {
      status: 'failed',
      error: message.slice(0, 4096),
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip secret-shaped fragments from a reconciler error before it
 * lands in operator-visible surfaces (task details, bell notifications).
 *
 * The reconciler's catch boundary surfaces `err.message` verbatim;
 * decryption errors and rclone-config builders may include base64
 * ciphertext, obscured passwords, or other partially-rendered config
 * snippets. We strip:
 *
 *   - Any base64-shaped run ≥24 chars (likely ciphertext)
 *   - Any `key = …` / `password = …` / `secret = …` assignment
 *   - Truncate to 400 chars regardless
 *
 * Conservative — false positives (e.g. a real error message that
 * contains a long word) cost legibility, not correctness. Operators
 * still get the error category + truncation marker.
 */
export function sanitiseReconcileError(raw: string): string {
  let s = raw;
  // Mask base64-ish runs (alphanum + / + + + = and at least 24 chars).
  // `=` is not a word character, so we can't rely on `\b` at the tail —
  // use a non-greedy padding count + explicit boundary lookbehind.
  s = s.replace(/[A-Za-z0-9+/]{24,}={0,2}/g, '[REDACTED]');
  // Mask any identifier ending in key/secret/password/token followed
  // by an = assignment (rclone.conf shape). `\w*` accepts compound
  // names like `secret_access_key` and `apiToken`.
  s = s.replace(
    /\b(\w*(?:key|secret|password|passwd|token))\s*=\s*\S+/gi,
    '$1=[REDACTED]',
  );
  // Truncate.
  if (s.length > 400) s = s.slice(0, 397) + '...';
  return s;
}

/**
 * Effective drain timeout in seconds.
 *
 * Resolution order: per-operation override → target's stored value →
 * default. All values are clamped to the contract bounds; out-of-range
 * inputs throw ApiError (the contract Zod schema catches this earlier
 * for the HTTP path, but we re-validate for callers that bypass the
 * route).
 */
export function resolveDrainTimeoutSeconds(
  override: number | undefined,
  fromTarget: number | null,
): number {
  const candidate = override ?? fromTarget ?? DRAIN_TIMEOUT_SECONDS_DEFAULT;
  if (
    !Number.isInteger(candidate)
    || candidate < DRAIN_TIMEOUT_SECONDS_MIN
    || candidate > DRAIN_TIMEOUT_SECONDS_MAX
  ) {
    throw new ApiError(
      'INVALID_DRAIN_TIMEOUT',
      `drain_timeout_seconds must be an integer in [${DRAIN_TIMEOUT_SECONDS_MIN}, ${DRAIN_TIMEOUT_SECONDS_MAX}], got ${candidate}`,
      400,
    );
  }
  return candidate;
}

export function drainResultToStatus(r: DrainResult): DrainStatus {
  return {
    phase: r.phase as DrainPhase,
    inFlightAtStart: r.inFlightAtStart,
    inFlightAtEnd: r.inFlightAtEnd,
    drained: r.drained,
    elapsedMs: r.elapsedMs,
    timeoutMs: r.timeoutMs,
    inflightSampleKinds: r.inflightSampleKinds.slice(0, 20),
  };
}

/**
 * Replace-set the binding for one shim class. Operates inside a single
 * transaction so a concurrent reconciler tick never sees a half-empty
 * state.
 */
async function writeAssignment(
  db: Database,
  className: BackupShimClass,
  targetId: string | null,
): Promise<ShimAssignmentRow> {
  await db.transaction(async (tx) => {
    await tx
      .delete(backupTargetAssignments)
      .where(eq(backupTargetAssignments.snapshotClass, className));
    if (targetId !== null) {
      await tx.insert(backupTargetAssignments).values({
        snapshotClass: className,
        targetId,
        priority: 0,
      });
    }
  });

  // Read back the joined row for the response envelope.
  if (targetId === null) {
    return {
      className,
      targetId: null,
      targetName: null,
      targetStorageType: null,
      drainTimeoutSeconds: DRAIN_TIMEOUT_SECONDS_DEFAULT,
    };
  }
  const [row] = await db
    .select({
      id: backupConfigurations.id,
      name: backupConfigurations.name,
      storageType: backupConfigurations.storageType,
      drainTimeoutSeconds: backupConfigurations.drainTimeoutSeconds,
    })
    .from(backupTargetAssignments)
    .innerJoin(backupConfigurations, eq(backupConfigurations.id, backupTargetAssignments.targetId))
    .where(
      and(
        eq(backupTargetAssignments.snapshotClass, className),
        eq(backupTargetAssignments.targetId, targetId),
      ),
    )
    .limit(1);
  if (!row) {
    // Defensive — shouldn't happen since we just inserted.
    throw new ApiError(
      'ASSIGNMENT_READBACK_FAILED',
      'Assignment was written but the read-back returned no row — concurrent delete?',
      500,
    );
  }
  return {
    className,
    targetId: row.id,
    targetName: row.name,
    targetStorageType: row.storageType as 's3' | 'ssh' | 'cifs' | 'nfs',
    drainTimeoutSeconds: row.drainTimeoutSeconds,
  };
}

// ---------------------------------------------------------------------------
// Drain-now (operator escape hatch — no assignment change)
// ---------------------------------------------------------------------------

export interface DrainNowArgs {
  readonly classes: ReadonlyArray<BackupShimClass>;
  readonly drainTimeoutSecondsOverride?: number;
  readonly userId: string;
}

export interface DrainNowResult {
  readonly drain: DrainStatus;
  readonly taskId: string;
}

export async function runDrainNow(
  deps: Pick<ApplyShimAssignmentDeps, 'db' | 'log' | 'drainSleep' | 'drainNow' | 'drainPollIntervalMs'>,
  args: DrainNowArgs,
): Promise<DrainNowResult> {
  const { db, log } = deps;
  const seconds = resolveDrainTimeoutSeconds(args.drainTimeoutSecondsOverride, null);
  const scope = args.classes.length === 0 ? 'all' : args.classes.join('+');
  const label = toSafeText(`Drain in-flight backups (${scope})`);
  const { id: taskId } = await tasks.start(db, {
    kind: 'backup.shim.drain',
    refId: `drain:${scope}:${Date.now()}`,
    scope: 'admin',
    userId: args.userId,
    label,
    target: {
      type: 'modal',
      modal: 'shim-drain',
      modalProps: { classes: args.classes },
    },
    progressPct: 0,
    progressText: toSafeText('Polling task center'),
    details: { classes: args.classes, drainTimeoutSeconds: seconds },
  });

  try {
    const drainResult = await waitForBackupDrain(db, log, {
      timeoutMs: seconds * 1000,
      classes: args.classes,
      pollIntervalMs: deps.drainPollIntervalMs,
      sleep: deps.drainSleep,
      now: deps.drainNow,
    });
    if (drainResult.phase === 'drain_timeout_forced') {
      const note = formatDrainTimeoutNotification(
        args.classes.length === 1 ? args.classes[0] : 'all',
        drainResult,
      );
      await createNotification(db, {
        userId: args.userId,
        type: 'warning',
        title: note.title,
        message: note.body,
        resourceType: 'backup-rclone-shim',
        resourceId: scope,
      });
    }
    await tasks.finish(db, taskId, {
      status: 'succeeded',
      text: toSafeText(formatDrainProgressText(drainResult.inflightSamples)),
      detailsPatch: { drain: drainResultToStatus(drainResult) },
    });
    return { drain: drainResultToStatus(drainResult), taskId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await tasks.finish(db, taskId, {
      status: 'failed',
      error: message.slice(0, 4096),
    });
    throw err;
  }
}
