/**
 * Cluster-wide concurrency gate for tenant-bundle restic streams.
 *
 * Implements ADR-036 "Locked decisions" #5 — the dormant
 * `global_max_in_flight` cap that existed in the schema since
 * migration 0093 but had no runtime enforcement.
 *
 * Why a separate gate vs. the existing per-pod semaphore:
 *
 *   The in-process semaphore in restic-driver caps concurrent restic
 *   spawns per platform-api pod. With 3 replicas at cap=2 that's
 *   6 cluster-wide — more pressure than Hetzner S3 (or the SFTP
 *   Storage Box) needs to sustain a 50-100 tenant daily-backup
 *   window. Adding replicas (e.g. for ingress availability) would
 *   linearly multiply the S3 pressure with no extra throughput
 *   benefit because S3 is already the bottleneck at concurrency 4+.
 *
 *   This gate enforces a cluster-wide cap (default 4, configurable
 *   in `tenant_backup_v2_settings.global_max_in_flight`) regardless
 *   of replica count. 0 = disabled (the per-pod cap is the only
 *   limit).
 *
 * Mechanism — gauge table + xact-lock-serialised acquire:
 *
 *   1. `tenant_bundle_in_flight` holds one row per active (bundle,
 *      component) capture, with a `refreshed_at` heartbeat.
 *   2. Acquire: open a short transaction → take a global
 *      `pg_advisory_xact_lock` (serialises all acquire attempts) →
 *      count non-stale rows → if under cap, INSERT our row → COMMIT
 *      releases the xact lock. The xact lock is short (< 100 ms)
 *      even under contention.
 *   3. During the capture (which may run for minutes), a 60-second
 *      timer refreshes `refreshed_at` so a stalled-but-alive backup
 *      doesn't get counted out. Rows older than `STALE_AFTER_MS`
 *      are treated as orphans from a crashed pod and don't count
 *      toward the cap.
 *   4. Release: DELETE the row + clear the heartbeat timer.
 *
 * Wait semantics:
 *
 *   If the cap is full, the caller polls every ~1 second (with
 *   jitter to avoid thundering-herd) up to `ACQUIRE_TIMEOUT_MS`
 *   (default 30 min). Past the timeout the call rejects with
 *   `CLUSTER_GATE_TIMEOUT` so the caller can surface "backup
 *   queue full" to the operator instead of hanging indefinitely.
 *
 * Failure modes covered:
 *
 *   - Pod crash mid-capture: heartbeat stops → row becomes stale
 *     after STALE_AFTER_MS → next acquirer ignores it for the count
 *     check → retention sweeper eventually DELETEs it.
 *   - Multiple pods racing for the last slot: xact-lock serialises
 *     them; exactly one wins.
 *   - DB blip during release: caller's finally block re-throws if
 *     the DELETE fails (rare), but we also expose `forceRelease()`
 *     for shutdown hooks.
 */

import type { Database } from '../../db/index.js';
import { sql } from 'drizzle-orm';

// Stable 64-bit key for `pg_advisory_xact_lock`. Picked once; do NOT
// change — that would let an in-flight acquire from an old replica
// race a new replica's acquire. The number is the int64 view of the
// first 8 bytes of SHA-256("tenant-bundles-cluster-gate-v1").
//
// ─── PG advisory-lock key registry (must stay unique across the codebase) ───
// pg_advisory_xact_lock(bigint) — single-arg form:
//   0x6f8c4e2d3a571980n  cluster-concurrency.ts (this file) — tenant-bundles cluster gate
//   0x7e3a4109           webmail-settings/service.ts        — mail hostname write serialisation
// pg_advisory_xact_lock(int, int) — two-arg form (distinct lock class):
//   hashtextextended(name)  system-backup/wal-archive.ts     — per-cluster wal-archive enable
//
// When adding a new advisory lock: append your key here and pick a
// value that's unrelated to the existing ones. Verified stable across
// PG versions — advisory lock keys are passed through unchanged.
// ──────────────────────────────────────────────────────────────────────────
const CLUSTER_GATE_LOCK_KEY = 0x6f8c4e2d3a571980n;

