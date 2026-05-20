/**
 * Unit tests for backup-rclone-shim service.ts.
 *
 * Covers:
 *   - loadBackupTargetKey: 200, 404, missing-field paths
 *   - loadShimAssignments: filter, strict-primary tie-breaker, shadowed
 *     reporting, disabled-target reporting, orphan reporting
 *   - rowToTargetConfig: all four storage types decrypt correctly
 *   - logAssignmentDiagnostics: emits a warn per non-empty category
 *
 * The DB calls are mocked via vi.fn() — the loaders only depend on
 * Drizzle's query-builder shape and the `decrypt()` helper, both of
 * which we substitute.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock decrypt helper ─────────────────────────────────────────
vi.mock('../oidc/crypto.js', () => ({
  encrypt: (s: string) => `enc:${s}`,
  decrypt: (s: string) => s.startsWith('enc:') ? s.slice(4) : s,
}));

import {
  loadBackupTargetKey,
  loadShimAssignments,
  logAssignmentDiagnostics,
  ShimKeyMissingError,
  SHIM_NAMESPACE,
  BACKUP_TARGET_KEY_SECRET_NAME,
  SHIM_CLASSES,
  formatStatusForConfigMap,
} from './service.js';

// ─── Test helpers ────────────────────────────────────────────────

/** Build a Secret-like return shape (data values already base64-decoded
 *  The @kubernetes/client-node SDK does NOT auto-decode Secret data
 *  values — they come back base64-encoded from the API. Our test
 *  fixture must mirror that: each value passed to this helper is
 *  the LOGICAL value (e.g. base64-of-32-bytes for the key); we
 *  base64-encode it once here to match what the SDK returns. */
function buildSecretReply(data: Record<string, string>) {
  const encoded: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
    encoded[k] = Buffer.from(v, 'utf8').toString('base64');
  }
  return {
    metadata: { name: BACKUP_TARGET_KEY_SECRET_NAME, namespace: SHIM_NAMESPACE },
    data: encoded,
  };
}

function fixedRawKey(): Buffer {
  const b = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) b[i] = i;
  return b;
}

// ─── loadBackupTargetKey ─────────────────────────────────────────

