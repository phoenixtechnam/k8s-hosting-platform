import { describe, it, expect, vi } from 'vitest';
import {
  createNotification,
  listNotifications,
  markAsRead,
  getUnreadCount,
  deleteNotification,
  notifyUser,
} from './service.js';
import { ApiError } from '../../shared/errors.js';

type Db = Parameters<typeof createNotification>[0];

function createMockDb(overrides: {
  selectResult?: unknown[];
  selectResults?: unknown[][];
} = {}) {
  let selectCallIndex = 0;
  const results = overrides.selectResults ?? [overrides.selectResult ?? []];

  const limitFn = vi.fn().mockImplementation(() => {
    const idx = Math.min(selectCallIndex, results.length - 1);
    return Promise.resolve(results[idx]);
  });
  const orderByFn = vi.fn().mockReturnValue({ limit: limitFn });
  const whereFn = vi.fn().mockImplementation(() => {
    const idx = selectCallIndex++;
    const result = results[Math.min(idx, results.length - 1)];
    return { orderBy: orderByFn, then: (resolve: (v: unknown) => void) => resolve(result) };
  });
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });

  const insertValues = vi.fn().mockResolvedValue(undefined);
  const insertFn = vi.fn().mockReturnValue({ values: insertValues });

  const deleteWhere = vi.fn().mockResolvedValue(undefined);
  const deleteFn = vi.fn().mockReturnValue({ where: deleteWhere });

  const updateSetWhere = vi.fn().mockResolvedValue(undefined);
  const updateSet = vi.fn().mockReturnValue({ where: updateSetWhere });
  const updateFn = vi.fn().mockReturnValue({ set: updateSet });

  return {
    select: selectFn,
    insert: insertFn,
    delete: deleteFn,
    update: updateFn,
    _mocks: { selectFn, insertFn, deleteFn, updateFn, whereFn, limitFn, insertValues, deleteWhere, updateSet, updateSetWhere },
  } as unknown as Db & { _mocks: Record<string, ReturnType<typeof vi.fn>> };
}

describe('createNotification', () => {
  it('should insert and return created notification', async () => {
    const notification = {
      id: 'n1',
      userId: 'u1',
      type: 'info' as const,
      title: 'Test',
      message: 'Hello',
      isRead: 0,
      readAt: null,
      resourceType: null,
      resourceId: null,
      createdAt: new Date(),
    };

    const insertValues = vi.fn().mockResolvedValue(undefined);
    const insertFn = vi.fn().mockReturnValue({ values: insertValues });
    const whereFn = vi.fn().mockResolvedValue([notification]);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });

    const db = { select: selectFn, insert: insertFn } as unknown as Db;

    const result = await createNotification(db, {
      userId: 'u1',
      type: 'info',
      title: 'Test',
      message: 'Hello',
    });

    expect(result).toEqual(notification);
    expect(insertFn).toHaveBeenCalled();
  });
});

describe('listNotifications', () => {
  it('should return notifications ordered by createdAt desc', async () => {
    const now = new Date();
    const older = new Date(now.getTime() - 60000);
    const items = [
      { id: 'n1', userId: 'u1', createdAt: now },
      { id: 'n2', userId: 'u1', createdAt: older },
    ];

    const limitFn = vi.fn().mockResolvedValue(items);
    const orderByFn = vi.fn().mockReturnValue({ limit: limitFn });
    const whereFn = vi.fn().mockReturnValue({ orderBy: orderByFn });
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });

    const db = { select: selectFn } as unknown as Db;

    const result = await listNotifications(db, 'u1', { limit: 20 });

    expect(result).toEqual(items);
    expect(result[0].id).toBe('n1');
    expect(result[1].id).toBe('n2');
    expect(limitFn).toHaveBeenCalledWith(20);
  });

  it('should filter unread only when requested', async () => {
    const limitFn = vi.fn().mockResolvedValue([]);
    const orderByFn = vi.fn().mockReturnValue({ limit: limitFn });
    const whereFn = vi.fn().mockReturnValue({ orderBy: orderByFn });
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });

    const db = { select: selectFn } as unknown as Db;

    await listNotifications(db, 'u1', { unreadOnly: true });

    expect(whereFn).toHaveBeenCalled();
  });

  it('should cap limit at 100', async () => {
    const limitFn = vi.fn().mockResolvedValue([]);
    const orderByFn = vi.fn().mockReturnValue({ limit: limitFn });
    const whereFn = vi.fn().mockReturnValue({ orderBy: orderByFn });
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });

    const db = { select: selectFn } as unknown as Db;

    await listNotifications(db, 'u1', { limit: 500 });

    expect(limitFn).toHaveBeenCalledWith(100);
  });
});

