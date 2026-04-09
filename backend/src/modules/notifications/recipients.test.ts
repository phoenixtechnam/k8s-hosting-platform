import { describe, it, expect, vi } from 'vitest';
import { getClientNotificationRecipients } from './recipients.js';

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
