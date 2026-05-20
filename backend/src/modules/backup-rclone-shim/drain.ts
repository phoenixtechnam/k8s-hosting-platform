/**
 * Drain orchestration for the universal backup-rclone-shim (R-X5).
 *
 * When an operator changes which `backup_configurations` row a shim
 * class binds to, the new rclone config rolls onto every shim Pod via
 * a DaemonSet annotation bump. Any backup operation that was already
 * streaming bytes to the OLD upstream over the OLD rclone config
 * would experience a connection abort mid-transfer when the Pod
 * recycles. To prevent that, we wait for in-flight backups using the
 * old config to complete before applying the new config.
 *
 * The wait is bounded by `drain_timeout_seconds` on the target row
 * (default 300; CHECK 30..1800). On timeout the apply proceeds anyway
 * — RFC §13a explicitly mandates "force-restarts" so a stuck backup
 * never locks out a target switch. The operator-facing notification
 * names the inflight tasks at the moment of force.
 *
 * Pure DB I/O — no k8s calls. The reconciler in `reconciler.ts`
 * remains the single owner of cluster mutations; drain is wired into
 * the assignment-write orchestrator in `apply-assignment.ts`.
 *
 * Idempotent: invoking drain when there are zero in-flight backups
 * returns immediately with `drainPhase='drain_immediate'`. No
 * side effects.
 */

import { and, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Logger } from 'pino';

import type { Database } from '../../db/index.js';
import { tasks as tasksTable } from '../../db/schema.js';
import type { BackupShimClass, DrainPhase } from '@k8s-hosting/api-contracts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Task kinds whose execution routes IO through the rclone shim. Adding
 * a new shim consumer? Add its kind here so target-switch drains it.
 *
 * Conservative by design: any task whose mechanism *might* hit the
 * shim is included. False positives cost a few seconds of extra wait;
 * a false negative would let an in-flight backup get cut off
 * mid-stream.
 *
 * The list is mirrored as a unit-test fixture; the test suite asserts
 * that every entry exists in the TASK_KIND_REGISTRY at compile time.
 */
export const SHIM_CONSUMER_TASK_KINDS = [
  // ─── SYSTEM class consumers ──────────────────────────────────────
  // Postgres backups (R-X6 wires these through the shim).
  'backup.run',
  // System secrets bundle export, monitoring restic, etc.
  'storage.snapshot',
  'storage.restore',
  // PITR restore from barman-cloud (R-X11 will use the shim).
  'postgres.pitr',
  // ─── TENANT class consumers ──────────────────────────────────────
  // Tenant bundle export/restore (R-X9 wires this through the shim).
  'backup.bundle',
  // Tenant restore-cart driver.
  'restore.cart',
  // ─── MAIL class consumers ────────────────────────────────────────
  // Stalwart RocksDB restic backup (R-X8 wires this through the shim).
  'mail.snapshot.trigger',
  'mail.archive',
  'mail.archive.restore',
  'mail.rotate',
  // Mail migration (engine flips) — uses rclone streaming via shim
  // in the new architecture.
  'mail.migration',
  // ─── Cross-class diagnostic operations ───────────────────────────
  // Speedtest exercises the upstream target through the shim once R-X8
  // ports it. Listed defensively even though current speedtest goes
  // direct.
  'backup.speedtest',
] as const;

/**
 * Mapping from task kind → shim class. Used by class-scoped drain (a
 * SYSTEM target switch should not wait for TENANT backups).
 *
 * Tasks whose class can't be determined statically (e.g. `storage.*`
 * which depends on the snapshot's `snapshot_class`) are mapped to
 * `null` so they ALWAYS drain — defensive against a SYSTEM-class
 * snapshot blocking a SYSTEM-class target switch.
 */
const SHIM_TASK_KIND_TO_CLASS: Record<string, BackupShimClass | null> = {
  // SYSTEM
  'backup.run': 'system',
  'postgres.pitr': 'system',
  'storage.snapshot': null, // class depends on subject
  'storage.restore': null,
  // TENANT
  'backup.bundle': 'tenant',
  'restore.cart': 'tenant',
  // MAIL
  'mail.snapshot.trigger': 'mail',
  'mail.archive': 'mail',
  'mail.archive.restore': 'mail',
  'mail.rotate': 'mail',
  'mail.migration': 'mail',
  // Cross-class
  'backup.speedtest': null,
};

/** Polling cadence inside the drain wait loop. */
export const DRAIN_POLL_INTERVAL_MS = 5 * 1000;

