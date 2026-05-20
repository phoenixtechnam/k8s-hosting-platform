/**
 * Reconciler unit tests.
 *
 * The reconciler is the materialisation layer (ConfigMap + Secret +
 * DaemonSet I/O). We mock both the k8s SDK clients and the DB-touching
 * service.ts loaders so the tests run hermetically.
 *
 * Coverage:
 *   - STATE_MISSING_KEY: writes status, no other writes happen
 *   - STATE_NO_ASSIGNMENTS: empty ConfigMap merge-patch, DaemonSet bump
 *   - STATE_OK on first run: full materialise (CM + Secret + DS)
 *   - Idempotent skip: when inputHash matches, no writes happen (only
 *     status refresh)
 *   - SSH key materialisation: per-class PEM files; stale-key cleanup
 *   - DaemonSet 404: tolerated silently (Flux not applied yet)
 *   - render failure: STATE_ERROR; no materialisation
 *   - Bypass: a corrupt status read forces re-materialisation
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Buffer } from 'node:buffer';

// ─── Mocks ───────────────────────────────────────────────────────
//
// `service.ts` provides loadBackupTargetKey + loadShimAssignments.
// We mock both so the reconciler test doesn't need DB/Secret fixtures.

vi.mock('./service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./service.js')>();
  return {
    ...actual,
    loadBackupTargetKey: vi.fn(),
    loadShimAssignments: vi.fn(),
  };
});

import {
  reconcileBackupRcloneShim,
} from './reconciler.js';
import {
  loadBackupTargetKey,
  loadShimAssignments,
  ShimKeyMissingError,
  CONFIG_HASH_ANNOTATION,
  INPUT_HASH_ANNOTATION,
} from './service.js';

const mockedKey = vi.mocked(loadBackupTargetKey);
const mockedAssign = vi.mocked(loadShimAssignments);

// ─── Test helpers ────────────────────────────────────────────────

function fixedRawKey(): Buffer {
  const b = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) b[i] = i;
  return b;
}

function mkClients() {
  // Minimal k8s SDK surface. Each call records args + resolves to {}.
  const cmStore: Record<string, { data: Record<string, string>; metadata?: { annotations?: Record<string, string> } }> = {};
  const secretStore: Record<string, { data: Record<string, string> }> = {};
  let daemonSetExists = true;
  const dsPatched: unknown[] = [];

  const core = {
    readNamespacedConfigMap: vi.fn(async ({ name }: { name: string }) => {
      if (!cmStore[name]) {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw { statusCode: 404 };
      }
      return cmStore[name];
    }),
    createNamespacedConfigMap: vi.fn(async ({ body }: { body: { metadata: { name: string }; data: Record<string, string> } }) => {
      cmStore[body.metadata.name] = { data: { ...body.data } };
      return body;
    }),
    patchNamespacedConfigMap: vi.fn(async ({ name, body }: { name: string; body: { data?: Record<string, string>; metadata?: { annotations?: Record<string, string> } } }) => {
      if (!cmStore[name]) cmStore[name] = { data: {} };
      if (body.data) {
        for (const [k, v] of Object.entries(body.data)) {
          cmStore[name].data[k] = v;
        }
      }
      if (body.metadata?.annotations) {
        cmStore[name].metadata = {
          ...(cmStore[name].metadata ?? {}),
          annotations: {
            ...(cmStore[name].metadata?.annotations ?? {}),
            ...body.metadata.annotations,
          },
        };
      }
      return cmStore[name];
    }),
    readNamespacedSecret: vi.fn(async ({ name }: { name: string }) => {
      if (!secretStore[name]) {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw { statusCode: 404 };
      }
      return secretStore[name];
    }),
    createNamespacedSecret: vi.fn(async ({ body }: { body: { metadata: { name: string }; data: Record<string, string> } }) => {
      secretStore[body.metadata.name] = { data: { ...body.data } };
      return body;
    }),
    patchNamespacedSecret: vi.fn(async ({ name, body }: { name: string; body: { data?: Record<string, string> } | Array<{ op: string; path: string; value?: unknown }> }) => {
      const cur = secretStore[name] ??= { data: {} };
      if (Array.isArray(body)) {
        for (const op of body) {
          if (op.op === 'replace' && op.path === '/data') {
            // JSON-Patch `replace /data` — atomic full-data replacement.
            cur.data = { ...((op.value as Record<string, string>) ?? {}) };
          } else if (op.op === 'remove' && op.path.startsWith('/data/')) {
            const key = op.path.slice('/data/'.length).replace(/~1/g, '/').replace(/~0/g, '~');
            delete cur.data[key];
          } else if (op.op === 'replace' && op.path.startsWith('/data/')) {
            const key = op.path.slice('/data/'.length).replace(/~1/g, '/').replace(/~0/g, '~');
            cur.data[key] = (op.value as string);
          }
        }
      } else if (body.data) {
        cur.data = { ...cur.data, ...body.data };
      }
      return cur;
    }),
  };

  const apps = {
    patchNamespacedDaemonSet: vi.fn(async (args: { name: string; body: { spec: { template: { metadata: { annotations: Record<string, string> } } } } }) => {
      if (!daemonSetExists) {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw { statusCode: 404 };
      }
      dsPatched.push(args.body.spec.template.metadata.annotations);
      return {};
    }),
  };

  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  return {
    clients: { core, apps } as never,
    log,
    cmStore,
    secretStore,
    dsPatched,
    setDaemonSetExists: (e: boolean) => { daemonSetExists = e; },
  };
}

const baseS3Target = (overrides: Record<string, unknown> = {}) => ({
  id: 't1',
  name: 'primary-s3',
  storageType: 's3' as const,
  s3Endpoint: 'https://s3.example/',
  s3Bucket: 'backups',
  s3Region: 'eu-central',
  s3AccessKey: 'AKIA-redacted',
  s3SecretKey: 'sk-redacted',
  s3Prefix: null,
  ...overrides,
});

// ─── Tests ───────────────────────────────────────────────────────

describe('reconcileBackupRcloneShim — STATE_MISSING_KEY', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedKey.mockRejectedValue(new ShimKeyMissingError());
  });

  it('writes STATE_MISSING_KEY to status; no ConfigMap/Secret/DaemonSet writes', async () => {
    const env = mkClients();
    const result = await reconcileBackupRcloneShim({} as never, env.clients, 'enc-key', env.log);
    expect(result.state).toBe('STATE_MISSING_KEY');
    expect(result.skipped).toBe(true);
    expect(env.clients.apps.patchNamespacedDaemonSet).not.toHaveBeenCalled();
    // Status ConfigMap is the only write — we create it once.
    expect(env.clients.core.createNamespacedConfigMap).toHaveBeenCalledTimes(1);
    expect(env.cmStore['backup-rclone-shim-status'].data.state).toBe('STATE_MISSING_KEY');
  });
});

describe('reconcileBackupRcloneShim — STATE_NO_ASSIGNMENTS', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedKey.mockResolvedValue({
      rawKey: fixedRawKey(),
      fingerprint: '630dcd2966c43366',
      generatedAt: '',
    });
    mockedAssign.mockResolvedValue({
      assignments: [],
      shadowed: [],
      disabledAssignments: [],
      orphanedAssignments: [],
    });
  });

  it('merge-patches an empty buckets.txt + bumps DS annotation', async () => {
    const env = mkClients();
    const result = await reconcileBackupRcloneShim({} as never, env.clients, 'enc-key', env.log);
    expect(result.state).toBe('STATE_NO_ASSIGNMENTS');
    expect(result.skipped).toBe(false);
    // ConfigMap: only buckets.txt is written (rclone.conf moved to Secret).
    expect(env.cmStore['backup-rclone-shim-config'].data['buckets.txt']).toBe('');
    expect(env.cmStore['backup-rclone-shim-config'].data['rclone.conf']).toBeUndefined();
    // Credentials Secret carries the header-only rclone.conf.
    const credData = env.secretStore['backup-rclone-shim-credentials'].data;
    const decoded = Buffer.from(credData['rclone.conf'], 'base64').toString('utf8');
    expect(decoded).toContain('key-fingerprint = 630dcd2966c43366');
    // DaemonSet annotation patched.
    expect(env.dsPatched).toHaveLength(1);
    expect(env.dsPatched[0]).toHaveProperty(CONFIG_HASH_ANNOTATION);
    expect(env.dsPatched[0]).toHaveProperty(INPUT_HASH_ANNOTATION);
    // Status records STATE_NO_ASSIGNMENTS.
    expect(env.cmStore['backup-rclone-shim-status'].data.state).toBe('STATE_NO_ASSIGNMENTS');
  });
});

describe('reconcileBackupRcloneShim — STATE_OK first run', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedKey.mockResolvedValue({
      rawKey: fixedRawKey(),
      fingerprint: '630dcd2966c43366',
      generatedAt: '',
    });
    // R-X16: all classes must share one upstream target.
    mockedAssign.mockResolvedValue({
      assignments: [
        { className: 'system', target: baseS3Target({ id: 's1', name: 'shared-target' }) },
        { className: 'tenant', target: baseS3Target({ id: 's1', name: 'shared-target' }) },
      ],
      shadowed: [],
      disabledAssignments: [],
      orphanedAssignments: [],
    });
  });

  it('materialises ConfigMap + SSH-keys Secret + DaemonSet annotation', async () => {
    const env = mkClients();
    const result = await reconcileBackupRcloneShim({} as never, env.clients, 'enc-key', env.log);
    expect(result.state).toBe('STATE_OK');
    expect(result.skipped).toBe(false);
    expect(result.assignedClasses).toEqual(['system', 'tenant']);

    // R-X16: buckets.txt lists bare class names — no `:` suffix, no `-raw`.
    const buckets = env.cmStore['backup-rclone-shim-config'].data['buckets.txt'];
    const bucketLines = buckets.split('\n').filter(Boolean);
    expect(bucketLines).toEqual(['system', 'tenant']);
    // Legacy `:` and `-raw` forms must be gone.
    expect(buckets).not.toContain(':');
    expect(buckets).not.toContain('-raw');
    // ConfigMap does NOT carry rclone.conf (moved to Secret).
    expect(env.cmStore['backup-rclone-shim-config'].data['rclone.conf']).toBeUndefined();

    // Credentials Secret carries the rendered rclone.conf with the
    // single shared [upstream] + [encrypted] sections.
    const credData = env.secretStore['backup-rclone-shim-credentials'].data;
    expect(credData['rclone.conf']).toBeDefined();
    const decoded = Buffer.from(credData['rclone.conf'], 'base64').toString('utf8');
    expect(decoded).toContain('[upstream]');
    expect(decoded).toContain('[encrypted]');
    expect(decoded).not.toContain('[system-upstream]');
    expect(decoded).not.toContain('[tenant-upstream]');
    expect(decoded).not.toContain('[buckets]'); // no combine layer

    // SSH-keys Secret created (empty for S3-only targets but the Secret
    // still exists so the DaemonSet's projected volume can mount it).
    expect(env.secretStore['backup-rclone-shim-ssh-keys']).toBeDefined();

    // DaemonSet annotation bumped.
    expect(env.dsPatched).toHaveLength(1);
    expect(env.dsPatched[0][CONFIG_HASH_ANNOTATION]).toBe(result.configHash);
    expect(env.dsPatched[0][INPUT_HASH_ANNOTATION]).toBe(result.inputHash);

    // Status updated.
    expect(env.cmStore['backup-rclone-shim-status'].data.state).toBe('STATE_OK');
    expect(env.cmStore['backup-rclone-shim-status'].data.assignedClasses).toBe('system,tenant');
  });
});

describe('reconcileBackupRcloneShim — idempotent skip', () => {
  it('on second call with same inputs, skips materialise but refreshes status reconciledAt', async () => {
    vi.clearAllMocks();
    mockedKey.mockResolvedValue({
      rawKey: fixedRawKey(),
      fingerprint: '630dcd2966c43366',
      generatedAt: '',
    });
    mockedAssign.mockResolvedValue({
      assignments: [
        { className: 'system', target: baseS3Target({ id: 's1' }) },
      ],
      shadowed: [],
      disabledAssignments: [],
      orphanedAssignments: [],
    });

    const env = mkClients();
    const first = await reconcileBackupRcloneShim({} as never, env.clients, 'enc-key', env.log);
    expect(first.skipped).toBe(false);

    // Second pass: status CM exists; inputHash matches; should skip.
    const dsBefore = env.clients.apps.patchNamespacedDaemonSet.mock.calls.length;
    const second = await reconcileBackupRcloneShim({} as never, env.clients, 'enc-key', env.log);
    expect(second.skipped).toBe(true);
    expect(second.state).toBe('STATE_OK');
    expect(second.inputHash).toBe(first.inputHash);
    // DaemonSet NOT patched on the skip pass.
    expect(env.clients.apps.patchNamespacedDaemonSet.mock.calls.length).toBe(dsBefore);
  });
});

describe('reconcileBackupRcloneShim — SSH-key materialisation', () => {
  it('writes the upstream SSH PEM to the Secret (single key after R-X16)', async () => {
    vi.clearAllMocks();
    mockedKey.mockResolvedValue({ rawKey: fixedRawKey(), fingerprint: '630dcd2966c43366', generatedAt: '' });
    mockedAssign.mockResolvedValue({
      assignments: [
        {
          className: 'tenant',
          target: {
            id: 'sftp-tenant',
            name: 'sftp-target',
            storageType: 'ssh',
            sshHost: 'sftp.example',
            sshPort: 22,
            sshUser: 'backup',
            sshKey: '-----BEGIN PRIVATE KEY-----\nABCD\n-----END PRIVATE KEY-----',
            sshPath: '/srv',
          },
        },
      ],
      shadowed: [],
      disabledAssignments: [],
      orphanedAssignments: [],
    });

    const env = mkClients();
    await reconcileBackupRcloneShim({} as never, env.clients, 'enc-key', env.log);

    const secretData = env.secretStore['backup-rclone-shim-ssh-keys'].data;
    expect(secretData['upstream.pem']).toBeDefined();
    // Stored base64 — decode back and assert it matches.
    const decoded = Buffer.from(secretData['upstream.pem'], 'base64').toString('utf8');
    expect(decoded).toContain('BEGIN PRIVATE KEY');
  });

  it('cleans up stale SSH-key entries when a class is unassigned', async () => {
    vi.clearAllMocks();
    mockedKey.mockResolvedValue({ rawKey: fixedRawKey(), fingerprint: '630dcd2966c43366', generatedAt: '' });

    // First pass: tenant has SSH key.
    mockedAssign.mockResolvedValue({
      assignments: [
        {
          className: 'tenant',
          target: {
            id: 'sftp-tenant',
            name: 'sftp-target',
            storageType: 'ssh',
            sshHost: 'sftp.example',
            sshPort: 22,
            sshUser: 'backup',
            sshKey: '-----BEGIN PRIVATE KEY-----\nABCD',
            sshPath: '/srv',
          },
        },
      ],
      shadowed: [],
      disabledAssignments: [],
      orphanedAssignments: [],
    });
    const env = mkClients();
    await reconcileBackupRcloneShim({} as never, env.clients, 'enc-key', env.log);
    expect(env.secretStore['backup-rclone-shim-ssh-keys'].data['upstream.pem']).toBeDefined();

    // Second pass: tenant flipped to S3 — SSH key no longer needed.
    mockedAssign.mockResolvedValue({
      assignments: [
        { className: 'tenant', target: baseS3Target({ id: 't-s3' }) },
      ],
      shadowed: [],
      disabledAssignments: [],
      orphanedAssignments: [],
    });
    await reconcileBackupRcloneShim({} as never, env.clients, 'enc-key', env.log);
    expect(env.secretStore['backup-rclone-shim-ssh-keys'].data['upstream.pem']).toBeUndefined();
  });
});

describe('reconcileBackupRcloneShim — DaemonSet not applied yet (404)', () => {
  it('tolerates the 404 silently; reconcile still reports STATE_OK', async () => {
    vi.clearAllMocks();
    mockedKey.mockResolvedValue({ rawKey: fixedRawKey(), fingerprint: '630dcd2966c43366', generatedAt: '' });
    mockedAssign.mockResolvedValue({
      assignments: [{ className: 'system', target: baseS3Target({ id: 's1' }) }],
      shadowed: [],
      disabledAssignments: [],
      orphanedAssignments: [],
    });
    const env = mkClients();
    env.setDaemonSetExists(false);
    const result = await reconcileBackupRcloneShim({} as never, env.clients, 'enc-key', env.log);
    expect(result.state).toBe('STATE_OK');
    // ConfigMap + both Secrets were still written.
    expect(env.cmStore['backup-rclone-shim-config']).toBeDefined();
    expect(env.secretStore['backup-rclone-shim-credentials']).toBeDefined();
    expect(env.secretStore['backup-rclone-shim-ssh-keys']).toBeDefined();
  });
});

describe('reconcileBackupRcloneShim — render failure', () => {
  it('writes STATE_ERROR; no materialisation happens', async () => {
    vi.clearAllMocks();
    mockedKey.mockResolvedValue({ rawKey: fixedRawKey(), fingerprint: '630dcd2966c43366', generatedAt: '' });
    mockedAssign.mockResolvedValue({
      // S3 target with missing endpoint → renderer throws.
      assignments: [
        {
          className: 'system',
          target: {
            id: 'broken', name: 'broken',
            storageType: 's3',
            s3Endpoint: null,
            s3Bucket: null,
            s3AccessKey: null,
            s3SecretKey: null,
          },
        },
      ],
      shadowed: [],
      disabledAssignments: [],
      orphanedAssignments: [],
    });
    const env = mkClients();
    const result = await reconcileBackupRcloneShim({} as never, env.clients, 'enc-key', env.log);
    expect(result.state).toBe('STATE_ERROR');
    expect(result.errorMessage).toMatch(/missing required fields/i);
    expect(env.cmStore['backup-rclone-shim-status'].data.state).toBe('STATE_ERROR');
    // No ConfigMap / Secret / DS writes for the rendered content.
    expect(env.cmStore['backup-rclone-shim-config']).toBeUndefined();
    expect(env.secretStore['backup-rclone-shim-ssh-keys']).toBeUndefined();
  });
});

describe('reconcileBackupRcloneShim — self-heal after materialise failure', () => {
  it('does NOT persist inputHash on STATE_ERROR; next tick retries instead of skipping', async () => {
    vi.clearAllMocks();
    mockedKey.mockResolvedValue({ rawKey: fixedRawKey(), fingerprint: '630dcd2966c43366', generatedAt: '' });
    mockedAssign.mockResolvedValue({
      assignments: [{ className: 'system', target: baseS3Target({ id: 's1' }) }],
      shadowed: [],
      disabledAssignments: [],
      orphanedAssignments: [],
    });

    const env = mkClients();
    // First call: make the ConfigMap create (cold-start path) fail
    // with a transient apiserver 503. The reconciler should catch,
    // set STATE_ERROR, and crucially leave inputHash empty so a retry
    // happens next tick.
    const realCreateCM = env.clients.core.createNamespacedConfigMap;
    let firstCall = true;
    env.clients.core.createNamespacedConfigMap = vi.fn(async (...args: Parameters<typeof realCreateCM>) => {
      const body = (args[0] as { body: { metadata: { name: string } } }).body;
      if (firstCall && body.metadata.name === 'backup-rclone-shim-config') {
        firstCall = false;
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw { statusCode: 503, message: 'transient' };
      }
      return realCreateCM(...args);
    }) as never;

    const first = await reconcileBackupRcloneShim({} as never, env.clients, 'enc-key', env.log);
    expect(first.state).toBe('STATE_ERROR');
    // Status CM records STATE_ERROR + EMPTY inputHash (critical: this
    // is what allows the next tick to NOT short-circuit).
    expect(env.cmStore['backup-rclone-shim-status'].data.state).toBe('STATE_ERROR');
    expect(env.cmStore['backup-rclone-shim-status'].data.inputHash).toBe('');

    // Second call (transient 503 no longer happens): should NOT skip
    // — should retry materialisation and reach STATE_OK.
    const second = await reconcileBackupRcloneShim({} as never, env.clients, 'enc-key', env.log);
    expect(second.state).toBe('STATE_OK');
    expect(second.skipped).toBe(false);
    expect(env.cmStore['backup-rclone-shim-status'].data.state).toBe('STATE_OK');
    expect(env.cmStore['backup-rclone-shim-status'].data.inputHash).toBe(second.inputHash);
  });
});

describe('reconcileBackupRcloneShim — assignment load error', () => {
  it('writes STATE_ERROR + propagates the message', async () => {
    vi.clearAllMocks();
    mockedKey.mockResolvedValue({ rawKey: fixedRawKey(), fingerprint: '630dcd2966c43366', generatedAt: '' });
    mockedAssign.mockRejectedValue(new Error('drizzle exploded'));
    const env = mkClients();
    const result = await reconcileBackupRcloneShim({} as never, env.clients, 'enc-key', env.log);
    expect(result.state).toBe('STATE_ERROR');
    expect(result.errorMessage).toMatch(/drizzle exploded/);
    expect(env.cmStore['backup-rclone-shim-config']).toBeUndefined();
  });
});