// Heartbeat cadence + staleness threshold. A row whose refreshed_at
// is older than STALE_AFTER_MS is treated as an orphan from a
// crashed pod and ignored by the count check.
const HEARTBEAT_INTERVAL_MS = 60_000;
const STALE_AFTER_MS = 5 * 60 * 1000;

// Acquire wait/retry. Backs off with jitter to avoid thundering-herd
// when 4+ acquires queue behind a long capture.
const ACQUIRE_POLL_BASE_MS = 1_000;
const ACQUIRE_POLL_JITTER_MS = 500;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 30 * 60 * 1000;

export interface AcquireSlotArgs {
  readonly bundleId: string;
  readonly component: 'files' | 'mailboxes' | 'config' | 'secrets';
  readonly podName?: string;
  /** Cap from settings.globalMaxInFlight. 0 → no-op release fn. */
  readonly globalMaxInFlight: number;
  /** Override for tests. */
  readonly acquireTimeoutMs?: number;
  /** Caller's abort signal — fires if the upstream HTTP request goes
   *  away while we're queued. */
  readonly abortSignal?: AbortSignal;
}

/**
 * Returned from `acquireGlobalSlot`. Call `release()` (idempotent) in
 * a finally block once the capture finishes.
 */
export interface SlotHandle {
  readonly bundleId: string;
  readonly component: string;
  /** Acquired epoch ms — for diagnostics. */
  readonly acquiredAtMs: number;
  release(): Promise<void>;
}

/**
 * Acquire a cluster-wide slot. When `globalMaxInFlight <= 0` this is a
 * no-op — returns a handle whose `release()` does nothing.
 *
 * Throws on:
 *  - `CLUSTER_GATE_TIMEOUT` — couldn't acquire within acquireTimeoutMs
 *  - `CLUSTER_GATE_ABORTED` — abortSignal fired while queued
 */
export async function acquireGlobalSlot(
  db: Database,
  args: AcquireSlotArgs,
): Promise<SlotHandle> {
  const cap = Math.floor(args.globalMaxInFlight);
  if (!Number.isFinite(cap) || cap <= 0) {
    return makeNoopHandle(args.bundleId, args.component);
  }

  const deadline = Date.now() + (args.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (args.abortSignal?.aborted) {
      throw new ClusterGateError('CLUSTER_GATE_ABORTED', 'aborted while waiting for cluster slot');
    }
    const acquired = await tryAcquireOnce(db, {
      bundleId: args.bundleId,
      component: args.component,
      podName: args.podName ?? null,
      cap,
    });
    if (acquired) {
      const acquiredAtMs = Date.now();
      const heartbeat = startHeartbeat(db, args.bundleId, args.component);
      let released = false;
      return {
        bundleId: args.bundleId,
        component: args.component,
        acquiredAtMs,
        release: async () => {
          if (released) return;
          released = true;
          clearInterval(heartbeat);
          try {
            await db.execute(sql`
              DELETE FROM tenant_bundle_in_flight
                WHERE bundle_id = ${args.bundleId}
                  AND component = ${args.component}
            `);
          } catch (err) {
            // Best-effort: row will be reaped by the retention sweep
            // (refreshed_at older than STALE_AFTER_MS, then DELETEd
            // by tenant-bundles retention). Log so we know it
            // happened.
            // eslint-disable-next-line no-console
            console.warn(
              `[cluster-concurrency] release DELETE failed for ${args.bundleId}/${args.component}: ${(err as Error).message}`,
            );
          }
        },
      };
    }
    if (Date.now() >= deadline) {
      throw new ClusterGateError(
        'CLUSTER_GATE_TIMEOUT',
        `cluster backup gate full (${cap} in-flight) — waited ${Math.round((args.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS) / 1000)}s`,
      );
    }
    await sleepWithAbort(
      ACQUIRE_POLL_BASE_MS + Math.random() * ACQUIRE_POLL_JITTER_MS,
      args.abortSignal,
    );
  }
}