/** Sample-cap for diagnostic kind list. Matches DrainStatus contract. */
export const INFLIGHT_SAMPLE_KIND_CAP = 20;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DrainOpts {
  /** Effective timeout in ms. */
  readonly timeoutMs: number;
  /** Class filter — only wait for tasks bound to one of these classes.
   *  Empty array = all classes. */
  readonly classes?: ReadonlyArray<BackupShimClass>;
  /** Custom poll cadence (test-only). */
  readonly pollIntervalMs?: number;
  /** Injectable clock for tests. */
  readonly now?: () => number;
  /** Injectable sleeper for tests. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface InflightSample {
  readonly kind: string;
  readonly count: number;
}

export interface DrainResult {
  readonly phase: DrainPhase;
  readonly inFlightAtStart: number;
  readonly inFlightAtEnd: number;
  readonly drained: boolean;
  readonly elapsedMs: number;
  readonly timeoutMs: number;
  readonly inflightSampleKinds: ReadonlyArray<string>;
  /** Detailed kind→count breakdown for the final tick — useful for
   *  the timeout notification. */
  readonly inflightSamples: ReadonlyArray<InflightSample>;
}

// ---------------------------------------------------------------------------
// Inflight query
// ---------------------------------------------------------------------------

/**
 * Resolve the set of task kinds to monitor for a given class filter.
 *
 * Empty filter ⇒ every shim-consumer kind.
 * Non-empty filter ⇒ kinds mapped to one of the requested classes,
 * PLUS kinds with `null` class (cross-class / ambiguous tasks always
 * drain — defensive).
 */
export function resolveDrainKinds(
  classes: ReadonlyArray<BackupShimClass>,
): ReadonlyArray<string> {
  if (classes.length === 0) {
    return SHIM_CONSUMER_TASK_KINDS;
  }
  const wanted = new Set<BackupShimClass>(classes);
  return SHIM_CONSUMER_TASK_KINDS.filter((kind) => {
    const mapped = SHIM_TASK_KIND_TO_CLASS[kind];
    if (mapped === null) return true; // cross-class kinds always count
    return mapped !== undefined && wanted.has(mapped);
  });
}

/**
 * Snapshot of in-flight shim-consumer tasks. Returns total + a
 * grouped sample (kind → count) for diagnostics.
 *
 * Tasks are considered in-flight when `status IN ('queued','running')`
 * and `cleared_at IS NULL`. Already-finished rows pending GC are
 * ignored.
 */
export async function snapshotInflightShimConsumers(
  db: Database,
  classes: ReadonlyArray<BackupShimClass> = [],
): Promise<{ total: number; samples: InflightSample[] }> {
  const kinds = resolveDrainKinds(classes);
  if (kinds.length === 0) {
    return { total: 0, samples: [] };
  }
  // Use Drizzle's typed query builder. `inArray` compiles to a
  // bound IN ($1, $2, …) clause that node-pg parametrises correctly
  // — no string-concatenation of caller-controlled values, and no
  // PG `record→text[]` cast surprise (the array literal we tried
  // first failed with `cannot cast type record to text[]`).
  const kindsArray: string[] = [...kinds];
  const rows = await db
    .select({ kind: tasksTable.kind, n: count() })
    .from(tasksTable)
    .where(
      and(
        inArray(tasksTable.kind, kindsArray),
        inArray(tasksTable.status, ['queued', 'running']),
        isNull(tasksTable.clearedAt),
      ),
    )
    .groupBy(tasksTable.kind)
    .orderBy(desc(count()))
    .limit(INFLIGHT_SAMPLE_KIND_CAP);
  const samples: InflightSample[] = rows.map((r) => ({
    kind: r.kind,
    count: Number(r.n),
  }));
  const total = samples.reduce((acc, s) => acc + s.count, 0);
  return { total, samples };
}

// ---------------------------------------------------------------------------
// Wait loop
// ---------------------------------------------------------------------------

/**
 * Poll until in-flight shim-consumer tasks reach 0 OR `timeoutMs`
 * elapses. Returns a structured result describing what happened
 * regardless of outcome — callers decide whether to proceed.
 *
 * The wait is non-cancellable: once entered, it runs to completion or
 * timeout. The reconciler outer loop has its own try/catch boundary
 * so a long drain wait will NOT block the scheduler's other duties
 * (drain runs inside the apply-assignment orchestrator, not the
 * periodic tick).
 *
 * Force path: when `timeoutMs === 0` (caller passed `force=true`),
 * the function short-circuits with `phase='drain_skipped'`. The
 * caller is responsible for surfacing the bypass to the operator.
 */
