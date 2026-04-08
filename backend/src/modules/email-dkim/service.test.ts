import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock encryption — the DKIM service encrypts private keys at rest
// via ../oidc/crypto but we don't need real crypto in unit tests.
vi.mock('../oidc/crypto.js', () => ({
  encrypt: vi.fn((plain: string) => `encrypted:${plain}`),
  decrypt: vi.fn((cipher: string) => cipher.replace(/^encrypted:/, '')),
}));

// Mock DKIM key pair generator so tests are fast + deterministic.
vi.mock('../email-domains/dkim.js', () => ({
  generateDkimKeyPair: vi.fn(() => ({
    privateKey: '-----BEGIN PRIVATE KEY-----\nfake-private\n-----END PRIVATE KEY-----',
    publicKey: '-----BEGIN PUBLIC KEY-----\nfake-public-base64\n-----END PUBLIC KEY-----',
  })),
  formatDkimDnsValue: vi.fn((pk: string) => `v=DKIM1; k=rsa; p=${pk.replace(/[\s-]|BEGIN PUBLIC KEY|END PUBLIC KEY/g, '')}`),
}));

// Mock DNS provisioning so the primary-mode path can verify we call
// into dns-records without hitting a real provider.
vi.mock('../dns-records/service.js', () => ({
  syncRecordToProviders: vi.fn().mockResolvedValue(undefined),
}));

// Mock dns-servers authority helper
vi.mock('../dns-servers/authority.js', () => ({
  canManageDnsZone: vi.fn(),
}));

// Mock getActiveServersForDomain so it doesn't consume selectResults slots
vi.mock('../dns-servers/service.js', () => ({
  getActiveServersForDomain: vi.fn().mockResolvedValue([
    { id: 's1', providerType: 'powerdns', enabled: 1, role: 'primary' },
  ]),
}));

// ─── DB mock ──────────────────────────────────────────────────────────────

let selectResults: unknown[][];
let selectCallIndex: number;
let executeResults: { rows: unknown[] }[];
let executeCallIndex: number;
let insertImpl: () => Promise<void>;
let updateImpl: () => Promise<void>;
let deleteImpl: () => Promise<void>;

function createMockDb() {
  selectCallIndex = 0;
  executeCallIndex = 0;

  // A `where(...)` result is awaitable AND supports .orderBy().limit()
  // chaining for listDkimKeys. We return a PromiseLike object that
  // consumes one selectResults slot when awaited (or when
  // .orderBy().limit() is called — but only once either way).
  const makeWhereResult = () => {
    let consumed = false;
    const consume = (): unknown[] => {
      if (consumed) return [];
      consumed = true;
      const result = selectResults[selectCallIndex] ?? [];
      selectCallIndex += 1;
      return result;
    };
    const obj: {
      then: (onFulfilled: (v: unknown[]) => unknown) => Promise<unknown>;
      orderBy: (expr: unknown) => typeof obj;
      limit: (n: number) => Promise<unknown[]>;
    } = {
      then: (onFulfilled) => Promise.resolve(consume()).then(onFulfilled),
      orderBy: () => obj,
      limit: () => Promise.resolve(consume()),
    };
    return obj;
  };

  const whereFn = vi.fn().mockImplementation(() => makeWhereResult());

  const fromFn = vi.fn().mockReturnValue({ where: whereFn, innerJoin: vi.fn().mockReturnValue({ where: whereFn }) });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });

  const insertValues = vi.fn().mockImplementation(() => insertImpl());
  const insertFn = vi.fn().mockReturnValue({ values: insertValues });

  const updateWhere = vi.fn().mockImplementation(() => updateImpl());
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
  const updateFn = vi.fn().mockReturnValue({ set: updateSet });

  const deleteWhere = vi.fn().mockImplementation(() => deleteImpl());
  const deleteFn = vi.fn().mockReturnValue({ where: deleteWhere });

  const executeFn = vi.fn().mockImplementation(() => {
    const result = executeResults[executeCallIndex] ?? { rows: [] };
    executeCallIndex += 1;
    return Promise.resolve(result);
  });

  return {
    select: selectFn,
    insert: insertFn,
    update: updateFn,
    delete: deleteFn,
    execute: executeFn,
    _insertValues: insertValues,
    _updateSet: updateSet,
    _updateWhere: updateWhere,
    _deleteWhere: deleteWhere,
  } as unknown as ReturnType<typeof createMockDb>;
}

