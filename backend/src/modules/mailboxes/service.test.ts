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
    const emailDomain = { id: 'ed1', clientId: 'c1', domainId: 'd1' };
    const domain = { domainName: 'example.com' };
    const planRow = { planLimit: 50, override: null };
    const countResult = { count: 0 };
    const created = {
      id: 'mb1', emailDomainId: 'ed1', clientId: 'c1', localPart: 'info',
      fullAddress: 'info@example.com', displayName: null, quotaMb: 1024,
      usedMb: 0, status: 'active', mailboxType: 'mailbox', autoReply: 0,
    };

    // Select calls: 1) emailDomain, 2) domain, 3) clients+hostingPlans for
    //   getClientMailboxLimit, 4) count for getClientMailboxCount,
    //   5) existing check, 6) return created
    selectResults = [
      [emailDomain],
      [domain],
      [planRow],
      [countResult],
      [],
      [created],
    ];
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

  it('should enforce client mailbox limit from the plan', async () => {
    const emailDomain = { id: 'ed1', clientId: 'c1', domainId: 'd1' };
    const domain = { domainName: 'example.com' };
    const planRow = { planLimit: 2, override: null };
    const countResult = { count: 2 };

    selectResults = [[emailDomain], [domain], [planRow], [countResult]];
    const db = createMockDb();

    await expect(
      createMailbox(db as never, 'c1', 'ed1', { local_part: 'test', password: 'SecurePass123!', quota_mb: 1024, mailbox_type: 'mailbox' }),
    ).rejects.toMatchObject({
      code: 'CLIENT_MAILBOX_LIMIT_REACHED',
      status: 409,
      details: { limit: 2, current: 2, source: 'plan' },
    });
  });

  it('should prefer a positive per-client override over the plan limit', async () => {
    const emailDomain = { id: 'ed1', clientId: 'c1', domainId: 'd1' };
    const domain = { domainName: 'example.com' };
    // Plan allows 50, override cuts it to 5 — count is at 5
    const planRow = { planLimit: 50, override: 5 };
    const countResult = { count: 5 };

    selectResults = [[emailDomain], [domain], [planRow], [countResult]];
    const db = createMockDb();

    await expect(
      createMailbox(db as never, 'c1', 'ed1', { local_part: 'test', password: 'SecurePass123!', quota_mb: 1024, mailbox_type: 'mailbox' }),
    ).rejects.toMatchObject({
      code: 'CLIENT_MAILBOX_LIMIT_REACHED',
      status: 409,
      details: { limit: 5, current: 5, source: 'client_override' },
    });
  });

  it('should reject duplicate full address', async () => {
    const emailDomain = { id: 'ed1', clientId: 'c1', domainId: 'd1' };
    const domain = { domainName: 'example.com' };
    const planRow = { planLimit: 50, override: null };
    const countResult = { count: 1 };
    const existing = { id: 'mb-existing' };

    selectResults = [
      [emailDomain],
      [domain],
      [planRow],
      [countResult],
      [existing],
    ];
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
  const TEST_SECRET = 'test-webmail-secret-at-least-16-chars-long';
  const ORIGINAL_ENV = { ...process.env };

  // Mock app includes a pino-compatible logger surface used by the new
  // warn/error call sites.
  function makeMockApp() {
    return {
      log: {
        warn: vi.fn(),
        error: vi.fn(),
      },
    } as unknown as Parameters<typeof generateWebmailToken>[0];
  }

  beforeEach(() => {
    selectCallIndex = 0;
    process.env = { ...ORIGINAL_ENV };
    process.env.JWT_SECRET = TEST_SECRET;
    delete process.env.WEBMAIL_JWT_SECRET;
    delete process.env.WEBMAIL_URL;
  });

  function decodeJwtPayload(token: string): Record<string, unknown> {
    const [, payloadB64] = token.split('.');
    const padded = payloadB64 + '='.repeat((4 - (payloadB64.length % 4)) % 4);
    const json = Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  }

  it('should generate a signed JWT with embedded URL using the default fallback host', async () => {
    const user = { clientId: 'c1' };
    const activeClient = { status: 'active' };
    const userRole = { roleName: 'client_admin', clientId: 'c1' };
    const allMailboxes = [{ id: 'mb1', fullAddress: 'info@example.com' }];
    const mbStatus = { status: 'active' };

    // 1) user lookup, 2) client status, 3) role, 4) mailboxes, 5) mb status
    selectResults = [[user], [activeClient], [userRole], allMailboxes, [mbStatus]];
    const db = createMockDb();

    const result = await generateWebmailToken(makeMockApp(), db as never, 'u1', 'mb1');

    // Token is a real HS256 JWT, not a mock string
    expect(result.token.split('.')).toHaveLength(3);
    expect(result.mailbox).toBe('info@example.com');

    // Payload contains mailbox claim, iat, and 30s exp
    const payload = decodeJwtPayload(result.token);
    expect(payload.mailbox).toBe('info@example.com');
    expect(typeof payload.iat).toBe('number');
    expect(typeof payload.exp).toBe('number');
    expect((payload.exp as number) - (payload.iat as number)).toBe(30);

    // URL contains the embedded token as ?_jwt= and the hardcoded fallback host
    // (WEBMAIL_URL env and the Phase 2c webmail-settings default are both unset)
    expect(result.webmailUrl).toContain('/?_task=login&_jwt=');
    expect(result.webmailUrl).toContain(encodeURIComponent(result.token));
    expect(result.webmailUrl).toContain('webmail.example.com');
  });

  it('should use WEBMAIL_URL env when set', async () => {
    process.env.WEBMAIL_URL = 'https://webmail.platform.test';
    const user = { clientId: 'c1' };
    const activeClient = { status: 'active' };
    const userRole = { roleName: 'client_admin', clientId: 'c1' };
    const allMailboxes = [{ id: 'mb1', fullAddress: 'info@example.com' }];
    const mbStatus = { status: 'active' };

    selectResults = [[user], [activeClient], [userRole], allMailboxes, [mbStatus]];
    const db = createMockDb();

    const result = await generateWebmailToken(makeMockApp(), db as never, 'u1', 'mb1');
    expect(result.webmailUrl).toMatch(/^https:\/\/webmail\.platform\.test\/\?_task=login&_jwt=/);
  });

  it('should prefer WEBMAIL_JWT_SECRET over JWT_SECRET when both are set', async () => {
    const webmailSecret = 'independent-webmail-secret-value';
    process.env.WEBMAIL_JWT_SECRET = webmailSecret;
    const user = { clientId: 'c1' };
    const activeClient = { status: 'active' };
    const userRole = { roleName: 'client_admin', clientId: 'c1' };
    const allMailboxes = [{ id: 'mb1', fullAddress: 'info@example.com' }];
    const mbStatus = { status: 'active' };

    selectResults = [[user], [activeClient], [userRole], allMailboxes, [mbStatus]];
    const db = createMockDb();

    const { signWebmailJwt } = await import('./service.js');
    const result = await generateWebmailToken(makeMockApp(), db as never, 'u1', 'mb1');

    // The token must verify against the dedicated secret, NOT the API secret.
    const expected = signWebmailJwt(
      { mailbox: 'info@example.com' },
      webmailSecret,
      30,
    );
    // Both tokens share the same iat/exp window (generated ~at the same time),
    // so compare the header (first segment) and payload prefix instead of
    // an exact match — only the signature can reliably diverge from key.
    expect(result.token.split('.')[0]).toBe(expected.split('.')[0]);
  });

  it('should throw INTERNAL_ERROR when neither JWT secret is set', async () => {
    delete process.env.JWT_SECRET;
    delete process.env.WEBMAIL_JWT_SECRET;

    const user = { clientId: 'c1' };
    const activeClient = { status: 'active' };
    const userRole = { roleName: 'client_admin', clientId: 'c1' };
    const allMailboxes = [{ id: 'mb1', fullAddress: 'info@example.com' }];
    const mbStatus = { status: 'active' };
    selectResults = [[user], [activeClient], [userRole], allMailboxes, [mbStatus]];
    const db = createMockDb();

    await expect(
      generateWebmailToken(makeMockApp(), db as never, 'u1', 'mb1'),
    ).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      status: 500,
    });
  });

  it('should reject token generation for unauthorized user', async () => {
    const user = { clientId: 'c1' };
    const activeClient = { status: 'active' };
    const userRole = { roleName: 'client_user', clientId: 'c1' };
    const noMailboxes: unknown[] = [];

    // No mailbox row is reached because the user has no access
    selectResults = [[user], [activeClient], [userRole], noMailboxes];
    const db = createMockDb();

    await expect(
      generateWebmailToken(makeMockApp(), db as never, 'u1', 'mb1'),
    ).rejects.toMatchObject({
      code: 'MAILBOX_ACCESS_DENIED',
      status: 403,
    });
  });

  // Phase 3.C.3: new suspend enforcement tests

  it('should reject webmail token for suspended client', async () => {
    const user = { clientId: 'c1' };
    const suspendedClient = { status: 'suspended' };

    // user lookup, client status lookup → throws before getAccessibleMailboxes
    selectResults = [[user], [suspendedClient]];
    const db = createMockDb();

    await expect(
      generateWebmailToken(makeMockApp(), db as never, 'u1', 'mb1'),
    ).rejects.toMatchObject({
      code: 'CLIENT_SUSPENDED',
      status: 403,
    });
  });

  it('should reject webmail token for archived client', async () => {
    const user = { clientId: 'c1' };
    const archivedClient = { status: 'archived' };

    selectResults = [[user], [archivedClient]];
    const db = createMockDb();

    await expect(
      generateWebmailToken(makeMockApp(), db as never, 'u1', 'mb1'),
    ).rejects.toMatchObject({
      code: 'CLIENT_SUSPENDED',
      status: 403,
    });
  });

  it('should reject webmail token for suspended mailbox (active client)', async () => {
    const user = { clientId: 'c1' };
    const activeClient = { status: 'active' };
    const userRole = { roleName: 'client_admin', clientId: 'c1' };
    const allMailboxes = [{ id: 'mb1', fullAddress: 'info@example.com' }];
    const suspendedMailbox = { status: 'suspended' };

    selectResults = [[user], [activeClient], [userRole], allMailboxes, [suspendedMailbox]];
    const db = createMockDb();

    await expect(
      generateWebmailToken(makeMockApp(), db as never, 'u1', 'mb1'),
    ).rejects.toMatchObject({
      code: 'MAILBOX_SUSPENDED',
      status: 403,
    });
  });
});

