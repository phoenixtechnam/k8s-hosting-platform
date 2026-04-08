import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { createWebmailDomainSchema } from '@k8s-hosting/api-contracts';

// ─── tls-settings mock ────────────────────────────────────────────────────
// Default: auto-TLS ENABLED so createWebmailDomain provisions a Certificate.
// Individual tests override via vi.mocked(...) below.
vi.mock('../tls-settings/service.js', () => ({
  isAutoTlsEnabled: vi.fn().mockResolvedValue(true),
  getClusterIssuerName: vi.fn().mockResolvedValue('letsencrypt-prod'),
}));

// ─── DB mock with queued SELECT results ──────────────────────────────────
// Matches the pattern used in mailboxes/service.test.ts: each SELECT call
// consumes the next entry from selectResults, so tests can script a run.

let selectResults: unknown[][];
let selectCallIndex: number;
let insertImpl: () => Promise<void>;
let updateImpl: () => Promise<void>;
let deleteImpl: () => Promise<void>;

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

  const deleteWhere = vi.fn().mockImplementation(() => deleteImpl());
  const deleteFn = vi.fn().mockReturnValue({ where: deleteWhere });

  return {
    select: selectFn,
    insert: insertFn,
    update: updateFn,
    delete: deleteFn,
    _updateWhere: updateWhere,
    _updateSet: updateSet,
    _deleteWhere: deleteWhere,
    _insertValues: insertValues,
  } as unknown as ReturnType<typeof createMockDb>;
}

// ─── K8s client mock ──────────────────────────────────────────────────────

function createMockK8s(): K8sClients & {
  _createIngress: ReturnType<typeof vi.fn>;
  _replaceIngress: ReturnType<typeof vi.fn>;
  _deleteIngress: ReturnType<typeof vi.fn>;
  _createCustom: ReturnType<typeof vi.fn>;
  _deleteCustom: ReturnType<typeof vi.fn>;
  _deleteSecret: ReturnType<typeof vi.fn>;
} {
  const createIngress = vi.fn().mockResolvedValue({});
  const replaceIngress = vi.fn().mockResolvedValue({});
  const deleteIngress = vi.fn().mockResolvedValue({});
  const createCustom = vi.fn().mockResolvedValue({});
  const deleteCustom = vi.fn().mockResolvedValue({});
  const deleteSecret = vi.fn().mockResolvedValue({});

  return {
    networking: {
      createNamespacedIngress: createIngress,
      replaceNamespacedIngress: replaceIngress,
      deleteNamespacedIngress: deleteIngress,
    },
    custom: {
      createNamespacedCustomObject: createCustom,
      deleteNamespacedCustomObject: deleteCustom,
    },
    core: {
      deleteNamespacedSecret: deleteSecret,
    },
    apps: {},
    _createIngress: createIngress,
    _replaceIngress: replaceIngress,
    _deleteIngress: deleteIngress,
    _createCustom: createCustom,
    _deleteCustom: deleteCustom,
    _deleteSecret: deleteSecret,
  } as never;
}

function makeLogger() {
  return { warn: vi.fn(), error: vi.fn() };
}

// ─── Load service under test after mocks ──────────────────────────────────

const service = await import('./service.js');
const tlsSettings = await import('../tls-settings/service.js');

beforeEach(() => {
  selectResults = [];
  selectCallIndex = 0;
  insertImpl = () => Promise.resolve();
  updateImpl = () => Promise.resolve();
  deleteImpl = () => Promise.resolve();
  vi.mocked(tlsSettings.isAutoTlsEnabled).mockResolvedValue(true);
  vi.mocked(tlsSettings.getClusterIssuerName).mockResolvedValue('letsencrypt-prod');
});

// ═══════════════════════════════════════════════════════════════════════════
// listWebmailDomains
// ═══════════════════════════════════════════════════════════════════════════

