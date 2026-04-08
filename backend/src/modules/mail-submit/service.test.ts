import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock bcrypt — we don't need real hashing in unit tests.
vi.mock('bcrypt', () => ({
  default: {
    hash: vi.fn(async (plain: string) => `bcrypt:${plain}`),
    compare: vi.fn(async (plain: string, hash: string) => hash === `bcrypt:${plain}`),
  },
}));

// Mock crypto (the oidc module) used to encrypt the plain password
// at rest.
vi.mock('../oidc/crypto.js', () => ({
  encrypt: vi.fn((plain: string) => `encrypted:${plain}`),
  decrypt: vi.fn((cipher: string) => cipher.replace(/^encrypted:/, '')),
}));

// ─── Mock DB ────────────────────────────────────────────────────────────────

let selectResults: unknown[][];
let selectCallIndex: number;
let insertImpl: () => Promise<void>;
let updateImpl: () => Promise<void>;

function createMockDb() {
  selectCallIndex = 0;

  const whereFn = vi.fn().mockImplementation(() => {
    const result = selectResults[selectCallIndex] ?? [];
    selectCallIndex += 1;
    return Promise.resolve(result);
  });
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });

  const insertValues = vi.fn().mockImplementation(() => insertImpl());
  const insertFn = vi.fn().mockReturnValue({ values: insertValues });

  const updateWhere = vi.fn().mockImplementation(() => updateImpl());
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
  const updateFn = vi.fn().mockReturnValue({ set: updateSet });

  const mockDb = {
    select: selectFn,
    insert: insertFn,
    update: updateFn,
    _insertValues: insertValues,
    _updateSet: updateSet,
  };

  // Phase 3 T5.1: rotateSubmitCredential wraps its work in
  // db.transaction(...). The mock passes the same mockDb object
  // through as the transaction handle so callers behave identically
  // whether they run inside or outside a transaction. This does NOT
  // simulate rollback semantics — the unit tests rely on explicit
  // per-test state.
  const transactionFn = vi.fn().mockImplementation(
    async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDb),
  );
  (mockDb as unknown as { transaction: typeof transactionFn }).transaction = transactionFn;

  return mockDb as unknown as ReturnType<typeof createMockDb>;
}

const service = await import('./service.js');

beforeEach(() => {
  selectResults = [];
  selectCallIndex = 0;
  insertImpl = () => Promise.resolve();
  updateImpl = () => Promise.resolve();
});

// ═══════════════════════════════════════════════════════════════════════════
// generateSubmitCredential
// ═══════════════════════════════════════════════════════════════════════════

describe('generateSubmitCredential', () => {
  it('creates a new active credential for a client with deterministic username', async () => {
    // No existing credentials → insert new row
    selectResults = [[]];
    const db = createMockDb();

    const result = await service.generateSubmitCredential(
      db as never,
      'client-abc-123',
      'test-key',
    );

    expect(result.username).toBe('submit-client-abc-123');
    expect(result.password).toMatch(/^[A-Za-z0-9+/=]{32,}$/); // base64 password
    expect(result.id).toBeDefined();
    expect(db.insert).toHaveBeenCalled();
  });

  it('generates a unique password each time (random)', async () => {
    selectResults = [[]];
    const db1 = createMockDb();
    const result1 = await service.generateSubmitCredential(db1 as never, 'c1', 'k');

    selectResults = [[]];
    const db2 = createMockDb();
    const result2 = await service.generateSubmitCredential(db2 as never, 'c1', 'k');

    expect(result1.password).not.toBe(result2.password);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// rotateSubmitCredential
// ═══════════════════════════════════════════════════════════════════════════

describe('rotateSubmitCredential', () => {
  it('revokes the existing active credential and generates a new one', async () => {
    const existing = {
      id: 'old-id',
      clientId: 'c1',
      username: 'submit-c1',
      passwordEncrypted: 'encrypted:oldpw',
      passwordHash: 'bcrypt:oldpw',
      revokedAt: null,
    };
    // First select: loadActiveCredential returns existing
    // Second select: generateSubmitCredential's own scan (after revoke)
    selectResults = [[existing], []];
    const db = createMockDb();

    const result = await service.rotateSubmitCredential(
      db as never,
      'c1',
      'test-key',
      { note: 'manual rotation' },
    );

    // Old row should have been updated (revoked)
    expect(db.update).toHaveBeenCalled();
    // New row should have been inserted
    expect(db.insert).toHaveBeenCalled();
    expect(result.username).toBe('submit-c1');
    expect(result.id).not.toBe('old-id');
  });

  it('still generates a new credential when no active one exists', async () => {
    selectResults = [[], []]; // no existing + no existing after non-revoke
    const db = createMockDb();

    const result = await service.rotateSubmitCredential(db as never, 'c1', 'test-key');

    expect(db.update).not.toHaveBeenCalled(); // nothing to revoke
    expect(db.insert).toHaveBeenCalled();
    expect(result.username).toBe('submit-c1');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// loadActiveCredential
// ═══════════════════════════════════════════════════════════════════════════

describe('loadActiveCredential', () => {
  it('returns the active (non-revoked) credential', async () => {
    const active = {
      id: 'k1',
      clientId: 'c1',
      username: 'submit-c1',
      revokedAt: null,
    };
    selectResults = [[active]];
    const db = createMockDb();

    const result = await service.loadActiveCredential(db as never, 'c1');
    expect(result?.id).toBe('k1');
  });

  it('returns null when no credential exists', async () => {
    selectResults = [[]];
    const db = createMockDb();

    const result = await service.loadActiveCredential(db as never, 'c-missing');
    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// buildAuthFileContent
// ═══════════════════════════════════════════════════════════════════════════

describe('buildAuthFileContent', () => {
  it('produces an msmtprc-style config with the required fields', () => {
    const content = service.buildAuthFileContent({
      username: 'submit-c1',
      password: 'top-secret',
      mailHost: 'mail.platform.internal',
      mailPort: 587,
      defaultFrom: 'noreply@example.com',
    });

    expect(content).toContain('host mail.platform.internal');
    expect(content).toContain('port 587');
    expect(content).toContain('user submit-c1');
    expect(content).toContain('password top-secret');
    expect(content).toContain('from noreply@example.com');
    expect(content).toContain('auth on');
    expect(content).toContain('tls on');
  });

  it('omits the "from" directive when defaultFrom is not provided', () => {
    const content = service.buildAuthFileContent({
      username: 'submit-c1',
      password: 'pw',
      mailHost: 'mail.local',
      mailPort: 587,
    });
    expect(content).not.toContain('from ');
  });
});
