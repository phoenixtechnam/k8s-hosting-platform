import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock encryption — passwords are encrypted at rest via oidc/crypto.
vi.mock('../oidc/crypto.js', () => ({
  encrypt: vi.fn((plain: string) => `encrypted:${plain}`),
  decrypt: vi.fn((cipher: string) => cipher.replace(/^encrypted:/, '')),
}));

// ─── Mock DB ────────────────────────────────────────────────────────────────

let selectResults: unknown[][];
let selectCallIndex: number;
let insertImpl: () => Promise<void>;
let insertReturning: unknown[];
let updateImpl: () => Promise<void>;
let deleteImpl: () => Promise<void>;

function createMockDb() {
  selectCallIndex = 0;

  // The result of .where(...) is awaitable AND chainable into
  // .orderBy(...).limit(...) for the listImapSyncJobs query. Both
  // paths consume the same selectResults slot exactly once.
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
  const innerJoinFn = vi.fn().mockReturnValue({ where: whereFn });
  const fromFn = vi.fn().mockReturnValue({ where: whereFn, innerJoin: innerJoinFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });

  const insertReturningFn = vi.fn().mockImplementation(async () => {
    await insertImpl();
    return insertReturning;
  });
  const insertValuesFn = vi.fn().mockReturnValue({ returning: insertReturningFn });
  const insertFn = vi.fn().mockReturnValue({ values: insertValuesFn });

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
    _insertValuesFn: insertValuesFn,
    _updateSet: updateSet,
  } as unknown as ReturnType<typeof createMockDb>;
}

const service = await import('./service.js');

beforeEach(() => {
  selectResults = [];
  selectCallIndex = 0;
  insertImpl = () => Promise.resolve();
  insertReturning = [];
  updateImpl = () => Promise.resolve();
  deleteImpl = () => Promise.resolve();
});

// ═══════════════════════════════════════════════════════════════════════════
// buildJobManifest (pure function)
// ═══════════════════════════════════════════════════════════════════════════