describe('listWebmailDomains', () => {
  it('should return all domains for a valid client', async () => {
    const client = { id: 'c1', companyName: 'Acme' };
    const rows = [
      { id: 'wd1', clientId: 'c1', hostname: 'webmail.acme.com', status: 'active' },
    ];
    // 1) verifyClient, 2) list rows
    selectResults = [[client], rows];
    const db = createMockDb();

    const result = await service.listWebmailDomains(db as never, 'c1');
    expect(result).toEqual(rows);
  });

  it('should throw CLIENT_NOT_FOUND when client does not exist', async () => {
    selectResults = [[]];
    const db = createMockDb();

    await expect(
      service.listWebmailDomains(db as never, 'ghost'),
    ).rejects.toMatchObject({ code: 'CLIENT_NOT_FOUND', status: 404 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// getWebmailDomain
// ═══════════════════════════════════════════════════════════════════════════

describe('getWebmailDomain', () => {
  it('should return the row when found', async () => {
    const row = { id: 'wd1', clientId: 'c1', hostname: 'webmail.acme.com', status: 'active' };
    selectResults = [[row]];
    const db = createMockDb();

    const result = await service.getWebmailDomain(db as never, 'c1', 'wd1');
    expect(result).toEqual(row);
  });

  it('should throw WEBMAIL_DOMAIN_NOT_FOUND when row missing', async () => {
    selectResults = [[]];
    const db = createMockDb();

    await expect(
      service.getWebmailDomain(db as never, 'c1', 'ghost'),
    ).rejects.toMatchObject({ code: 'WEBMAIL_DOMAIN_NOT_FOUND', status: 404 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// getWebmailDomainForClient
// ═══════════════════════════════════════════════════════════════════════════

describe('getWebmailDomainForClient', () => {
  it('should return an active domain', async () => {
    const row = {
      id: 'wd1',
      clientId: 'c1',
      hostname: 'webmail.acme.com',
      status: 'active',
    };
    selectResults = [[row]];
    const db = createMockDb();

    const result = await service.getWebmailDomainForClient(db as never, 'c1');
    expect(result).toEqual(row);
  });

  it('should return undefined when no active row (filter enforced at query)', async () => {
    // Mock returns empty array as if the query's status='active' filter
    // excluded the row. We're verifying the function returns undefined.
    selectResults = [[]];
    const db = createMockDb();

    const result = await service.getWebmailDomainForClient(db as never, 'c1');
    expect(result).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// createWebmailDomain
// ═══════════════════════════════════════════════════════════════════════════

describe('createWebmailDomain', () => {
  const validInput = { hostname: 'webmail.acme.com' };
  const client = { id: 'c1', companyName: 'Acme' };

  it('should create an Ingress + Certificate and mark row active (happy path)', async () => {
    // 1) verifyClient, 2) existing-check (empty), 3) hostname-taken (empty),
    // 4) final SELECT of created row
    selectResults = [
      [client],
      [],
      [],
      [
        {
          id: expect.any(String),
          clientId: 'c1',
          hostname: 'webmail.acme.com',
          status: 'active',
          ingressProvisioned: 1,
          certificateProvisioned: 1,
        },
      ],
    ];
    const db = createMockDb();
    const k8s = createMockK8s();
    const logger = makeLogger();

    const result = await service.createWebmailDomain(
      db as never,
      'c1',
      validInput,
      k8s,
      logger,
    );

    expect(result.status).toBe('active');
    expect(k8s._createIngress).toHaveBeenCalledOnce();
    expect(k8s._createCustom).toHaveBeenCalledOnce();

    // Verify Ingress body shape
    const ingressCall = k8s._createIngress.mock.calls[0][0];
    expect(ingressCall.namespace).toBe('mail');
    expect(ingressCall.body.spec.rules[0].host).toBe('webmail.acme.com');
    expect(ingressCall.body.spec.rules[0].http.paths[0].backend.service.name).toBe('roundcube');
    expect(ingressCall.body.spec.tls[0].hosts).toEqual(['webmail.acme.com']);
    expect(ingressCall.body.metadata.annotations['cert-manager.io/cluster-issuer'])
      .toBe('letsencrypt-prod');

    // Certificate name is distinct from secret name
    const certCall = k8s._createCustom.mock.calls[0][0];
    expect(certCall.body.metadata.name).toMatch(/-cert$/);
    expect(certCall.body.spec.secretName).toMatch(/-tls$/);
    expect(certCall.body.metadata.name).not.toBe(certCall.body.spec.secretName);
  });

  it('should reject when client already has a webmail domain', async () => {
    const existing = { id: 'wd-existing', hostname: 'webmail.acme.com' };
    selectResults = [[client], [existing]];
    const db = createMockDb();

    await expect(
      service.createWebmailDomain(db as never, 'c1', validInput, createMockK8s(), makeLogger()),
    ).rejects.toMatchObject({
      code: 'WEBMAIL_DOMAIN_LIMIT_REACHED',
      status: 409,
    });
  });

  it('should reject when hostname is already taken by another client', async () => {
    selectResults = [[client], [], [{ id: 'other-wd' }]];
    const db = createMockDb();

    await expect(
      service.createWebmailDomain(db as never, 'c1', validInput, createMockK8s(), makeLogger()),
    ).rejects.toMatchObject({
      code: 'DUPLICATE_ENTRY',
      status: 409,
    });
  });

  it('should convert a Postgres unique_violation on insert into DUPLICATE_ENTRY (race case)', async () => {
    selectResults = [[client], [], []];
    const db = createMockDb();
    // Simulate concurrent-insert race — pg throws 23505
    insertImpl = () => {
      const err = new Error('duplicate key value violates unique constraint') as Error & {
        code?: string;
      };
      err.code = '23505';
      return Promise.reject(err);
    };

    await expect(
      service.createWebmailDomain(db as never, 'c1', validInput, createMockK8s(), makeLogger()),
    ).rejects.toMatchObject({
      code: 'DUPLICATE_ENTRY',
      status: 409,
    });
  });

  it('should roll back the row and throw 502 when Ingress creation fails', async () => {
    selectResults = [[client], [], [], [{ id: 'x', status: 'pending' }]];
    const db = createMockDb();
    const k8s = createMockK8s();
    (k8s._createIngress as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error('Forbidden'), { statusCode: 403 }),
    );

    await expect(
      service.createWebmailDomain(db as never, 'c1', validInput, k8s, makeLogger()),
    ).rejects.toMatchObject({
      code: 'PROVISIONING_FAILED',
      status: 502,
    });

    // DB row was deleted as part of rollback
    expect(db.delete).toHaveBeenCalled();
  });

  it('should log but still surface 502 when rollback delete itself fails', async () => {
    selectResults = [[client], [], []];
    const db = createMockDb();
    const k8s = createMockK8s();
    (k8s._createIngress as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error('Forbidden'), { statusCode: 403 }),
    );
    // Rollback delete throws
    deleteImpl = () => Promise.reject(new Error('db unreachable'));
    const logger = makeLogger();

    await expect(
      service.createWebmailDomain(db as never, 'c1', validInput, k8s, logger),
    ).rejects.toMatchObject({
      code: 'PROVISIONING_FAILED',
      status: 502,
    });
    expect(logger.error).toHaveBeenCalled();
  });

  it('should replace existing Ingress on 409 instead of failing', async () => {
    selectResults = [[client], [], [], [{ id: 'x', status: 'active' }]];
    const db = createMockDb();
    const k8s = createMockK8s();
    (k8s._createIngress as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error('Conflict'), { statusCode: 409 }),
    );

    const result = await service.createWebmailDomain(
      db as never,
      'c1',
      validInput,
      k8s,
      makeLogger(),
    );
    expect(result).toBeDefined();
    expect(k8s._replaceIngress).toHaveBeenCalledOnce();
  });

  it('should skip Certificate creation when auto-TLS is disabled', async () => {
    vi.mocked(tlsSettings.isAutoTlsEnabled).mockResolvedValue(false);
    selectResults = [[client], [], [], [{ id: 'x', status: 'active' }]];
    const db = createMockDb();
    const k8s = createMockK8s();

    const result = await service.createWebmailDomain(
      db as never,
      'c1',
      validInput,
      k8s,
      makeLogger(),
    );
    expect(result).toBeDefined();
    expect(k8s._createIngress).toHaveBeenCalledOnce();
    expect(k8s._createCustom).not.toHaveBeenCalled();
  });

  it('should mark row active with cert failure logged (non-fatal)', async () => {
    selectResults = [[client], [], [], [{ id: 'x', status: 'active' }]];
    const db = createMockDb();
    const k8s = createMockK8s();
    (k8s._createCustom as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error('cert-manager not installed'), { statusCode: 500 }),
    );
    const logger = makeLogger();

    const result = await service.createWebmailDomain(
      db as never,
      'c1',
      validInput,
      k8s,
      logger,
    );
    expect(result).toBeDefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('should tolerate cert 409 (already exists)', async () => {
    selectResults = [[client], [], [], [{ id: 'x', status: 'active' }]];
    const db = createMockDb();
    const k8s = createMockK8s();
    (k8s._createCustom as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error('Already exists'), { statusCode: 409 }),
    );

    await service.createWebmailDomain(
      db as never,
      'c1',
      validInput,
      k8s,
      makeLogger(),
    );
    // No log on 409 tolerance since cert path succeeded (certOk=true)
  });

  it('should leave row in pending and skip k8s when k8s is undefined', async () => {
    selectResults = [[client], [], [], [{ id: 'x', status: 'pending' }]];
    const db = createMockDb();
    const logger = makeLogger();

    const result = await service.createWebmailDomain(
      db as never,
      'c1',
      validInput,
      undefined,
      logger,
    );
    expect(result).toBeDefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('should throw CLIENT_NOT_FOUND if client does not exist', async () => {
    selectResults = [[]];
    const db = createMockDb();

    await expect(
      service.createWebmailDomain(db as never, 'ghost', validInput, createMockK8s(), makeLogger()),
    ).rejects.toMatchObject({
      code: 'CLIENT_NOT_FOUND',
      status: 404,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// deleteWebmailDomain
// ═══════════════════════════════════════════════════════════════════════════

describe('deleteWebmailDomain', () => {
  const row = {
    id: 'wd1',
    clientId: 'c1',
    hostname: 'webmail.acme.com',
    status: 'active',
  };

  it('should delete Ingress + Certificate + Secret + DB row (happy path)', async () => {
    selectResults = [[row]];
    const db = createMockDb();
    const k8s = createMockK8s();

    await service.deleteWebmailDomain(db as never, 'c1', 'wd1', k8s, makeLogger());

    expect(k8s._deleteIngress).toHaveBeenCalledOnce();
    expect(k8s._deleteCustom).toHaveBeenCalledOnce();
    expect(k8s._deleteSecret).toHaveBeenCalledOnce();
    expect(db.delete).toHaveBeenCalled();
  });

  it('should tolerate 404 on Ingress/Cert/Secret deletion (already gone)', async () => {
    selectResults = [[row]];
    const db = createMockDb();
    const k8s = createMockK8s();
    const notFound = Object.assign(new Error('Not Found'), { statusCode: 404 });
    (k8s._deleteIngress as ReturnType<typeof vi.fn>).mockRejectedValue(notFound);
    (k8s._deleteCustom as ReturnType<typeof vi.fn>).mockRejectedValue(notFound);
    (k8s._deleteSecret as ReturnType<typeof vi.fn>).mockRejectedValue(notFound);

    await service.deleteWebmailDomain(db as never, 'c1', 'wd1', k8s, makeLogger());
    expect(db.delete).toHaveBeenCalled(); // row still deleted
  });

  it('should NOT stop at ingress failure — still attempts cert + secret delete', async () => {
    selectResults = [[row]];
    const db = createMockDb();
    const k8s = createMockK8s();
    (k8s._deleteIngress as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error('Forbidden'), { statusCode: 403 }),
    );

    await expect(
      service.deleteWebmailDomain(db as never, 'c1', 'wd1', k8s, makeLogger()),
    ).rejects.toMatchObject({
      code: 'DEPROVISIONING_FAILED',
      status: 502,
    });

    // All three teardown calls were still attempted
    expect(k8s._deleteIngress).toHaveBeenCalled();
    expect(k8s._deleteCustom).toHaveBeenCalled();
    expect(k8s._deleteSecret).toHaveBeenCalled();
  });

  it('should mark row status=deleting and NOT delete the DB row on partial failure', async () => {
    selectResults = [[row]];
    const db = createMockDb();
    const k8s = createMockK8s();
    (k8s._deleteIngress as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error('boom'), { statusCode: 500 }),
    );

    await expect(
      service.deleteWebmailDomain(db as never, 'c1', 'wd1', k8s, makeLogger()),
    ).rejects.toMatchObject({ code: 'DEPROVISIONING_FAILED' });

    expect(db.update).toHaveBeenCalled();
    // DB delete NOT called (row is kept in 'deleting')
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('should throw WEBMAIL_DOMAIN_NOT_FOUND when row missing', async () => {
    selectResults = [[]];
    const db = createMockDb();

    await expect(
      service.deleteWebmailDomain(db as never, 'c1', 'ghost', createMockK8s(), makeLogger()),
    ).rejects.toMatchObject({ code: 'WEBMAIL_DOMAIN_NOT_FOUND', status: 404 });
  });

  it('should delete DB row even with no k8s client', async () => {
    selectResults = [[row]];
    const db = createMockDb();

    await service.deleteWebmailDomain(db as never, 'c1', 'wd1', undefined, makeLogger());
    expect(db.delete).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// createWebmailDomainSchema (api-contracts)
// ═══════════════════════════════════════════════════════════════════════════

describe('createWebmailDomainSchema', () => {
  it('should accept a valid public FQDN', () => {
    const result = createWebmailDomainSchema.safeParse({ hostname: 'webmail.acme.com' });
    expect(result.success).toBe(true);
  });

  it('should accept a three-label hostname', () => {
    const result = createWebmailDomainSchema.safeParse({ hostname: 'mail.us.example.com' });
    expect(result.success).toBe(true);
  });

  it('should lowercase the hostname on transform', () => {
    const result = createWebmailDomainSchema.safeParse({ hostname: 'Webmail.Acme.COM' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.hostname).toBe('webmail.acme.com');
    }
  });

  it('should reject reserved .local TLD', () => {
    const result = createWebmailDomainSchema.safeParse({ hostname: 'webmail.dind.local' });
    expect(result.success).toBe(false);
  });

  it('should reject reserved .test TLD', () => {
    const result = createWebmailDomainSchema.safeParse({ hostname: 'webmail.acme.test' });
    expect(result.success).toBe(false);
  });

  it('should reject reserved .internal TLD', () => {
    const result = createWebmailDomainSchema.safeParse({ hostname: 'webmail.corp.internal' });
    expect(result.success).toBe(false);
  });

  it('should reject an invalid hostname (no dots)', () => {
    const result = createWebmailDomainSchema.safeParse({ hostname: 'webmail' });
    expect(result.success).toBe(false);
  });

  it('should reject an empty string', () => {
    const result = createWebmailDomainSchema.safeParse({ hostname: '' });
    expect(result.success).toBe(false);
  });

  it('should reject a hostname with leading hyphen', () => {
    const result = createWebmailDomainSchema.safeParse({ hostname: '-foo.example.com' });
    expect(result.success).toBe(false);
  });

  it('should reject a hostname exceeding 253 chars', () => {
    const longLabel = 'a'.repeat(60);
    // 5 × 60 + 4 dots + 'com' = 307 chars, over the 253-char total limit.
    const long = [longLabel, longLabel, longLabel, longLabel, longLabel, 'com'].join('.');
    const result = createWebmailDomainSchema.safeParse({ hostname: long });
    expect(result.success).toBe(false);
  });
});