describe('loadBackupTargetKey', () => {
  it('returns rawKey + fingerprint for a valid 32-byte Secret', async () => {
    const rawKey = fixedRawKey();
    const core = {
      readNamespacedSecret: vi.fn().mockResolvedValue(
        buildSecretReply({
          key: rawKey.toString('base64'),
          generated_at: '2026-05-20T10:00:00Z',
        }),
      ),
    };
    const out = await loadBackupTargetKey(core as never);
    expect(out.rawKey.equals(rawKey)).toBe(true);
    expect(out.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(out.generatedAt).toBe('2026-05-20T10:00:00Z');
  });

  it('throws ShimKeyMissingError on 404', async () => {
    const core = {
      readNamespacedSecret: vi.fn().mockRejectedValue({ statusCode: 404 }),
    };
    await expect(loadBackupTargetKey(core as never)).rejects.toBeInstanceOf(
      ShimKeyMissingError,
    );
  });

  it('throws ShimKeyMissingError when Secret has no `key` field', async () => {
    const core = {
      readNamespacedSecret: vi.fn().mockResolvedValue(buildSecretReply({})),
    };
    await expect(loadBackupTargetKey(core as never)).rejects.toBeInstanceOf(
      ShimKeyMissingError,
    );
  });

  it('rethrows non-404 errors verbatim', async () => {
    const core = {
      readNamespacedSecret: vi.fn().mockRejectedValue({ statusCode: 500, message: 'apiserver down' }),
    };
    await expect(loadBackupTargetKey(core as never)).rejects.toMatchObject({
      statusCode: 500,
    });
  });

  it('tolerates a fingerprint mismatch (computed wins; warning is silent)', async () => {
    const rawKey = fixedRawKey();
    const core = {
      readNamespacedSecret: vi.fn().mockResolvedValue(
        buildSecretReply({
          key: rawKey.toString('base64'),
          fingerprint: 'deadbeefcafe1234', // wrong — does not match
        }),
      ),
    };
    const out = await loadBackupTargetKey(core as never);
    // We use the computed fingerprint, not the stored one.
    expect(out.fingerprint).not.toBe('deadbeefcafe1234');
  });
});

// ─── loadShimAssignments — DB query mock ──────────────────────────

interface FakeRow {
  className: string;
  targetId: string;
  priority: number;
  target: {
    id: string;
    name: string;
    storageType: 's3' | 'ssh' | 'cifs' | 'nfs';
    enabled: number;
    [k: string]: unknown;
  } | null;
}

function buildDb(rows: FakeRow[]) {
  // Drizzle's chain: db.select({...}).from(t).leftJoin(j, on).where(p).orderBy(...).
  // We resolve the chain to `rows` regardless of inputs.
  const chain = {
    from: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockResolvedValue(rows),
  };
  return {
    select: vi.fn().mockReturnValue(chain),
  } as unknown as Parameters<typeof loadShimAssignments>[0];
}

const baseS3Target = (overrides: Partial<FakeRow['target']> = {}) => ({
  id: 't1',
  name: 'primary-s3',
  storageType: 's3' as const,
  enabled: 1,
  s3Endpoint: 'https://s3.example/',
  s3Bucket: 'backups',
  s3Region: 'eu-central',
  s3AccessKeyEncrypted: 'enc:AKIA...',
  s3SecretKeyEncrypted: 'enc:secret...',
  s3Prefix: null,
  ...overrides,
});

describe('loadShimAssignments', () => {
  it('returns empty assignments for no rows', async () => {
    const db = buildDb([]);
    const out = await loadShimAssignments(db, 'enc-key');
    expect(out.assignments).toEqual([]);
    expect(out.shadowed).toEqual([]);
  });

  it('picks lowest-priority winner per class; shadows the rest', async () => {
    const rows: FakeRow[] = [
      { className: 'tenant', targetId: 't1', priority: 50, target: baseS3Target({ id: 't1', name: 'tenant-primary' }) },
      { className: 'tenant', targetId: 't2', priority: 100, target: baseS3Target({ id: 't2', name: 'tenant-secondary' }) },
      { className: 'system', targetId: 's1', priority: 0,   target: baseS3Target({ id: 's1', name: 'system-prim' }) },
    ];
    const db = buildDb(rows);
    const out = await loadShimAssignments(db, 'enc-key');
    expect(out.assignments).toHaveLength(2);
    expect(out.assignments.map((a) => `${a.className}:${a.target.id}`)).toEqual([
      'tenant:t1',
      'system:s1',
    ]);
    expect(out.shadowed).toHaveLength(1);
    expect(out.shadowed[0]).toMatchObject({ className: 'tenant', targetId: 't2' });
  });

  it('skips disabled targets and reports them', async () => {
    const rows: FakeRow[] = [
      { className: 'mail', targetId: 'm1', priority: 100, target: baseS3Target({ id: 'm1', enabled: 0, name: 'mail-disabled' }) },
    ];
    const db = buildDb(rows);
    const out = await loadShimAssignments(db, 'enc-key');
    expect(out.assignments).toEqual([]);
    expect(out.disabledAssignments).toHaveLength(1);
    expect(out.disabledAssignments[0].targetId).toBe('m1');
  });

  it('treats null target as orphan and reports it', async () => {
    const rows: FakeRow[] = [
      { className: 'system', targetId: 'orphan', priority: 100, target: null },
    ];
    const db = buildDb(rows);
    const out = await loadShimAssignments(db, 'enc-key');
    expect(out.orphanedAssignments).toHaveLength(1);
    expect(out.orphanedAssignments[0].targetId).toBe('orphan');
    expect(out.assignments).toEqual([]);
  });

  it('decrypts s3 access + secret credentials', async () => {
    const rows: FakeRow[] = [
      { className: 'system', targetId: 't1', priority: 0,
        target: baseS3Target({
          s3AccessKeyEncrypted: 'enc:my-access-key',
          s3SecretKeyEncrypted: 'enc:my-secret-key',
        }),
      },
    ];
    const db = buildDb(rows);
    const out = await loadShimAssignments(db, 'enc-key');
    expect(out.assignments[0].target).toMatchObject({
      storageType: 's3',
      s3AccessKey: 'my-access-key',
      s3SecretKey: 'my-secret-key',
    });
  });

  it('decrypts ssh PEM key OR password (whichever is present)', async () => {
    const sshTarget = (auth: 'key' | 'pwd') => ({
      id: `s-${auth}`,
      name: 'sftp-target',
      storageType: 'ssh' as const,
      enabled: 1,
      sshHost: 'h.example',
      sshPort: 22,
      sshUser: 'backup',
      sshPath: '/data',
      sshKeyEncrypted: auth === 'key' ? 'enc:-----BEGIN PRIVATE KEY-----\nFOO' : null,
      sshPasswordEncrypted: auth === 'pwd' ? 'enc:secret-pwd' : null,
    });

    const dbKey = buildDb([{ className: 'tenant', targetId: 's-key', priority: 0, target: sshTarget('key') }]);
    const outKey = await loadShimAssignments(dbKey, 'enc-key');
    expect(outKey.assignments[0].target.sshKey).toContain('BEGIN PRIVATE KEY');
    expect(outKey.assignments[0].target.sshPassword).toBeNull();

    const dbPwd = buildDb([{ className: 'tenant', targetId: 's-pwd', priority: 0, target: sshTarget('pwd') }]);
    const outPwd = await loadShimAssignments(dbPwd, 'enc-key');
    expect(outPwd.assignments[0].target.sshPassword).toBe('secret-pwd');
    expect(outPwd.assignments[0].target.sshKey).toBeNull();
  });

  it('handles NFS targets (no encrypted credentials)', async () => {
    const rows: FakeRow[] = [
      { className: 'mail', targetId: 'n1', priority: 0,
        target: {
          id: 'n1',
          name: 'nfs-target',
          storageType: 'nfs',
          enabled: 1,
          nfsServer: 'nas.example',
          nfsExport: '/srv/backups',
          nfsVersion: '4.2',
          nfsOptions: 'soft,intr',
        },
      },
    ];
    const db = buildDb(rows);
    const out = await loadShimAssignments(db, 'enc-key');
    expect(out.assignments[0].target).toMatchObject({
      storageType: 'nfs',
      nfsServer: 'nas.example',
      nfsExport: '/srv/backups',
      nfsVersion: '4.2',
    });
  });

  it('handles CIFS targets with encrypted password', async () => {
    const rows: FakeRow[] = [
      { className: 'mail', targetId: 'c1', priority: 0,
        target: {
          id: 'c1',
          name: 'cifs-target',
          storageType: 'cifs',
          enabled: 1,
          cifsHost: 'smb.example',
          cifsPort: 445,
          cifsShare: 'backups',
          cifsUser: 'svcaccount',
          cifsPasswordEncrypted: 'enc:p4ssw0rd',
          cifsDomain: 'WORKGROUP',
          cifsPath: '/sub/path',
        },
      },
    ];
    const db = buildDb(rows);
    const out = await loadShimAssignments(db, 'enc-key');
    expect(out.assignments[0].target).toMatchObject({
      storageType: 'cifs',
      cifsUser: 'svcaccount',
      cifsPassword: 'p4ssw0rd',
    });
  });
});

// ─── SHIM_CLASSES exports ────────────────────────────────────────

describe('SHIM_CLASSES', () => {
  it('is exactly the three documented classes in canonical order', () => {
    expect([...SHIM_CLASSES]).toEqual(['system', 'tenant', 'mail']);
  });
});

// ─── logAssignmentDiagnostics ────────────────────────────────────

describe('logAssignmentDiagnostics', () => {
  let warns: unknown[];
  let log: { info: ReturnType<typeof vi.fn>; warn: (obj: unknown, msg: string) => void };

  beforeEach(() => {
    warns = [];
    log = {
      info: vi.fn(),
      warn: (obj: unknown, msg: string) => { warns.push({ obj, msg }); },
    };
  });

  it('emits no warnings on a clean load', () => {
    logAssignmentDiagnostics(
      { assignments: [], shadowed: [], disabledAssignments: [], orphanedAssignments: [] },
      log,
    );
    expect(warns).toHaveLength(0);
  });

  it('emits one warn each for shadowed / disabled / orphan categories', () => {
    logAssignmentDiagnostics(
      {
        assignments: [],
        shadowed: [{ className: 'tenant', targetId: 't', priority: 100 }],
        disabledAssignments: [{ className: 'system', targetId: 's', priority: 0 }],
        orphanedAssignments: [{ className: 'mail', targetId: 'm', priority: 0 }],
      },
      log,
    );
    expect(warns).toHaveLength(3);
  });
});

// ─── formatStatusForConfigMap ────────────────────────────────────

describe('formatStatusForConfigMap', () => {
  it('joins assignedClasses with commas + preserves all string fields', () => {
    const out = formatStatusForConfigMap({
      state: 'STATE_OK',
      reconciledAt: '2026-05-20T10:00:00Z',
      keyFingerprint: 'cafef00ddeadbeef',
      inputHash: 'aaaa',
      assignedClasses: ['system', 'tenant'],
      errorMessage: '',
    });
    expect(out).toEqual({
      state: 'STATE_OK',
      reconciledAt: '2026-05-20T10:00:00Z',
      keyFingerprint: 'cafef00ddeadbeef',
      inputHash: 'aaaa',
      assignedClasses: 'system,tenant',
      errorMessage: '',
    });
  });

  it('handles empty assignedClasses + error message', () => {
    const out = formatStatusForConfigMap({
      state: 'STATE_ERROR',
      reconciledAt: '2026-05-20T10:00:00Z',
      keyFingerprint: '',
      inputHash: '',
      assignedClasses: [],
      errorMessage: 'boom',
    });
    expect(out.assignedClasses).toBe('');
    expect(out.errorMessage).toBe('boom');
  });
});
