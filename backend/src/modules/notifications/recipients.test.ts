import { describe, it, expect, vi } from 'vitest';
import {
  getClientNotificationRecipients,
  getAdminRecipients,
  resolveRecipients,
} from './recipients.js';

function mockDb(rows: Array<{ id: string }>) {
  const whereFn = vi.fn().mockResolvedValue(rows);
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });
  return { select: selectFn } as never;
}

describe('getClientNotificationRecipients', () => {
  it('returns user IDs for all client_admin users of a client', async () => {
    const db = mockDb([{ id: 'u1' }, { id: 'u2' }]);
    const result = await getClientNotificationRecipients(db, 'c1');
    expect(result).toEqual(['u1', 'u2']);
  });

  it('returns empty array when no admins exist', async () => {
    const db = mockDb([]);
    const result = await getClientNotificationRecipients(db, 'c1');
    expect(result).toEqual([]);
  });

  it('deduplicates user ids', async () => {
    const db = mockDb([{ id: 'u1' }, { id: 'u1' }, { id: 'u2' }]);
    const result = await getClientNotificationRecipients(db, 'c1');
    expect(result).toEqual(['u1', 'u2']);
  });
});

describe('getAdminRecipients', () => {
  it('returns user IDs for users in the requested role list', async () => {
    const db = mockDb([{ id: 'a1' }, { id: 'a2' }]);
    const result = await getAdminRecipients(db, ['super_admin', 'admin']);
    expect(result).toEqual(['a1', 'a2']);
  });

  it('returns empty array when role list is empty (no DB query)', async () => {
    const db = mockDb([{ id: 'should-not-be-returned' }]);
    const result = await getAdminRecipients(db, []);
    expect(result).toEqual([]);
  });

  it('deduplicates ids', async () => {
    const db = mockDb([{ id: 'a1' }, { id: 'a1' }]);
    const result = await getAdminRecipients(db, ['super_admin']);
    expect(result).toEqual(['a1']);
  });
});

describe('resolveRecipients', () => {
  it('admin scope dispatches to getAdminRecipients with default roles', async () => {
    const db = mockDb([{ id: 'a1' }]);
    const result = await resolveRecipients(db, { kind: 'admin' });
    expect(result).toEqual(['a1']);
  });

  it('admin_role scope respects explicit role list', async () => {
    const db = mockDb([{ id: 'b1' }]);
    const result = await resolveRecipients(db, {
      kind: 'admin_role',
      roles: ['billing'],
    });
    expect(result).toEqual(['b1']);
  });

  it('client scope dispatches to getClientNotificationRecipients', async () => {
    const db = mockDb([{ id: 'c1-admin' }]);
    const result = await resolveRecipients(db, { kind: 'client', clientId: 'c1' });
    expect(result).toEqual(['c1-admin']);
  });

  it('user scope returns the single id without DB lookup', async () => {
    const db = { select: vi.fn(() => { throw new Error('should not query'); }) } as never;
    const result = await resolveRecipients(db, { kind: 'user', userId: 'u-xyz' });
    expect(result).toEqual(['u-xyz']);
    expect((db as { select: ReturnType<typeof vi.fn> }).select).not.toHaveBeenCalled();
  });
});
