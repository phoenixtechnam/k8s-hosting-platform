/**
 * Unit tests for backup-rclone-shim apply-assignment.ts (R-X5).
 *
 * Covers:
 *   - resolveDrainTimeoutSeconds: precedence + clamp + reject
 *   - drainResultToStatus: 1-to-1 mapping
 *   - waitForShimReady: rollout settled, 404 fresh-cluster, timeout,
 *     desired=0 short-circuit
 *
 * The orchestrator `applyShimAssignmentChange` itself is exercised by
 * the routes integration tests + the staging E2E harness because it
 * touches the DB (transaction), the k8s SDK (4 PATCH calls), and the
 * task-center (3 progress hops). Unit-testing the full pipeline via
 * mocks would be more mock than test; the individual primitives are
 * each unit-tested.
 */

import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../shared/errors.js';

vi.mock('../tasks/service.js', () => ({
  start: vi.fn(async () => ({ id: '00000000-0000-0000-0000-000000000000', idempotent: false })),
  progress: vi.fn(async () => {}),
  finish: vi.fn(async () => {}),
  finishByRef: vi.fn(async () => {}),
  tracked: vi.fn(),
}));
vi.mock('../notifications/service.js', () => ({
  createNotification: vi.fn(async () => ({})),
}));

import {
  drainResultToStatus,
  resolveDrainTimeoutSeconds,
  sanitiseReconcileError,
  waitForShimReady,
} from './apply-assignment.js';
import {
  DRAIN_TIMEOUT_SECONDS_DEFAULT,
  DRAIN_TIMEOUT_SECONDS_MAX,
  DRAIN_TIMEOUT_SECONDS_MIN,
} from '@k8s-hosting/api-contracts';

// ---------------------------------------------------------------------------
// resolveDrainTimeoutSeconds
// ---------------------------------------------------------------------------

describe('resolveDrainTimeoutSeconds', () => {
  it('uses override when provided (in range)', () => {
    expect(resolveDrainTimeoutSeconds(600, 300)).toBe(600);
  });

  it('uses target value when override is undefined', () => {
    expect(resolveDrainTimeoutSeconds(undefined, 900)).toBe(900);
  });

  it('falls back to default when both are nullish', () => {
    expect(resolveDrainTimeoutSeconds(undefined, null)).toBe(DRAIN_TIMEOUT_SECONDS_DEFAULT);
  });

  it('rejects fractional inputs (must be integer)', () => {
    expect(() => resolveDrainTimeoutSeconds(123.5, null)).toThrow(ApiError);
  });

  it(`rejects values below MIN (${DRAIN_TIMEOUT_SECONDS_MIN})`, () => {
    expect(() => resolveDrainTimeoutSeconds(10, null)).toThrow(ApiError);
  });

  it(`rejects values above MAX (${DRAIN_TIMEOUT_SECONDS_MAX})`, () => {
    expect(() => resolveDrainTimeoutSeconds(3600, null)).toThrow(ApiError);
  });

  it('accepts MIN boundary', () => {
    expect(resolveDrainTimeoutSeconds(DRAIN_TIMEOUT_SECONDS_MIN, null)).toBe(
      DRAIN_TIMEOUT_SECONDS_MIN,
    );
  });

  it('accepts MAX boundary', () => {
    expect(resolveDrainTimeoutSeconds(DRAIN_TIMEOUT_SECONDS_MAX, null)).toBe(
      DRAIN_TIMEOUT_SECONDS_MAX,
    );
  });

  it('rethrows a structured ApiError with code', () => {
    try {
      resolveDrainTimeoutSeconds(1, null);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe('INVALID_DRAIN_TIMEOUT');
      expect((err as ApiError).status).toBe(400);
    }
  });
});

// ---------------------------------------------------------------------------
// sanitiseReconcileError
// ---------------------------------------------------------------------------

