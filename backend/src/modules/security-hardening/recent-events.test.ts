import { describe, it, expect, vi } from 'vitest';
import { fetchRecentSecurityEvents } from './recent-events.js';

interface FakeRow {
  createdAt: Date;
  resourceType: string;
  actionType: string;
  resourceId: string | null;
  actorId: string | null;
  httpStatus: number | null;
}

// Minimal mock-builder for the Drizzle chain we use.
function buildMockDb(rows: FakeRow[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
  return {
    select: vi.fn().mockReturnValue(chain),
  } as unknown as Parameters<typeof fetchRecentSecurityEvents>[0];
}

describe('fetchRecentSecurityEvents', () => {
  it('maps success status to outcome=success', async () => {
    const db = buildMockDb([
      {
        createdAt: new Date('2026-05-18T10:00:00Z'),
        resourceType: 'cluster_trusted_range',
        actionType: 'create',
        resourceId: 'tr-1',
        actorId: 'user-1',
        httpStatus: 201,
      },
    ]);
    const events = await fetchRecentSecurityEvents(db);
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe('success');
    expect(events[0].resourceType).toBe('cluster_trusted_range');
    expect(events[0].action).toBe('create');
  });

  it('maps 4xx/5xx status to outcome=failure', async () => {
    const db = buildMockDb([
      {
        createdAt: new Date('2026-05-18T10:00:00Z'),
        resourceType: 'cluster_pending_peer',
        actionType: 'create',
        resourceId: null,
        actorId: null,
        httpStatus: 409,
      },
    ]);
    const events = await fetchRecentSecurityEvents(db);
    expect(events[0].outcome).toBe('failure');
  });

  it('maps null status to outcome=unknown', async () => {
    const db = buildMockDb([
      {
        createdAt: new Date('2026-05-18T10:00:00Z'),
        resourceType: 'admin_session',
        actionType: 'logout',
        resourceId: null,
        actorId: 'user-1',
        httpStatus: null,
      },
    ]);
    const events = await fetchRecentSecurityEvents(db);
    expect(events[0].outcome).toBe('unknown');
  });
});
