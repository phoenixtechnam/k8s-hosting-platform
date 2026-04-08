import { describe, it, expect, vi, beforeEach } from 'vitest';

let selectResults: unknown[][];
let selectCallIndex: number;

function createMockDb() {
  selectCallIndex = 0;
  const whereFn = vi.fn().mockImplementation(() => {
    const result = selectResults[selectCallIndex] ?? [];
    selectCallIndex += 1;
    return Promise.resolve(result);
  });
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });
  return {
    select: selectFn,
  } as unknown as ReturnType<typeof createMockDb>;
}

const rl = await import('./rate-limit.js');

beforeEach(() => {
  selectResults = [];
  selectCallIndex = 0;
});

describe('getEffectiveRateLimit', () => {
  it('returns the per-customer override when set', async () => {
    selectResults = [
      [{ status: 'active', emailSendRateLimit: 200 }],
      [{ value: '500' }],
    ];
    const db = createMockDb();

    const result = await rl.getEffectiveRateLimit(db as never, 'c1');

    expect(result.limitPerHour).toBe(200);
    expect(result.source).toBe('client_override');
    expect(result.suspended).toBe(false);
  });

  it('falls back to the platform default when no override is set', async () => {
    selectResults = [
      [{ status: 'active', emailSendRateLimit: null }],
      [{ value: '500' }],
    ];
    const db = createMockDb();

    const result = await rl.getEffectiveRateLimit(db as never, 'c1');

    expect(result.limitPerHour).toBe(500);
    expect(result.source).toBe('platform_default');
  });

  it('falls back to the hard-coded default when neither override nor platform setting exists', async () => {
    selectResults = [
      [{ status: 'active', emailSendRateLimit: null }],
      [],
    ];
    const db = createMockDb();

    const result = await rl.getEffectiveRateLimit(db as never, 'c1');

    expect(result.limitPerHour).toBe(rl.HARDCODED_DEFAULT_LIMIT_PER_HOUR);
    expect(result.source).toBe('hardcoded_default');
  });

  it('forces limit=0 and suspended=true for a suspended client', async () => {
    selectResults = [
      [{ status: 'suspended', emailSendRateLimit: 200 }],
      [{ value: '500' }],
    ];
    const db = createMockDb();

    const result = await rl.getEffectiveRateLimit(db as never, 'c1');

    expect(result.limitPerHour).toBe(0);
    expect(result.suspended).toBe(true);
    expect(result.source).toBe('suspended');
  });

  it('throws CLIENT_NOT_FOUND when the client does not exist', async () => {
    selectResults = [[]];
    const db = createMockDb();

    await expect(rl.getEffectiveRateLimit(db as never, 'ghost'))
      .rejects.toMatchObject({ code: 'CLIENT_NOT_FOUND', status: 404 });
  });
});