describe('markAsRead', () => {
  it('should update isRead and readAt for given ids', async () => {
    const updateSetWhere = vi.fn().mockResolvedValue(undefined);
    const updateSet = vi.fn().mockReturnValue({ where: updateSetWhere });
    const updateFn = vi.fn().mockReturnValue({ set: updateSet });

    const db = { update: updateFn } as unknown as Db;

    await markAsRead(db, 'u1', ['n1', 'n2']);

    expect(updateFn).toHaveBeenCalled();
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ isRead: 1 }),
    );
  });
});

describe('getUnreadCount', () => {
  it('should return the count of unread notifications', async () => {
    const whereFn = vi.fn().mockResolvedValue([{ count: 5 }]);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });

    const db = { select: selectFn } as unknown as Db;

    const count = await getUnreadCount(db, 'u1');

    expect(count).toBe(5);
  });

  it('should return 0 when no results', async () => {
    const whereFn = vi.fn().mockResolvedValue([undefined]);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });

    const db = { select: selectFn } as unknown as Db;

    const count = await getUnreadCount(db, 'u1');

    expect(count).toBe(0);
  });
});

describe('deleteNotification', () => {
  it('should throw NOTIFICATION_NOT_FOUND when notification does not exist', async () => {
    const whereFn = vi.fn().mockResolvedValue([]);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });

    const db = { select: selectFn } as unknown as Db;

    await expect(deleteNotification(db, 'u1', 'missing')).rejects.toThrow(ApiError);
    await expect(deleteNotification(db, 'u1', 'missing')).rejects.toMatchObject({
      code: 'NOTIFICATION_NOT_FOUND',
      status: 404,
    });
  });

  it('should delete when notification exists and belongs to user', async () => {
    const notification = { id: 'n1', userId: 'u1' };
    const whereFn = vi.fn().mockResolvedValue([notification]);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });

    const deleteWhere = vi.fn().mockResolvedValue(undefined);
    const deleteFn = vi.fn().mockReturnValue({ where: deleteWhere });

    const db = { select: selectFn, delete: deleteFn } as unknown as Db;

    await deleteNotification(db, 'u1', 'n1');
    expect(deleteFn).toHaveBeenCalled();
  });
});

describe('notifyUser', () => {
  it('should not throw on DB error (fire-and-forget)', async () => {
    const insertValues = vi.fn().mockRejectedValue(new Error('DB connection lost'));
    const insertFn = vi.fn().mockReturnValue({ values: insertValues });

    const db = { insert: insertFn } as unknown as Db;

    // Should not throw
    await expect(
      notifyUser(db, 'u1', { type: 'info', title: 'Test', message: 'Hello' }),
    ).resolves.toBeUndefined();
  });

  it('should create notification on success', async () => {
    const notification = { id: 'n1', userId: 'u1', type: 'info', title: 'Test', message: 'Hello' };
    const insertValues = vi.fn().mockResolvedValue(undefined);
    const insertFn = vi.fn().mockReturnValue({ values: insertValues });
    const whereFn = vi.fn().mockResolvedValue([notification]);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });

    const db = { insert: insertFn, select: selectFn } as unknown as Db;

    await notifyUser(db, 'u1', { type: 'info', title: 'Test', message: 'Hello' });
    expect(insertFn).toHaveBeenCalled();
  });
});
