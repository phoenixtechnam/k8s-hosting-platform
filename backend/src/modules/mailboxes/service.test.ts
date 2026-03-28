import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiError } from '../../shared/errors.js';

// Mock bcrypt
vi.mock('bcrypt', () => ({
  default: {
    hash: vi.fn().mockResolvedValue('$2b$12$hashed'),
  },
}));

// Track select call results per test
let selectResults: unknown[][];
let selectCallIndex: number;

function createMockDb() {
  selectCallIndex = 0;

  const innerJoinFn = vi.fn().mockImplementation(() => ({
    where: vi.fn().mockImplementation(() => {
      const result = selectResults[selectCallIndex] ?? [];
      selectCallIndex++;
      return Promise.resolve(result);
    }),
  }));

  const whereFn = vi.fn().mockImplementation(() => {
    const result = selectResults[selectCallIndex] ?? [];
    selectCallIndex++;
    return Promise.resolve(result);
  });

  const fromFn = vi.fn().mockReturnValue({
    where: whereFn,
    innerJoin: innerJoinFn,
  });

  const selectFn = vi.fn().mockReturnValue({ from: fromFn });

  const insertValues = vi.fn().mockResolvedValue(undefined);
  const insertFn = vi.fn().mockReturnValue({ values: insertValues });

  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
  const updateFn = vi.fn().mockReturnValue({ set: updateSet });

  const deleteWhere = vi.fn().mockResolvedValue(undefined);
  const deleteFn = vi.fn().mockReturnValue({ where: deleteWhere });

  return {
    select: selectFn,
    insert: insertFn,
    update: updateFn,
    delete: deleteFn,
    _insertValues: insertValues,
    _deleteFn: deleteFn,
    _deleteWhere: deleteWhere,
  } as unknown as ReturnType<typeof createMockDb>;
}

// Import after mocks
const { createMailbox, getMailbox, listMailboxes, updateMailbox, deleteMailbox, grantMailboxAccess, revokeMailboxAccess, getAccessibleMailboxes, generateWebmailToken } = await import('./service.js');

describe('createMailbox', () => {
  beforeEach(() => {
    selectCallIndex = 0;
  });

  it('should create a mailbox and hash the password', async () => {
    const emailDomain = { id: 'ed1', clientId: 'c1', domainId: 'd1', maxMailboxes: 50 };
    const domain = { domainName: 'example.com' };
    const countResult = { count: 0 };
    const created = {
      id: 'mb1', emailDomainId: 'ed1', clientId: 'c1', localPart: 'info',
      fullAddress: 'info@example.com', displayName: null, quotaMb: 1024,
      usedMb: 0, status: 'active', mailboxType: 'mailbox', autoReply: 0,
    };

    // Select calls: 1) emailDomain, 2) domain, 3) count, 4) existing check, 5) return created
    selectResults = [[emailDomain], [domain], [countResult], [], [created]];
    const db = createMockDb();

    const result = await createMailbox(
      db as never,
      'c1',
      'ed1',
      { local_part: 'info', password: 'SecurePass123!', quota_mb: 1024, mailbox_type: 'mailbox' },
    );

    expect(result.fullAddress).toBe('info@example.com');
    expect(result).not.toHaveProperty('passwordHash');
    expect((db as unknown as { insert: ReturnType<typeof vi.fn> }).insert).toHaveBeenCalled();
  });

  it('should enforce max mailbox limit', async () => {
    const emailDomain = { id: 'ed1', clientId: 'c1', domainId: 'd1', maxMailboxes: 2 };
    const domain = { domainName: 'example.com' };
    const countResult = { count: 2 };

    selectResults = [[emailDomain], [domain], [countResult]];
    const db = createMockDb();

    await expect(
      createMailbox(db as never, 'c1', 'ed1', { local_part: 'test', password: 'SecurePass123!', quota_mb: 1024, mailbox_type: 'mailbox' }),
    ).rejects.toMatchObject({
      code: 'MAILBOX_LIMIT_REACHED',
      status: 409,
    });
  });

  it('should reject duplicate full address', async () => {
    const emailDomain = { id: 'ed1', clientId: 'c1', domainId: 'd1', maxMailboxes: 50 };
    const domain = { domainName: 'example.com' };
    const countResult = { count: 1 };
    const existing = { id: 'mb-existing' };

    selectResults = [[emailDomain], [domain], [countResult], [existing]];
    const db = createMockDb();

    await expect(
      createMailbox(db as never, 'c1', 'ed1', { local_part: 'info', password: 'SecurePass123!', quota_mb: 1024, mailbox_type: 'mailbox' }),
    ).rejects.toMatchObject({
      code: 'DUPLICATE_ENTRY',
      status: 409,
    });
  });

  it('should throw EMAIL_DOMAIN_NOT_FOUND for missing email domain', async () => {
    selectResults = [[]];
    const db = createMockDb();

    await expect(
      createMailbox(db as never, 'c1', 'missing-ed', { local_part: 'info', password: 'SecurePass123!', quota_mb: 1024, mailbox_type: 'mailbox' }),
    ).rejects.toMatchObject({
      code: 'EMAIL_DOMAIN_NOT_FOUND',
      status: 404,
    });
  });
});