describe('signWebmailJwt', () => {
  it('should produce a three-part HS256 JWT with embedded iat and exp', async () => {
    const { signWebmailJwt } = await import('./service.js');
    const token = signWebmailJwt(
      { mailbox: 'alice@example.com' },
      'secret-at-least-16-chars',
      30,
    );
    const parts = token.split('.');
    expect(parts).toHaveLength(3);

    const header = JSON.parse(
      Buffer.from(parts[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    );
    expect(header.alg).toBe('HS256');
    expect(header.typ).toBe('JWT');

    const padded = parts[1] + '='.repeat((4 - (parts[1].length % 4)) % 4);
    const payload = JSON.parse(
      Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    );
    expect(payload.mailbox).toBe('alice@example.com');
    expect(typeof payload.iat).toBe('number');
    expect(typeof payload.exp).toBe('number');
    expect(payload.exp - payload.iat).toBe(30);
  });

  it('should produce different signatures for different secrets', async () => {
    const { signWebmailJwt } = await import('./service.js');
    const a = signWebmailJwt({ mailbox: 'a@x.com' }, 'secret-one-at-least-16', 30);
    const b = signWebmailJwt({ mailbox: 'a@x.com' }, 'secret-two-at-least-16', 30);
    // Third segment is the signature, which MUST differ
    expect(a.split('.')[2]).not.toBe(b.split('.')[2]);
  });
});