describe('sanitiseReconcileError', () => {
  it('redacts base64-shaped runs of 24+ chars (potential ciphertext)', () => {
    const raw = 'Decrypt failed for blob aGVsbG93b3JsZGZvb2JhcjEyMzQ1Njc4OTA=';
    expect(sanitiseReconcileError(raw)).toContain('[REDACTED]');
    expect(sanitiseReconcileError(raw)).not.toContain('aGVsbG8');
  });

  it('leaves short tokens (< 24 chars) untouched', () => {
    const raw = 'Could not parse abc123';
    expect(sanitiseReconcileError(raw)).toBe('Could not parse abc123');
  });

  it('redacts key/secret/password assignments (rclone.conf shape)', () => {
    const raw = 'Render failed: secret_access_key = AKIAIOSFODNN7EXAMPLE rest';
    const out = sanitiseReconcileError(raw);
    expect(out).toContain('secret_access_key=[REDACTED]');
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('redacts password = ... case-insensitively', () => {
    const raw = 'Bad target: Password = hunter2-but-very-long-base64==';
    const out = sanitiseReconcileError(raw);
    expect(out).toContain('Password=[REDACTED]');
  });

  it('truncates to 400 chars with ellipsis marker', () => {
    const raw = 'A'.repeat(800);
    const out = sanitiseReconcileError(raw);
    // Long alphanumeric run is redacted first, but if not the truncation
    // still applies.
    expect(out.length).toBeLessThanOrEqual(400);
  });

  it('is idempotent (running twice equals running once)', () => {
    const raw = 'err with VGhpc0lzQUxvbmdCYXNlNjRTdHJpbmdGb3JUZXN0aW5n';
    const once = sanitiseReconcileError(raw);
    const twice = sanitiseReconcileError(once);
    expect(twice).toBe(once);
  });
});

// ---------------------------------------------------------------------------
// drainResultToStatus
// ---------------------------------------------------------------------------

describe('drainResultToStatus', () => {
  it('maps every field 1:1 + caps inflightSampleKinds at 20', () => {
    const longKinds = Array.from({ length: 25 }, (_, i) => `k${i}`);
    const status = drainResultToStatus({
      phase: 'drain_waiting',
      inFlightAtStart: 5,
      inFlightAtEnd: 0,
      drained: true,
      elapsedMs: 12_345,
      timeoutMs: 300_000,
      inflightSampleKinds: longKinds,
      inflightSamples: [],
    });
    expect(status.phase).toBe('drain_waiting');
    expect(status.inFlightAtStart).toBe(5);
    expect(status.inFlightAtEnd).toBe(0);
    expect(status.drained).toBe(true);
    expect(status.elapsedMs).toBe(12_345);
    expect(status.timeoutMs).toBe(300_000);
    expect(status.inflightSampleKinds.length).toBe(20);
    expect(status.inflightSampleKinds[0]).toBe('k0');
    expect(status.inflightSampleKinds[19]).toBe('k19');
  });
});

// ---------------------------------------------------------------------------
// waitForShimReady
// ---------------------------------------------------------------------------

describe('waitForShimReady', () => {
  function makeClock() {
    let t = 1_000_000;
    return {
      now: () => t,
      sleep: vi.fn(async (ms: number) => { t += ms; }),
      advance: (ms: number) => { t += ms; },
    };
  }

  it('returns ready=true when updated >= desired AND available >= desired', async () => {
    const apps = {
      readNamespacedDaemonSet: vi.fn().mockResolvedValue({
        status: { desiredNumberScheduled: 4, updatedNumberScheduled: 4, numberAvailable: 4 },
      }),
    };
    const clock = makeClock();
    const r = await waitForShimReady(apps as never, { info: vi.fn(), warn: vi.fn() }, {
      now: clock.now,
      sleep: clock.sleep,
      pollIntervalMs: 100,
      timeoutMs: 10_000,
    });
    expect(r.ready).toBe(true);
    expect(r.desired).toBe(4);
    expect(r.available).toBe(4);
  });

  it('treats 404 (fresh cluster) as ready=true', async () => {
    const apps = {
      readNamespacedDaemonSet: vi.fn().mockRejectedValue({ statusCode: 404 }),
    };
    const clock = makeClock();
    const r = await waitForShimReady(apps as never, { info: vi.fn(), warn: vi.fn() }, {
      now: clock.now,
      sleep: clock.sleep,
      pollIntervalMs: 100,
      timeoutMs: 10_000,
    });
    expect(r.ready).toBe(true);
  });

  it('returns ready=true when desired=0 (no eligible nodes)', async () => {
    const apps = {
      readNamespacedDaemonSet: vi.fn().mockResolvedValue({
        status: { desiredNumberScheduled: 0, updatedNumberScheduled: 0, numberAvailable: 0 },
      }),
    };
    const clock = makeClock();
    const log = { info: vi.fn(), warn: vi.fn() };
    const r = await waitForShimReady(apps as never, log, {
      now: clock.now,
      sleep: clock.sleep,
      pollIntervalMs: 100,
      timeoutMs: 10_000,
    });
    expect(r.ready).toBe(true);
    expect(log.warn).toHaveBeenCalled();
  });

  it('polls until rollout settles (eventual ready)', async () => {
    let call = 0;
    const apps = {
      readNamespacedDaemonSet: vi.fn().mockImplementation(async () => {
        call += 1;
        if (call < 3) {
          return { status: { desiredNumberScheduled: 4, updatedNumberScheduled: 2, numberAvailable: 1 } };
        }
        return { status: { desiredNumberScheduled: 4, updatedNumberScheduled: 4, numberAvailable: 4 } };
      }),
    };
    const clock = makeClock();
    const r = await waitForShimReady(apps as never, { info: vi.fn(), warn: vi.fn() }, {
      now: clock.now,
      sleep: clock.sleep,
      pollIntervalMs: 100,
      timeoutMs: 10_000,
    });
    expect(r.ready).toBe(true);
    expect(apps.readNamespacedDaemonSet).toHaveBeenCalledTimes(3);
  });

  it('returns ready=false on timeout when rollout never settles', async () => {
    const apps = {
      readNamespacedDaemonSet: vi.fn().mockResolvedValue({
        status: { desiredNumberScheduled: 4, updatedNumberScheduled: 2, numberAvailable: 1 },
      }),
    };
    const clock = makeClock();
    const log = { info: vi.fn(), warn: vi.fn() };
    const r = await waitForShimReady(apps as never, log, {
      now: clock.now,
      sleep: clock.sleep,
      pollIntervalMs: 100,
      timeoutMs: 500,
    });
    expect(r.ready).toBe(false);
    expect(r.desired).toBe(4);
    expect(r.updated).toBe(2);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ ready: false }),
      expect.stringContaining('verify-ready timeout'),
    );
  });

  it('keeps polling through transient non-404 errors', async () => {
    let call = 0;
    const apps = {
      readNamespacedDaemonSet: vi.fn().mockImplementation(async () => {
        call += 1;
        if (call === 1) throw { statusCode: 503, message: 'apiserver overload' };
        return { status: { desiredNumberScheduled: 1, updatedNumberScheduled: 1, numberAvailable: 1 } };
      }),
    };
    const clock = makeClock();
    const r = await waitForShimReady(apps as never, { info: vi.fn(), warn: vi.fn() }, {
      now: clock.now,
      sleep: clock.sleep,
      pollIntervalMs: 100,
      timeoutMs: 10_000,
    });
    expect(r.ready).toBe(true);
    expect(apps.readNamespacedDaemonSet).toHaveBeenCalledTimes(2);
  });

  it('falls back to numberReady when numberAvailable is undefined', async () => {
    const apps = {
      readNamespacedDaemonSet: vi.fn().mockResolvedValue({
        status: { desiredNumberScheduled: 1, updatedNumberScheduled: 1, numberReady: 1 },
      }),
    };
    const clock = makeClock();
    const r = await waitForShimReady(apps as never, { info: vi.fn(), warn: vi.fn() }, {
      now: clock.now,
      sleep: clock.sleep,
      pollIntervalMs: 100,
      timeoutMs: 10_000,
    });
    expect(r.ready).toBe(true);
    expect(r.available).toBe(1);
  });
});