describe('listMailboxes', () => {
  it('should return mailboxes without passwordHash', async () => {
    const rows = [
      { id: 'mb1', fullAddress: 'a@example.com', quotaMb: 1024 },
      { id: 'mb2', fullAddress: 'b@example.com', quotaMb: 2048 },
    ];
    selectResults = [rows];
    const db = createMockDb();

    const result = await listMailboxes(db as never, 'c1');
    expect(result).toHaveLength(2);
    expect(result[0]).not.toHaveProperty('passwordHash');
  });
});

describe('getMailbox', () => {
  it('should return a mailbox when found', async () => {
    const mailbox = { id: 'mb1', clientId: 'c1', fullAddress: 'info@example.com' };
    selectResults = [[mailbox]];
    const db = createMockDb();

    const result = await getMailbox(db as never, 'c1', 'mb1');
    expect(result).toEqual(mailbox);
  });

  it('should throw MAILBOX_NOT_FOUND when not found', async () => {
    selectResults = [[]];
    const db = createMockDb();

    await expect(getMailbox(db as never, 'c1', 'missing')).rejects.toMatchObject({
      code: 'MAILBOX_NOT_FOUND',
      status: 404,
    });
  });
});

describe('updateMailbox', () => {
  it('should rehash password if provided', async () => {
    const mailbox = { id: 'mb1', clientId: 'c1', fullAddress: 'info@example.com' };
    const updated = { ...mailbox, displayName: 'Updated' };

    // 1) getMailbox select, 2) return updated after update
    selectResults = [[mailbox], [updated]];
    const db = createMockDb();

    const result = await updateMailbox(db as never, 'c1', 'mb1', {
      password: 'NewPassword123!',
      display_name: 'Updated',
    });

    expect(result.displayName).toBe('Updated');
    expect((db as unknown as { update: ReturnType<typeof vi.fn> }).update).toHaveBeenCalled();
  });
});

describe('deleteMailbox', () => {
  it('should delete access rows and then the mailbox', async () => {
    const mailbox = { id: 'mb1', clientId: 'c1' };
    selectResults = [[mailbox]];
    const db = createMockDb();

    await expect(deleteMailbox(db as never, 'c1', 'mb1')).resolves.toBeUndefined();
    // delete is called twice: once for mailboxAccess, once for mailboxes
    expect((db as unknown as { delete: ReturnType<typeof vi.fn> }).delete).toHaveBeenCalledTimes(2);
  });

  it('should throw MAILBOX_NOT_FOUND when mailbox does not exist', async () => {
    selectResults = [[]];
    const db = createMockDb();

    await expect(deleteMailbox(db as never, 'c1', 'missing')).rejects.toMatchObject({
      code: 'MAILBOX_NOT_FOUND',
      status: 404,
    });
  });
});

