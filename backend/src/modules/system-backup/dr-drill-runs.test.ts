/**
 * Pure-function tests for the consecutive-streak state machine in
 * getDrDrillSummary. Earlier sentinel-based logic over-counted after a
 * streak break — these cases lock the fix in.
 *
 * The full module pipes through Drizzle (real DB) — integration cover
 * lives in scripts/integration-secrets-bundle.sh.
 */

import { describe, it, expect, vi } from 'vitest';
import { getDrDrillSummary } from './dr-drill-runs.js';

interface FakeRow {
  status: 'success' | 'failed' | 'running' | 'cancelled';
  startedAt: Date;
}

/** Build a fake Drizzle chain that returns the given rows. */
function fakeDb(rows: FakeRow[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
  return { select: vi.fn().mockReturnValue(chain) } as unknown as Parameters<typeof getDrDrillSummary>[0];
}

const t = (n: number): Date => new Date(`2026-05-${String(n).padStart(2, '0')}T00:00:00Z`);

describe('getDrDrillSummary — consecutive streak state machine', () => {
  it('all-success: streak = N', async () => {
    const rows: FakeRow[] = [t(5), t(4), t(3)].map((s) => ({ status: 'success', startedAt: s }));
    const s = await getDrDrillSummary(fakeDb(rows));
    expect(s.consecutiveSuccessCount).toBe(3);
    expect(s.consecutiveFailureCount).toBe(0);
    expect(s.rollingPassRate).toBe(1);
    expect(s.lastSuccessAt).toBe(t(5).toISOString());
    expect(s.lastFailureAt).toBeNull();
  });

  it('all-failed: streak = N', async () => {
    const rows: FakeRow[] = [t(5), t(4)].map((s) => ({ status: 'failed', startedAt: s }));
    const s = await getDrDrillSummary(fakeDb(rows));
    expect(s.consecutiveFailureCount).toBe(2);
    expect(s.consecutiveSuccessCount).toBe(0);
    expect(s.rollingPassRate).toBe(0);
  });

  it('streak ends when type changes — does NOT resume after later same-type row (THE BUG)', async () => {
    // Rows newest-first: [success, success, failed, success]
    // Old sentinel-based code would count 3 successes (the trailing
    // success matched the sentinel `success` value the else-branch set).
    // Fixed code freezes the streak at 2 and never increments again.
    const rows: FakeRow[] = [
      { status: 'success', startedAt: t(5) },
      { status: 'success', startedAt: t(4) },
      { status: 'failed',  startedAt: t(3) },
      { status: 'success', startedAt: t(2) },
    ];
    const s = await getDrDrillSummary(fakeDb(rows));
    expect(s.consecutiveSuccessCount).toBe(2);
    expect(s.consecutiveFailureCount).toBe(0);
    // The window has 3 successes + 1 failure = 75% pass rate.
    expect(s.rollingPassRate).toBeCloseTo(3 / 4);
    expect(s.lastSuccessAt).toBe(t(5).toISOString());
    expect(s.lastFailureAt).toBe(t(3).toISOString());
  });

  it('failed-streak that ends still freezes at the right count', async () => {
    // [failed, failed, success, failed, failed]
    const rows: FakeRow[] = [
      { status: 'failed',  startedAt: t(5) },
      { status: 'failed',  startedAt: t(4) },
      { status: 'success', startedAt: t(3) },
      { status: 'failed',  startedAt: t(2) },
      { status: 'failed',  startedAt: t(1) },
    ];
    const s = await getDrDrillSummary(fakeDb(rows));
    expect(s.consecutiveFailureCount).toBe(2);
    expect(s.consecutiveSuccessCount).toBe(0);
  });

  it('a running row (non-terminal) is ignored for streak counting', async () => {
    const rows: FakeRow[] = [
      { status: 'running', startedAt: t(6) },
      { status: 'success', startedAt: t(5) },
      { status: 'success', startedAt: t(4) },
    ];
    const s = await getDrDrillSummary(fakeDb(rows));
    expect(s.consecutiveSuccessCount).toBe(2);
    expect(s.rollingPassRate).toBe(1);
  });

  it('single running row → all-zero summary', async () => {
    const rows: FakeRow[] = [{ status: 'running', startedAt: t(5) }];
    const s = await getDrDrillSummary(fakeDb(rows));
    expect(s.consecutiveSuccessCount).toBe(0);
    expect(s.consecutiveFailureCount).toBe(0);
    expect(s.rollingPassRate).toBe(0);
    expect(s.lastSuccessAt).toBeNull();
    expect(s.lastFailureAt).toBeNull();
  });

  it('empty history → zero everything', async () => {
    const s = await getDrDrillSummary(fakeDb([]));
    expect(s.consecutiveSuccessCount).toBe(0);
    expect(s.consecutiveFailureCount).toBe(0);
    expect(s.rollingPassRate).toBe(0);
    expect(s.lastSuccessAt).toBeNull();
    expect(s.lastFailureAt).toBeNull();
  });
});