// Import after mocks
const service = await import('./service.js');
const authority = await import('../dns-servers/authority.js');
const dnsRecords = await import('../dns-records/service.js');

beforeEach(() => {
  selectResults = [];
  selectCallIndex = 0;
  executeResults = [];
  executeCallIndex = 0;
  insertImpl = () => Promise.resolve();
  updateImpl = () => Promise.resolve();
  deleteImpl = () => Promise.resolve();
  vi.mocked(authority.canManageDnsZone).mockReturnValue(true);
  // Reset the DNS sync spy so assertions about not-called don't leak
  // calls from prior tests.
  vi.mocked(dnsRecords.syncRecordToProviders).mockClear();
});

// ═══════════════════════════════════════════════════════════════════════════
// rotateDkimKey
// ═══════════════════════════════════════════════════════════════════════════

describe('rotateDkimKey', () => {
  // The mock DB returns rows as-is without applying Drizzle's column
  // projection mapping. The service's loadEmailDomainWithMode uses
  //   .select({ emailDomainId, domainId, clientId, domainName,
  //             dnsMode, selector })
  // so the returned row needs those field names directly.
  const emailDomain = {
    emailDomainId: 'ed1',
    domainId: 'd1',
    clientId: 'c1',
    selector: 'default',
  };
  const domain = {
    id: 'd1',
    clientId: 'c1',
    domainName: 'acme.com',
    dnsMode: 'primary',
  };
  it('generates a new key and marks it pending for primary-mode domains', async () => {
    // Select calls made by the service (activeServers is mocked externally
    // via getActiveServersForDomain — it does NOT consume a slot here):
    //   1) emailDomain + domain join
    //   2) existing selectors for collision check
    selectResults = [
      [{ ...emailDomain, domainName: domain.domainName, dnsMode: domain.dnsMode }],
      [], // no existing selectors with 'default-YYYY-MM' prefix
    ];
    const db = createMockDb();

    const result = await service.rotateDkimKey(
      db as never,
      'ed1',
      'test-key',
    );

    expect(result.status).toBe('active'); // primary mode auto-activates
    expect(result.mode).toBe('primary');
    expect(result.newSelector).toMatch(/^default-/);
    expect(result.dnsRecordName).toBe(`${result.newSelector}._domainkey.acme.com`);
    expect(result.dnsRecordValue).toContain('v=DKIM1');
    expect(db.insert).toHaveBeenCalled();
    // For primary mode, the DNS record should have been synced
    expect(dnsRecords.syncRecordToProviders).toHaveBeenCalled();
  });

  it('generates a pending key for cname-mode domains without writing DNS', async () => {
    vi.mocked(authority.canManageDnsZone).mockReturnValue(false);
    selectResults = [
      [{ ...emailDomain, domainName: domain.domainName, dnsMode: 'cname' }],
      [],
    ];
    const db = createMockDb();

    const result = await service.rotateDkimKey(
      db as never,
      'ed1',
      'test-key',
    );

    expect(result.status).toBe('pending');
    expect(result.mode).toBe('cname');
    expect(result.dnsRecordName).toBeDefined();
    expect(result.dnsRecordValue).toBeDefined();
    // For cname mode, the DNS record must NOT be written by the platform
    expect(dnsRecords.syncRecordToProviders).not.toHaveBeenCalled();
    // The result should include a manual setup message
    expect(result.manualDnsRequired).toBe(true);
  });

  it('generates a pending key for secondary-mode domains without writing DNS', async () => {
    vi.mocked(authority.canManageDnsZone).mockReturnValue(false);
    selectResults = [
      [{ ...emailDomain, domainName: domain.domainName, dnsMode: 'secondary' }],
      [],
    ];
    const db = createMockDb();

    const result = await service.rotateDkimKey(
      db as never,
      'ed1',
      'test-key',
    );

    expect(result.status).toBe('pending');
    expect(result.mode).toBe('secondary');
    expect(result.manualDnsRequired).toBe(true);
    expect(dnsRecords.syncRecordToProviders).not.toHaveBeenCalled();
  });

  it('generates a unique selector when the default selector already exists', async () => {
    selectResults = [
      [{ ...emailDomain, domainName: domain.domainName, dnsMode: 'primary' }],
      // Existing selectors — the new one must not collide
      [{ selector: 'default' }, { selector: 'default-202604' }],
    ];
    const db = createMockDb();

    const result = await service.rotateDkimKey(
      db as never,
      'ed1',
      'test-key',
    );

    expect(result.newSelector).not.toBe('default');
    expect(result.newSelector).not.toBe('default-202604');
  });

  it('throws EMAIL_DOMAIN_NOT_FOUND when the email domain is missing', async () => {
    selectResults = [[]];
    const db = createMockDb();

    await expect(
      service.rotateDkimKey(db as never, 'ghost', 'test-key'),
    ).rejects.toMatchObject({ code: 'EMAIL_DOMAIN_NOT_FOUND', status: 404 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// activatePendingKey (manual activation for cname/secondary mode)
// ═══════════════════════════════════════════════════════════════════════════

describe('activatePendingKey', () => {
  it('flips a pending key to active and sets activated_at', async () => {
    const pendingKey = {
      id: 'k1',
      emailDomainId: 'ed1',
      selector: 'default-202604',
      status: 'pending',
    };
    selectResults = [[pendingKey]];
    const db = createMockDb();

    const result = await service.activatePendingKey(db as never, 'k1');

    expect(result.status).toBe('active');
    expect(db.update).toHaveBeenCalled();
  });

  it('throws if the key is not in pending state', async () => {
    const activeKey = {
      id: 'k1',
      emailDomainId: 'ed1',
      selector: 'default-202604',
      status: 'active',
    };
    selectResults = [[activeKey]];
    const db = createMockDb();

    await expect(
      service.activatePendingKey(db as never, 'k1'),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('throws DKIM_KEY_NOT_FOUND when the key does not exist', async () => {
    selectResults = [[]];
    const db = createMockDb();

    await expect(
      service.activatePendingKey(db as never, 'ghost'),
    ).rejects.toMatchObject({ code: 'DKIM_KEY_NOT_FOUND', status: 404 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// listDkimKeys
// ═══════════════════════════════════════════════════════════════════════════

describe('listDkimKeys', () => {
  it('returns all keys for an email domain ordered by created_at DESC', async () => {
    const keys = [
      { id: 'k2', selector: 'default-202604', status: 'active', createdAt: new Date('2026-04-01') },
      { id: 'k1', selector: 'default', status: 'retired', createdAt: new Date('2026-01-01') },
    ];
    selectResults = [keys];
    const db = createMockDb();

    const result = await service.listDkimKeys(db as never, 'ed1');
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('k2');
  });

  it('returns an empty array when no keys exist', async () => {
    selectResults = [[]];
    const db = createMockDb();
    const result = await service.listDkimKeys(db as never, 'ed1');
    expect(result).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// retireOldKeys (cron entry point)
// ═══════════════════════════════════════════════════════════════════════════

describe('retireOldKeys', () => {
  it('retires stale keys via atomic SQL update (safeguarded to leave ≥1 active)', async () => {
    const oldKey = {
      id: 'k1',
      emailDomainId: 'ed1',
      selector: 'old',
      status: 'active',
      activatedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000), // 10 days ago
    };
    // The service first selects stale keys for reporting, then issues
    // a single atomic UPDATE via db.execute — the SQL itself ensures
    // the domain still has another active key at the moment of the
    // update, so we can't accidentally retire the only key.
    selectResults = [[oldKey]];
    executeResults = [{ rows: [{ id: 'k1' }] }]; // one row returned from UPDATE ... RETURNING
    const db = createMockDb();

    const result = await service.retireOldKeys(db as never, { graceDays: 7 });

    expect(result.retired).toBe(1);
    expect(db.execute).toHaveBeenCalled();
  });

  it('retires nothing when the atomic SQL returns no rows (safeguard hits)', async () => {
    const oldKey = {
      id: 'k1',
      emailDomainId: 'ed1',
      selector: 'old',
      status: 'active',
      activatedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
    };
    selectResults = [[oldKey]];
    // Atomic update returns zero rows because the domain only has one
    // active key — the correlated subquery filters it out.
    executeResults = [{ rows: [] }];
    const db = createMockDb();

    const result = await service.retireOldKeys(db as never, { graceDays: 7 });
    expect(result.retired).toBe(0);
  });

  it('leaves recent active keys alone (no execute call when scan is empty)', async () => {
    selectResults = [[]];
    const db = createMockDb();

    const result = await service.retireOldKeys(db as never, { graceDays: 7 });
    expect(result.retired).toBe(0);
    expect(db.execute).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// purgeRetiredKeys (cron entry point)
// ═══════════════════════════════════════════════════════════════════════════

describe('purgeRetiredKeys', () => {
  it('deletes retired keys older than retentionDays and removes the DNS TXT for primary-mode domains', async () => {
    const oldRetired = {
      id: 'k1',
      emailDomainId: 'ed1',
      selector: 'old',
      status: 'retired',
      publicKey: '-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----',
      retiredAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000), // 40 days ago
    };
    // Select calls:
    //   1) scan of stale retired keys      → [oldRetired]
    //   2) loadEmailDomainWithMode lookup  → primary-mode parent
    selectResults = [
      [oldRetired],
      [
        {
          emailDomainId: 'ed1',
          domainId: 'd1',
          clientId: 'c1',
          domainName: 'acme.com',
          dnsMode: 'primary',
          selector: 'default',
        },
      ],
    ];
    const db = createMockDb();

    const result = await service.purgeRetiredKeys(db as never, { retentionDays: 30 });
    expect(result.purged).toBe(1);
    expect(result.dnsRemoved).toBe(1);
    expect(db.delete).toHaveBeenCalled();
    expect(dnsRecords.syncRecordToProviders).toHaveBeenCalledWith(
      expect.anything(),
      'acme.com',
      'delete',
      expect.objectContaining({
        type: 'TXT',
        name: 'old._domainkey.acme.com',
      }),
      'd1',
    );
  });

  it('skips DNS removal for cname-mode domains (operator manages their own zone)', async () => {
    const oldRetired = {
      id: 'k1',
      emailDomainId: 'ed1',
      selector: 'old',
      status: 'retired',
      publicKey: '-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----',
      retiredAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
    };
    selectResults = [
      [oldRetired],
      [
        {
          emailDomainId: 'ed1',
          domainId: 'd1',
          clientId: 'c1',
          domainName: 'acme.com',
          dnsMode: 'cname',
          selector: 'default',
        },
      ],
    ];
    const db = createMockDb();

    const result = await service.purgeRetiredKeys(db as never, { retentionDays: 30 });
    expect(result.purged).toBe(1);
    expect(result.dnsRemoved).toBe(0);
    expect(db.delete).toHaveBeenCalled();
    expect(dnsRecords.syncRecordToProviders).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// autoRotatePrimaryDomains (cron entry point)
// ═══════════════════════════════════════════════════════════════════════════

describe('autoRotatePrimaryDomains', () => {
  it('rotates stale primary-mode email domains returned by the scan', async () => {
    // 1 candidate returned from the raw SQL query
    executeResults = [
      {
        rows: [
          { email_domain_id: 'ed1', newest_active_at: new Date('2020-01-01') },
        ],
      },
    ];
    // rotateDkimKey is called recursively for each candidate. It
    // does:
    //   1) loadEmailDomainWithMode  → selectResults[0]
    //   2) existing selectors       → selectResults[1]
    selectResults = [
      [
        {
          emailDomainId: 'ed1',
          domainId: 'd1',
          clientId: 'c1',
          domainName: 'acme.com',
          dnsMode: 'primary',
          selector: 'default',
        },
      ],
      [],
    ];
    const db = createMockDb();

    const result = await service.autoRotatePrimaryDomains(
      db as never,
      'test-key',
      { rotationAgeDays: 90 },
    );

    expect(result.rotated).toBe(1);
    expect(result.errors).toBe(0);
    // DNS sync MUST have been called for primary mode
    expect(dnsRecords.syncRecordToProviders).toHaveBeenCalled();
  });

  it('returns zero when no candidates are stale', async () => {
    executeResults = [{ rows: [] }];
    const db = createMockDb();

    const result = await service.autoRotatePrimaryDomains(
      db as never,
      'test-key',
      { rotationAgeDays: 90 },
    );

    expect(result.rotated).toBe(0);
    expect(result.errors).toBe(0);
    expect(dnsRecords.syncRecordToProviders).not.toHaveBeenCalled();
  });

  it('counts errors when a single rotation throws', async () => {
    executeResults = [
      {
        rows: [
          { email_domain_id: 'ed-missing', newest_active_at: null },
        ],
      },
    ];
    // loadEmailDomainWithMode returns empty → rotateDkimKey throws
    // EMAIL_DOMAIN_NOT_FOUND. autoRotatePrimaryDomains catches and
    // counts as error, not bailing out of the whole scan.
    selectResults = [[]];
    const db = createMockDb();

    const result = await service.autoRotatePrimaryDomains(
      db as never,
      'test-key',
    );

    expect(result.rotated).toBe(0);
    expect(result.errors).toBe(1);
  });
});