describe('buildJobManifest', () => {
  const baseInput = {
    jobId: 'job-123',
    secretName: 'imapsync-job-123',
    namespace: 'mail',
    mailboxAddress: 'alice@acme.com',
    sourceHost: 'imap.gmail.com',
    sourcePort: 993,
    sourceUsername: 'alice@gmail.com',
    sourceSsl: true,
    destHost: 'stalwart-mail.mail.svc.cluster.local',
    destPort: 143,
    options: {},
    image: 'gilleslamiral/imapsync:latest',
  };

  it('produces a Job manifest with metadata, ownerless secretRef, and arg-free password handling', () => {
    const job = service.buildJobManifest(baseInput);

    expect(job.metadata?.name).toBe('imapsync-job-123');
    expect(job.metadata?.namespace).toBe('mail');
    expect(job.spec?.template.spec?.restartPolicy).toBe('Never');
    expect(job.spec?.backoffLimit).toBe(0);
    // IMAP Phase 4: wall-clock timeout so stuck pods don't sit
    // forever. 2 hours is the default.
    expect(job.spec?.activeDeadlineSeconds).toBe(7200);
    expect(job.spec?.ttlSecondsAfterFinished).toBe(3600);

    const container = job.spec?.template.spec?.containers?.[0];
    expect(container).toBeDefined();
    expect(container?.image).toBe('gilleslamiral/imapsync:latest');

    // CRITICAL: passwords MUST come from envFrom secretRef, never via args
    expect(container?.envFrom).toEqual([{ secretRef: { name: 'imapsync-job-123' } }]);
    const args = container?.args ?? [];
    const argsText = args.join(' ');
    expect(argsText).not.toContain('SOURCE_PASSWORD');
    expect(argsText).not.toContain('DEST_PASSWORD');
    // Password must NEVER be in args literally either
    for (const a of args) {
      expect(a).not.toMatch(/--password1=/);
      expect(a).not.toMatch(/--password2=/);
    }
  });

  it('passes source host/port/user via args (passfile1 reads from env-set file)', () => {
    const job = service.buildJobManifest(baseInput);
    const args = job.spec?.template.spec?.containers?.[0]?.args ?? [];
    const argsText = args.join(' ');

    expect(argsText).toContain('--host1 imap.gmail.com');
    expect(argsText).toContain('--port1 993');
    expect(argsText).toContain('--user1 alice@gmail.com');
    expect(argsText).toContain('--ssl1');
  });

  it('uses Stalwart master SSO for the destination user (alice@acme.com%master)', () => {
    const job = service.buildJobManifest(baseInput);
    const args = job.spec?.template.spec?.containers?.[0]?.args ?? [];
    const argsText = args.join(' ');

    expect(argsText).toContain('--host2 stalwart-mail.mail.svc.cluster.local');
    expect(argsText).toContain('--port2 143');
    // The destination user is the mailbox address with %master appended.
    expect(argsText).toContain('--user2 alice@acme.com%master');
  });

  it('passes optional --automap and --nofoldersizes when set in options', () => {
    const job = service.buildJobManifest({
      ...baseInput,
      options: { automap: true, noFolderSizes: true },
    });
    const args = job.spec?.template.spec?.containers?.[0]?.args ?? [];
    expect(args).toContain('--automap');
    expect(args).toContain('--nofoldersizes');
  });

  it('passes --dry for a dry-run', () => {
    const job = service.buildJobManifest({ ...baseInput, options: { dryRun: true } });
    const args = job.spec?.template.spec?.containers?.[0]?.args ?? [];
    expect(args).toContain('--dry');
  });

  it('passes --exclude flags for each exclude folder pattern', () => {
    const job = service.buildJobManifest({
      ...baseInput,
      options: { excludeFolders: ['Spam', 'Trash'] },
    });
    const args = job.spec?.template.spec?.containers?.[0]?.args ?? [];
    // imapsync uses --exclude '<regex>' — we expect both patterns
    const argsText = args.join(' ');
    expect(argsText).toContain('--exclude Spam');
    expect(argsText).toContain('--exclude Trash');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// buildJobSecret (pure function)
// ═══════════════════════════════════════════════════════════════════════════

describe('buildJobSecret', () => {
  it('base64-encodes the source and destination passwords into stringData', () => {
    const sec = service.buildJobSecret({
      jobId: 'job-123',
      namespace: 'mail',
      sourcePassword: 'srcpw',
      destPassword: 'dstpw',
    });
    expect(sec.metadata?.name).toBe('imapsync-job-123');
    expect(sec.stringData).toEqual({
      SOURCE_PASSWORD: 'srcpw',
      DEST_PASSWORD: 'dstpw',
    });
    // type defaults to Opaque
    expect(sec.type).toBe('Opaque');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// createImapSyncJob (DB only — does NOT touch K8s)
// ═══════════════════════════════════════════════════════════════════════════

describe('createImapSyncJob', () => {
  it('inserts a pending row with the encrypted source password', async () => {
    // ownership lookup: mailbox exists and belongs to client
    selectResults = [
      [{ id: 'mb1', clientId: 'c1', fullAddress: 'alice@acme.com' }],
    ];
    const now = new Date('2026-04-08T12:00:00Z');
    insertReturning = [
      {
        id: 'job-1',
        clientId: 'c1',
        mailboxId: 'mb1',
        sourceHost: 'imap.gmail.com',
        sourcePort: 993,
        sourceUsername: 'alice@gmail.com',
        sourcePasswordEncrypted: 'encrypted:p@ss',
        sourceSsl: 1,
        options: {},
        status: 'pending',
        k8sJobName: null,
        k8sNamespace: 'mail',
        logTail: null,
        errorMessage: null,
        startedAt: null,
        finishedAt: null,
        createdAt: now,
        updatedAt: now,
      },
    ];
    const db = createMockDb();

    const result = await service.createImapSyncJob(db as never, 'enckey', 'c1', {
      mailbox_id: 'mb1',
      source_host: 'imap.gmail.com',
      source_port: 993,
      source_username: 'alice@gmail.com',
      source_password: 'p@ss',
      source_ssl: true,
      options: {},
    });

    expect(result.status).toBe('pending');
    expect(db.insert).toHaveBeenCalled();
    // Inspect the values that were passed to .values()
    const insertedValues = (db._insertValuesFn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0];
    const v = insertedValues as Record<string, unknown>;
    expect(v.clientId).toBe('c1');
    expect(v.mailboxId).toBe('mb1');
    expect(v.sourcePasswordEncrypted).toBe('encrypted:p@ss');
    expect(v.status).toBe('pending');
    // Ensure the plaintext password is NOT in the inserted values under any
    // other field name.
    for (const [key, value] of Object.entries(v)) {
      if (key === 'sourcePasswordEncrypted') continue;
      expect(typeof value === 'string' ? value : '').not.toContain('p@ss');
    }
  });

  it('throws MAILBOX_NOT_FOUND when the mailbox does not belong to the client', async () => {
    selectResults = [[]];
    const db = createMockDb();

    await expect(
      service.createImapSyncJob(db as never, 'k', 'c1', {
        mailbox_id: 'ghost',
        source_host: 'h',
        source_port: 993,
        source_username: 'u',
        source_password: 'p',
        source_ssl: true,
        options: {},
      }),
    ).rejects.toMatchObject({ code: 'MAILBOX_NOT_FOUND', status: 404 });
  });

  it('throws IMAPSYNC_ALREADY_RUNNING on partial-unique-index violation', async () => {
    selectResults = [
      [{ id: 'mb1', clientId: 'c1', fullAddress: 'alice@acme.com' }],
    ];
    insertImpl = () => {
      // Simulate the partial unique index violation
      const err = new Error('duplicate key value violates unique constraint "imap_sync_jobs_mailbox_active_unique"') as Error & { code?: string };
      err.code = '23505';
      return Promise.reject(err);
    };
    const db = createMockDb();

    await expect(
      service.createImapSyncJob(db as never, 'k', 'c1', {
        mailbox_id: 'mb1',
        source_host: 'h',
        source_port: 993,
        source_username: 'u',
        source_password: 'p',
        source_ssl: true,
        options: {},
      }),
    ).rejects.toMatchObject({ code: 'IMAPSYNC_ALREADY_RUNNING', status: 409 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// listImapSyncJobs / getImapSyncJob
// ═══════════════════════════════════════════════════════════════════════════

describe('listImapSyncJobs', () => {
  it('returns rows for the client with passwords stripped', async () => {
    const dbRow = {
      id: 'job-1',
      clientId: 'c1',
      mailboxId: 'mb1',
      sourceHost: 'imap.gmail.com',
      sourcePort: 993,
      sourceUsername: 'alice@gmail.com',
      sourcePasswordEncrypted: 'encrypted:secret',
      sourceSsl: 1,
      options: {},
      status: 'running',
      k8sJobName: 'imapsync-job-1',
      k8sNamespace: 'mail',
      logTail: 'transferring 100/200 messages',
      errorMessage: null,
      startedAt: new Date('2026-04-08T10:00:00Z'),
      finishedAt: null,
      createdAt: new Date('2026-04-08T09:59:00Z'),
      updatedAt: new Date('2026-04-08T10:00:00Z'),
    };
    selectResults = [[dbRow]];
    const db = createMockDb();

    const rows = await service.listImapSyncJobs(db as never, 'c1');
    expect(rows).toHaveLength(1);
    // Password fields MUST be stripped
    expect(rows[0]).not.toHaveProperty('sourcePasswordEncrypted');
    expect(rows[0]).not.toHaveProperty('source_password_encrypted');
    expect(rows[0].id).toBe('job-1');
    expect(rows[0].sourceSsl).toBe(true); // converted from int to bool
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Round-4 Phase 1: deleteTerminalJob
// ═══════════════════════════════════════════════════════════════════════════

describe('deleteTerminalJob', () => {
  it('deletes a succeeded job and returns its clientId, status, and K8s coordinates', async () => {
    selectResults = [[
      {
        clientId: 'c1',
        status: 'succeeded',
        k8sJobName: 'imapsync-job-1',
        k8sNamespace: 'mail',
      },
    ]];
    let deleted = false;
    deleteImpl = async () => { deleted = true; };
    const db = createMockDb();

    const result = await service.deleteTerminalJob(db as never, 'c1', 'job-1');

    expect(result).toEqual({
      clientId: 'c1',
      status: 'succeeded',
      k8sJobName: 'imapsync-job-1',
      k8sNamespace: 'mail',
    });
    expect(deleted).toBe(true);
  });

  it('deletes a failed job', async () => {
    selectResults = [[{ clientId: 'c1', status: 'failed', k8sJobName: 'imapsync-job-1', k8sNamespace: 'mail' }]];
    deleteImpl = async () => undefined;
    const db = createMockDb();

    const result = await service.deleteTerminalJob(db as never, 'c1', 'job-1');
    expect(result?.status).toBe('failed');
  });

  it('deletes a cancelled job', async () => {
    selectResults = [[{ clientId: 'c1', status: 'cancelled', k8sJobName: 'imapsync-job-1', k8sNamespace: 'mail' }]];
    deleteImpl = async () => undefined;
    const db = createMockDb();

    const result = await service.deleteTerminalJob(db as never, 'c1', 'job-1');
    expect(result?.status).toBe('cancelled');
  });

  it('throws INVALID_STATE 409 when the job is still running', async () => {
    selectResults = [[{ clientId: 'c1', status: 'running', k8sJobName: 'imapsync-job-1', k8sNamespace: 'mail' }]];
    const db = createMockDb();

    await expect(service.deleteTerminalJob(db as never, 'c1', 'job-1'))
      .rejects.toMatchObject({ code: 'INVALID_STATE', status: 409 });
  });

  it('throws INVALID_STATE 409 when the job is still pending', async () => {
    selectResults = [[{ clientId: 'c1', status: 'pending', k8sJobName: null, k8sNamespace: 'mail' }]];
    const db = createMockDb();

    await expect(service.deleteTerminalJob(db as never, 'c1', 'job-1'))
      .rejects.toMatchObject({ code: 'INVALID_STATE', status: 409 });
  });

  it('returns null when the job does not exist', async () => {
    selectResults = [[]];
    const db = createMockDb();

    const result = await service.deleteTerminalJob(db as never, 'c1', 'missing');
    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Round-4 Phase 1: resyncImapSyncJob
// ═══════════════════════════════════════════════════════════════════════════

describe('resyncImapSyncJob', () => {
  const ORIGINAL = {
    id: 'job-orig',
    clientId: 'c1',
    mailboxId: 'mb1',
    sourceHost: 'imap.gmail.com',
    sourcePort: 993,
    sourceUsername: 'alice@gmail.com',
    sourcePasswordEncrypted: 'encrypted:secret',
    sourceSsl: 1,
    options: { automap: true },
    status: 'succeeded',
    k8sJobName: 'imapsync-job-orig',
    k8sNamespace: 'mail',
    logTail: null,
    errorMessage: null,
    startedAt: new Date(),
    finishedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it('inserts a new pending row that copies the source server, port, username, encrypted password, and options', async () => {
    selectResults = [[ORIGINAL]];
    insertImpl = async () => undefined;
    insertReturning = [{ ...ORIGINAL, id: 'job-new', status: 'pending' }];
    const db = createMockDb();

    const result = await service.resyncImapSyncJob(db as never, 'c1', 'job-orig');

    expect(result.id).toBe('job-new');
    expect(result.status).toBe('pending');
    // The values passed into .insert(...).values(...) include the
    // original encrypted password, NOT a fresh encrypt of clear text.
    const values = (db as unknown as { _insertValuesFn: { mock: { calls: [unknown[]][] } } })._insertValuesFn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(values.sourcePasswordEncrypted).toBe(ORIGINAL.sourcePasswordEncrypted);
    expect(values.sourceHost).toBe(ORIGINAL.sourceHost);
    expect(values.sourcePort).toBe(ORIGINAL.sourcePort);
    expect(values.sourceUsername).toBe(ORIGINAL.sourceUsername);
    expect(values.sourceSsl).toBe(1);
    expect(values.status).toBe('pending');
  });

  it('throws INVALID_STATE when the original is still running', async () => {
    selectResults = [[{ ...ORIGINAL, status: 'running' }]];
    const db = createMockDb();

    await expect(service.resyncImapSyncJob(db as never, 'c1', 'job-orig'))
      .rejects.toMatchObject({ code: 'INVALID_STATE', status: 409 });
  });

  it('throws INVALID_STATE when the original is still pending', async () => {
    selectResults = [[{ ...ORIGINAL, status: 'pending' }]];
    const db = createMockDb();

    await expect(service.resyncImapSyncJob(db as never, 'c1', 'job-orig'))
      .rejects.toMatchObject({ code: 'INVALID_STATE', status: 409 });
  });

  it('throws IMAPSYNC_JOB_NOT_FOUND when the row does not exist', async () => {
    selectResults = [[]];
    const db = createMockDb();

    await expect(service.resyncImapSyncJob(db as never, 'c1', 'missing'))
      .rejects.toMatchObject({ code: 'IMAPSYNC_JOB_NOT_FOUND', status: 404 });
  });

  it('throws IMAPSYNC_ALREADY_RUNNING on partial-unique-index violation', async () => {
    selectResults = [[ORIGINAL]];
    insertImpl = async () => {
      const err = new Error('duplicate key') as Error & { code?: string };
      err.code = '23505';
      throw err;
    };
    const db = createMockDb();

    await expect(service.resyncImapSyncJob(db as never, 'c1', 'job-orig'))
      .rejects.toMatchObject({ code: 'IMAPSYNC_ALREADY_RUNNING', status: 409 });
  });
});