describe('grantMailboxAccess / revokeMailboxAccess', () => {
  it('should grant access and return the record', async () => {
    const created = { id: 'ma1', userId: 'u1', mailboxId: 'mb1', accessLevel: 'full' };
    selectResults = [[created]];
    const db = createMockDb();

    const result = await grantMailboxAccess(db as never, 'mb1', 'u1', 'full');
    expect(result).toEqual(created);
    expect((db as unknown as { insert: ReturnType<typeof vi.fn> }).insert).toHaveBeenCalled();
  });

  it('should revoke access by deleting the row', async () => {
    selectResults = [];
    const db = createMockDb();

    await expect(revokeMailboxAccess(db as never, 'mb1', 'u1')).resolves.toBeUndefined();
    expect((db as unknown as { delete: ReturnType<typeof vi.fn> }).delete).toHaveBeenCalled();
  });
});

describe('getAccessibleMailboxes', () => {
  it('should return all client mailboxes for client_admin', async () => {
    const user = { roleName: 'client_admin', clientId: 'c1' };
    const allMailboxes = [
      { id: 'mb1', fullAddress: 'a@example.com' },
      { id: 'mb2', fullAddress: 'b@example.com' },
    ];

    // 1) user lookup, 2) mailboxes for client
    selectResults = [[user], allMailboxes];
    const db = createMockDb();

    const result = await getAccessibleMailboxes(db as never, 'u1', 'c1');
    expect(result).toHaveLength(2);
  });

  it('should return only assigned mailboxes for client_user', async () => {
    const user = { roleName: 'client_user', clientId: 'c1' };
    const assignedMailboxes = [{ id: 'mb1', fullAddress: 'a@example.com' }];

    // 1) user lookup, 2) joined mailbox_access + mailboxes
    selectResults = [[user], assignedMailboxes];
    const db = createMockDb();

    const result = await getAccessibleMailboxes(db as never, 'u1', 'c1');
    expect(result).toHaveLength(1);
    expect(result[0].fullAddress).toBe('a@example.com');
  });

  it('should throw USER_NOT_FOUND for missing user', async () => {
    selectResults = [[]];
    const db = createMockDb();

    await expect(getAccessibleMailboxes(db as never, 'missing', 'c1')).rejects.toMatchObject({
      code: 'USER_NOT_FOUND',
      status: 404,
    });
  });
});

describe('generateWebmailToken', () => {
  it('should generate a token for an authorized user', async () => {
    const user = { clientId: 'c1' };
    const userRole = { roleName: 'client_admin', clientId: 'c1' };
    const allMailboxes = [
      { id: 'mb1', fullAddress: 'info@example.com' },
    ];

    // 1) user clientId lookup, 2) getAccessibleMailboxes -> user role, 3) mailboxes
    selectResults = [[user], [userRole], allMailboxes];
    const db = createMockDb();

    const mockApp = {
      jwt: {
        sign: vi.fn().mockReturnValue('jwt-token-123'),
      },
    } as unknown as Parameters<typeof generateWebmailToken>[0];

    const result = await generateWebmailToken(mockApp, db as never, 'u1', 'mb1');
    expect(result.token).toBe('jwt-token-123');
    expect(result.mailbox).toBe('info@example.com');
    expect(result.webmailUrl).toBeDefined();
  });

  it('should reject token generation for unauthorized user', async () => {
    const user = { clientId: 'c1' };
    const userRole = { roleName: 'client_user', clientId: 'c1' };
    // client_user has no access rows -> empty result
    const noMailboxes: unknown[] = [];

    selectResults = [[user], [userRole], noMailboxes];
    const db = createMockDb();

    const mockApp = {
      jwt: {
        sign: vi.fn(),
      },
    } as unknown as Parameters<typeof generateWebmailToken>[0];

    await expect(
      generateWebmailToken(mockApp, db as never, 'u1', 'mb1'),
    ).rejects.toMatchObject({
      code: 'MAILBOX_ACCESS_DENIED',
      status: 403,
    });
  });
});
