import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the notifications module so we can assert which userIds
// receive what without touching the real DB.
vi.mock('../notifications/service.js', () => ({
  createNotification: vi.fn(async (_db: unknown, input: Record<string, unknown>) => ({
    id: `notif-${input.userId}-${input.title}`,
  })),
}));

// ─── Mock DB ────────────────────────────────────────────────────────────────

let executeResults: { rows: unknown[] }[];
let executeCallIndex: number;
let insertConflictCount: number;
let updateClearedCount: number;

function createMockDb() {
  executeCallIndex = 0;
  insertConflictCount = 0;
  updateClearedCount = 0;

  const executeFn = vi.fn().mockImplementation(async () => {
    const result = executeResults[executeCallIndex] ?? { rows: [] };
    executeCallIndex += 1;
    return result;
  });

  // The insert path uses .insert(...).values(...).onConflictDoNothing().returning()
  // The Drizzle v0.x mock chain: each step returns an object with the next.
  const insertReturning = vi.fn().mockImplementation(async () => {
    insertConflictCount += 1;
    // Return [] when conflict (no row inserted), [row] when fresh insert.
    // The test sets the response per-call via executeResults convention.
    const result = executeResults[executeCallIndex] ?? { rows: [] };
    executeCallIndex += 1;
    return result.rows;
  });
  const insertOnConflict = vi.fn().mockReturnValue({ returning: insertReturning });
  const insertValues = vi.fn().mockReturnValue({ onConflictDoNothing: insertOnConflict });
  const insertFn = vi.fn().mockReturnValue({ values: insertValues });

  // Update path for clearing
  const updateWhere = vi.fn().mockImplementation(async () => {
    updateClearedCount += 1;
  });
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
  const updateFn = vi.fn().mockReturnValue({ set: updateSet });

  return {
    execute: executeFn,
    insert: insertFn,
    update: updateFn,
  } as unknown as ReturnType<typeof createMockDb>;
}

const qn = await import('./quota-notifications.js');
const notifications = await import('../notifications/service.js');

beforeEach(() => {
  executeResults = [];
  executeCallIndex = 0;
  insertConflictCount = 0;
  updateClearedCount = 0;
  vi.mocked(notifications.createNotification).mockClear();
});

describe('checkQuotaThresholds', () => {
  it('fires a notification at 80% for the first time the threshold is hit', async () => {
    // SQL #1: select mailboxes ≥ 75 % usage
    executeResults = [
      {
        rows: [
          {
            mailbox_id: 'mb1',
            client_id: 'c1',
            full_address: 'alice@acme.com',
            quota_mb: 100,
            used_mb: 82, // 82 % → crosses 80
            recipient_user_ids: ['user-alice'],
          },
        ],
      },
      // Insert returning — the row was newly inserted (one row returned)
      {
        rows: [{ mailbox_id: 'mb1', threshold: 80 }],
      },
    ];
    const db = createMockDb();

    const result = await qn.checkQuotaThresholds(db as never);

    expect(result.fired).toBe(1);
    expect(notifications.createNotification).toHaveBeenCalledTimes(1);
    const call = vi.mocked(notifications.createNotification).mock.calls[0][1];
    expect(call.userId).toBe('user-alice');
    expect(call.type).toBe('warning');
    expect(call.title).toContain('80');
    expect(call.message).toContain('alice@acme.com');
  });

  it('does NOT fire a notification when the threshold is already recorded (ON CONFLICT DO NOTHING)', async () => {
    executeResults = [
      {
        rows: [
          {
            mailbox_id: 'mb1',
            client_id: 'c1',
            full_address: 'alice@acme.com',
            quota_mb: 100,
            used_mb: 85,
            recipient_user_ids: ['user-alice'],
          },
        ],
      },
      // Insert returning — empty array means no row inserted (conflict)
      { rows: [] },
    ];
    const db = createMockDb();

    const result = await qn.checkQuotaThresholds(db as never);

    expect(result.fired).toBe(0);
    expect(notifications.createNotification).not.toHaveBeenCalled();
  });

  it('fires SEPARATE notifications for 80, 90, and 100 thresholds when usage = 100%', async () => {
    executeResults = [
      {
        rows: [
          {
            mailbox_id: 'mb1',
            client_id: 'c1',
            full_address: 'alice@acme.com',
            quota_mb: 100,
            used_mb: 100,
            recipient_user_ids: ['user-alice'],
          },
        ],
      },
      { rows: [{ mailbox_id: 'mb1', threshold: 80 }] },
      { rows: [{ mailbox_id: 'mb1', threshold: 90 }] },
      { rows: [{ mailbox_id: 'mb1', threshold: 100 }] },
    ];
    const db = createMockDb();

    const result = await qn.checkQuotaThresholds(db as never);

    expect(result.fired).toBe(3);
    expect(notifications.createNotification).toHaveBeenCalledTimes(3);
    const titles = vi.mocked(notifications.createNotification).mock.calls.map(c => c[1].title);
    expect(titles.some(t => String(t).includes('80'))).toBe(true);
    expect(titles.some(t => String(t).includes('90'))).toBe(true);
    expect(titles.some(t => String(t).includes('100'))).toBe(true);
  });

  it('clears events when usage drops below threshold − 5 (hysteresis)', async () => {
    // No mailboxes ≥ 75 % currently
    executeResults = [
      { rows: [] },
      // Clear: select all open events with usage now below threshold-5
      {
        rows: [
          { mailbox_id: 'mb1', threshold: 80, used_mb: 70, quota_mb: 100 },
        ],
      },
    ];
    const db = createMockDb();

    const result = await qn.checkQuotaThresholds(db as never);

    expect(result.fired).toBe(0);
    expect(result.cleared).toBe(1);
  });

  it('notifies all users with mailbox_access for the same mailbox', async () => {
    executeResults = [
      {
        rows: [
          {
            mailbox_id: 'mb1',
            client_id: 'c1',
            full_address: 'alice@acme.com',
            quota_mb: 100,
            used_mb: 85,
            recipient_user_ids: ['user-alice', 'user-admin'],
          },
        ],
      },
      { rows: [{ mailbox_id: 'mb1', threshold: 80 }] },
    ];
    const db = createMockDb();

    await qn.checkQuotaThresholds(db as never);

    expect(notifications.createNotification).toHaveBeenCalledTimes(2);
    const userIds = vi.mocked(notifications.createNotification).mock.calls.map(c => c[1].userId);
    expect(userIds).toContain('user-alice');
    expect(userIds).toContain('user-admin');
  });

  it('skips mailboxes with no recipients (no mailbox_access entries)', async () => {
    executeResults = [
      {
        rows: [
          {
            mailbox_id: 'mb1',
            client_id: 'c1',
            full_address: 'alice@acme.com',
            quota_mb: 100,
            used_mb: 85,
            recipient_user_ids: [],
          },
        ],
      },
    ];
    const db = createMockDb();

    const result = await qn.checkQuotaThresholds(db as never);

    expect(result.fired).toBe(0);
    expect(result.skipped).toBe(1);
    expect(notifications.createNotification).not.toHaveBeenCalled();
  });
});