export async function waitForBackupDrain(
  db: Database,
  log: Pick<Logger, 'info' | 'warn'>,
  opts: DrainOpts,
): Promise<DrainResult> {
  const timeoutMs = Math.max(0, Math.trunc(opts.timeoutMs));
  const classes = opts.classes ?? [];
  const pollMs = opts.pollIntervalMs ?? DRAIN_POLL_INTERVAL_MS;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  if (timeoutMs === 0) {
    const initial = await snapshotInflightShimConsumers(db, classes);
    return {
      phase: 'drain_skipped',
      inFlightAtStart: initial.total,
      inFlightAtEnd: initial.total,
      drained: false,
      elapsedMs: 0,
      timeoutMs: 0,
      inflightSampleKinds: initial.samples.map((s) => s.kind),
      inflightSamples: initial.samples,
    };
  }

  const start = now();
  const initial = await snapshotInflightShimConsumers(db, classes);

  if (initial.total === 0) {
    return {
      phase: 'drain_immediate',
      inFlightAtStart: 0,
      inFlightAtEnd: 0,
      drained: true,
      elapsedMs: 0,
      timeoutMs,
      inflightSampleKinds: [],
      inflightSamples: [],
    };
  }

  log.info(
    {
      inflight: initial.total,
      timeoutMs,
      classes: classes.length === 0 ? 'all' : classes,
      kinds: initial.samples,
    },
    'backup-rclone-shim drain: waiting for in-flight backups',
  );

  let lastSnap = initial;
  while (now() - start < timeoutMs) {
    await sleep(pollMs);
    const snap = await snapshotInflightShimConsumers(db, classes);
    if (snap.total === 0) {
      const elapsedMs = now() - start;
      log.info(
        { initial: initial.total, elapsedMs },
        'backup-rclone-shim drain: complete',
      );
      return {
        phase: 'drain_waiting',
        inFlightAtStart: initial.total,
        inFlightAtEnd: 0,
        drained: true,
        elapsedMs,
        timeoutMs,
        inflightSampleKinds: initial.samples.map((s) => s.kind),
        inflightSamples: initial.samples,
      };
    }
    lastSnap = snap;
  }

  const elapsedMs = now() - start;
  log.warn(
    {
      initial: initial.total,
      final: lastSnap.total,
      timeoutMs,
      elapsedMs,
      kinds: lastSnap.samples,
    },
    'backup-rclone-shim drain: timeout — force-applying new shim config',
  );
  return {
    phase: 'drain_timeout_forced',
    inFlightAtStart: initial.total,
    inFlightAtEnd: lastSnap.total,
    drained: false,
    elapsedMs,
    timeoutMs,
    inflightSampleKinds: lastSnap.samples.map((s) => s.kind),
    inflightSamples: lastSnap.samples,
  };
}

// ---------------------------------------------------------------------------
// Notification helpers
// ---------------------------------------------------------------------------

/**
 * Human-friendly progress text emitted into `tasks.progress_text` so
 * the chip/modal shows "Draining 3 in-flight backups (2 mail.archive,
 * 1 backup.bundle)…" instead of just "Working".
 */
export function formatDrainProgressText(
  inflight: ReadonlyArray<InflightSample>,
): string {
  if (inflight.length === 0) return 'Drain complete';
  const total = inflight.reduce((acc, s) => acc + s.count, 0);
  if (total === 0) return 'Drain complete';
  // 2 mail.archive + 1 backup.bundle
  const parts = inflight
    .slice(0, 5)
    .map((s) => `${s.count} ${s.kind}`)
    .join(' + ');
  const tail = inflight.length > 5 ? ` + ${inflight.length - 5} more` : '';
  return `Draining ${total} in-flight backup${total === 1 ? '' : 's'} (${parts}${tail})`;
}

/**
 * Human-friendly summary for the drain-timeout admin notification.
 *
 * Operator-readable, no secret material. Used as the bell notification
 * payload when `drain_timeout_forced` fires.
 */
export function formatDrainTimeoutNotification(
  className: BackupShimClass | 'all',
  result: DrainResult,
): { title: string; body: string } {
  const scope = className === 'all' ? 'shim drain' : `${className.toUpperCase()} target switch`;
  const tail = result.inflightSamples.length === 0
    ? ''
    : ` Inflight at force: ${result.inflightSamples.map((s) => `${s.count} ${s.kind}`).join(', ')}.`;
  return {
    title: `Backup ${scope}: drain timeout`,
    body:
      `Waited ${Math.round(result.elapsedMs / 1000)}s for ${result.inFlightAtStart} in-flight ` +
      `backup operation${result.inFlightAtStart === 1 ? '' : 's'} to complete; ` +
      `force-applied the new shim config with ${result.inFlightAtEnd} still running.${tail} ` +
      `Retry any failed backups from Backups → System / Tenant / Mail.`,
  };
}