interface TryAcquireArgs {
  readonly bundleId: string;
  readonly component: string;
  readonly podName: string | null;
  readonly cap: number;
}

async function tryAcquireOnce(db: Database, args: TryAcquireArgs): Promise<boolean> {
  // The xact lock serialises every concurrent acquire across the
  // cluster — only one acquire's count+INSERT runs at a time. Lock
  // releases automatically on COMMIT.
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${CLUSTER_GATE_LOCK_KEY})`);
    const countRes = await tx.execute(sql`
      SELECT COUNT(*)::int AS n
        FROM tenant_bundle_in_flight
       WHERE refreshed_at > NOW() - (${STALE_AFTER_MS} || ' milliseconds')::interval
    `) as unknown as { rows: Array<{ n: number }> };
    const active = countRes.rows[0]?.n ?? 0;
    if (active >= args.cap) return false;

    // INSERT with ON CONFLICT — if this exact (bundleId, component)
    // pair is somehow already present (e.g. orphan from a partial
    // prior acquire), we refresh refreshed_at and reuse. This is
    // safe: re-acquiring our own slot doesn't violate the cap.
    await tx.execute(sql`
      INSERT INTO tenant_bundle_in_flight (bundle_id, component, pod_name, started_at, refreshed_at)
      VALUES (${args.bundleId}, ${args.component}, ${args.podName}, NOW(), NOW())
      ON CONFLICT (bundle_id, component)
        DO UPDATE SET refreshed_at = NOW(), pod_name = EXCLUDED.pod_name
    `);
    return true;
  });
}

function startHeartbeat(db: Database, bundleId: string, component: string): NodeJS.Timeout {
  const timer = setInterval(async () => {
    try {
      await db.execute(sql`
        UPDATE tenant_bundle_in_flight
           SET refreshed_at = NOW()
         WHERE bundle_id = ${bundleId}
           AND component = ${component}
      `);
    } catch {
      // Heartbeat blips don't fail the capture; stale row will be
      // ignored by next acquirer's count check after STALE_AFTER_MS.
    }
  }, HEARTBEAT_INTERVAL_MS);
  // Don't keep the event loop alive for the heartbeat — the capture
  // process drives the lifecycle.
  timer.unref?.();
  return timer;
}

async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(t);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function makeNoopHandle(bundleId: string, component: string): SlotHandle {
  return {
    bundleId,
    component,
    acquiredAtMs: Date.now(),
    release: async () => { /* gate disabled */ },
  };
}

export class ClusterGateError extends Error {
  constructor(public readonly code: 'CLUSTER_GATE_TIMEOUT' | 'CLUSTER_GATE_ABORTED', message: string) {
    super(message);
    this.name = 'ClusterGateError';
  }
}

/**
 * Reap stale `tenant_bundle_in_flight` rows. Called by the retention
 * sweeper. A row whose refreshed_at is older than `STALE_AFTER_MS × 2`
 * is definitively orphaned (a heartbeat misses by more than two ticks
 * = the pod is gone). Anything older than 1h is just garbage.
 */
export async function reapStaleInFlight(db: Database): Promise<number> {
  // We use `STALE_AFTER_MS * 2` to give a wider margin than the
  // count-check threshold: a row right at STALE_AFTER_MS is "no longer
  // counted" but kept around for diagnostics; only at 2× we hard-delete.
  const res = await db.execute(sql`
    DELETE FROM tenant_bundle_in_flight
     WHERE refreshed_at < NOW() - (${STALE_AFTER_MS * 2} || ' milliseconds')::interval
    RETURNING bundle_id
  `) as unknown as { rows: Array<{ bundle_id: string }> };
  return res.rows.length;
}
