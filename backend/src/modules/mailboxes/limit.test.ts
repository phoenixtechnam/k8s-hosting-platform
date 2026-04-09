import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── DB mock ──────────────────────────────────────────────────────────

let selectResults: unknown[][];
let selectCallIndex: number;

function createMockDb() {
  selectCallIndex = 0;
  const whereFn = vi.fn().mockImplementation(() => {
    const result = selectResults[selectCallIndex] ?? [];
    selectCallIndex += 1;
    return Promise.resolve(result);
  });
  const fromFn = vi.fn().mockReturnValue({ where: whereFn, innerJoin: vi.fn().mockReturnValue({ where: whereFn }) });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });
  return { select: selectFn } as unknown as ReturnType<typeof createMockDb>;
}

const limit = await import('./limit.js');

beforeEach(() => {
  selectResults = [];
  selectCallIndex = 0;
});

// ═══════════════════════════════════════════════════════════════════════
// computeClientMailboxLimit — pure function
// ═══════════════════════════════════════════════════════════════════════

describe('computeClientMailboxLimit', () => {
  it('returns the plan limit when override is null', () => {
    expect(limit.computeClientMailboxLimit({ planLimit: 25, override: null })).toEqual({
      limit: 25,
      source: 'plan',
    });
  });

  it('returns the override when it is a positive integer', () => {
    expect(limit.computeClientMailboxLimit({ planLimit: 25, override: 100 })).toEqual({
      limit: 100,
      source: 'client_override',
    });
  });

  it('falls back to the plan limit when override is zero', () => {
    expect(limit.computeClientMailboxLimit({ planLimit: 25, override: 0 })).toEqual({
      limit: 25,
      source: 'plan',
    });
  });

  it('falls back to the plan limit when override is negative', () => {
    expect(limit.computeClientMailboxLimit({ planLimit: 25, override: -5 })).toEqual({
      limit: 25,
      source: 'plan',
    });
  });

  it('allows override to go lower than the plan limit', () => {
    expect(limit.computeClientMailboxLimit({ planLimit: 100, override: 10 })).toEqual({
      limit: 10,
      source: 'client_override',
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// getClientMailboxCount
// ═══════════════════════════════════════════════════════════════════════

describe('getClientMailboxCount', () => {
  it('returns the total mailbox count across all email domains for a client', async () => {
    selectResults = [[{ count: 12 }]];
    const db = createMockDb();
    const count = await limit.getClientMailboxCount(db as never, 'c1');
    expect(count).toBe(12);
  });

  it('returns 0 when the client has no mailboxes', async () => {
    selectResults = [[]];
    const db = createMockDb();
    const count = await limit.getClientMailboxCount(db as never, 'c-empty');
    expect(count).toBe(0);
  });

  it('coerces the count to a number when the DB returns a string', async () => {
    selectResults = [[{ count: '42' }]];
    const db = createMockDb();
    const count = await limit.getClientMailboxCount(db as never, 'c1');
    expect(count).toBe(42);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// getClientMailboxLimit (fetches plan + override + composes)
// ═══════════════════════════════════════════════════════════════════════

describe('getClientMailboxLimit', () => {
  it('returns the composed plan+override limit for a client', async () => {
    // Call 1: client+plan join lookup
    selectResults = [
      [{ planLimit: 50, override: 100 }],
    ];
    const db = createMockDb();
    const result = await limit.getClientMailboxLimit(db as never, 'c1');
    expect(result).toEqual({ limit: 100, source: 'client_override' });
  });

  it('uses the plan limit when no override is set', async () => {
    selectResults = [
      [{ planLimit: 50, override: null }],
    ];
    const db = createMockDb();
    const result = await limit.getClientMailboxLimit(db as never, 'c1');
    expect(result).toEqual({ limit: 50, source: 'plan' });
  });

  it('throws CLIENT_NOT_FOUND when the client does not exist', async () => {
    selectResults = [[]];
    const db = createMockDb();
    await expect(limit.getClientMailboxLimit(db as never, 'ghost')).rejects.toMatchObject({
      code: 'CLIENT_NOT_FOUND',
      status: 404,
    });
  });
});
