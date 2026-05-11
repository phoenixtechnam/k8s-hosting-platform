/**
 * Unit tests for restic-driver.
 *
 * Locked invariants from Phase 0 spike:
 *   - HKDF-SHA256 derivation is deterministic and matches the byte-level
 *     test vector recorded in docs/02-operations/TENANT_BACKUP_V2_ROADMAP.md.
 *   - The repo URI builder produces the canonical `restic-{component}/<clientId>/`
 *     prefix for each backend (s3 / sftp / hostpath).
 *   - The semaphore caps concurrency at the configured limit.
 *
 * No real restic binary is invoked here; spawn shape is asserted via a
 * stubbed spawner. Real round-trip is in scripts/integration-tenant-bundles-restic.sh.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import {
  deriveResticPassword,
  deriveDrRecoveryPassword,
  buildResticRepoUri,
  buildResticEnv,
  buildSnapshotTags,
  deriveRegionId,
  BUNDLE_SCHEMA_VERSION,
  ResticConcurrencySemaphore,
  __setResticSpawnForTest,
  __resetResticSpawnForTest,
  runResticBackup,
  runResticRestore,
  listResticSnapshots,
  addResticKey,
  type BackupTarget,
} from './restic-driver.js';

// Phase 0 spike fixture — production driver MUST produce this exactly.
const FIXTURE_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const FIXTURE_CLIENT = 'fixture-client-001';
const FIXTURE_PASSWORD = '9cc1efeff2216dd12759fb93b3b3948f830036b87f5d6a29f8470108dc4d39a8';

describe('deriveResticPassword', () => {
  it('matches the Phase 0 lock vector byte-for-byte', () => {
    const out = deriveResticPassword(FIXTURE_KEY, FIXTURE_CLIENT);
    expect(out).toBe(FIXTURE_PASSWORD);
  });

  it('is deterministic across calls', () => {
    const a = deriveResticPassword(FIXTURE_KEY, 'tenant-x');
    const b = deriveResticPassword(FIXTURE_KEY, 'tenant-x');
    expect(a).toBe(b);
  });

  it('differs across clients with the same key', () => {
    const a = deriveResticPassword(FIXTURE_KEY, 'tenant-a');
    const b = deriveResticPassword(FIXTURE_KEY, 'tenant-b');
    expect(a).not.toBe(b);
  });

  it('rejects keys that are not 32 bytes hex', () => {
    expect(() => deriveResticPassword('00', 'x')).toThrow(/key/i);
    expect(() => deriveResticPassword('zz'.repeat(32), 'x')).toThrow(/hex/i);
  });

  it('rejects empty client ids', () => {
    expect(() => deriveResticPassword(FIXTURE_KEY, '')).toThrow(/client/i);
  });
});

describe('buildResticRepoUri', () => {
  const s3Target: BackupTarget = {
    kind: 's3',
    s3Endpoint: 'https://fsn1.your-objectstorage.com',
    s3Bucket: 'k8s-staging',
    s3Prefix: 'tenant-bundles',
    s3Region: 'fsn1',
    s3AccessKey: 'KEY',
    s3SecretKey: 'SECRET',
  };

  const sftpTarget: BackupTarget = {
    kind: 'ssh',
    sshHost: 'u335448-sub10.your-storagebox.de',
    sshPort: 23,
    sshUser: 'u335448-sub10',
    sshKey: '-----BEGIN OPENSSH PRIVATE KEY-----\n...',
    sshPath: 'platform-backups',
  };

  const hostpathTarget: BackupTarget = {
    kind: 'hostpath',
    hostPath: '/var/lib/platform/backups',
  };

  it('builds the s3 URI with the per-tenant component prefix', () => {
    const uri = buildResticRepoUri(s3Target, 'client-abc', 'files');
    expect(uri).toBe('s3:https://fsn1.your-objectstorage.com/k8s-staging/tenant-bundles/restic-files/client-abc');
  });

  it('omits the optional prefix segment when not configured', () => {
    const stripped = { ...s3Target, s3Prefix: '' } satisfies BackupTarget;
    const uri = buildResticRepoUri(stripped, 'client-abc', 'mailboxes');
    expect(uri).toBe('s3:https://fsn1.your-objectstorage.com/k8s-staging/restic-mailboxes/client-abc');
  });

  it('builds the sftp URI with the user@host:path layout restic expects', () => {
    const uri = buildResticRepoUri(sftpTarget, 'client-abc', 'files');
    expect(uri).toBe('sftp:u335448-sub10@u335448-sub10.your-storagebox.de:platform-backups/restic-files/client-abc');
  });

  it('builds an absolute hostpath repo URI', () => {
    const uri = buildResticRepoUri(hostpathTarget, 'client-abc', 'files');
    expect(uri).toBe('/var/lib/platform/backups/restic-files/client-abc');
  });

  it('rejects component names that are not whitelisted (defence-in-depth)', () => {
    expect(() => buildResticRepoUri(s3Target, 'client-abc', 'config' as never)).toThrow(/component/i);
    expect(() => buildResticRepoUri(s3Target, 'client-abc', '../etc/passwd' as never)).toThrow(/component/i);
  });

  it('rejects clientIds with path-traversal-style characters', () => {
    expect(() => buildResticRepoUri(s3Target, '../etc/passwd', 'files')).toThrow(/clientId/i);
    expect(() => buildResticRepoUri(s3Target, 'a/b', 'files')).toThrow(/clientId/i);
  });
});

describe('buildResticEnv', () => {
  it('exposes S3 creds via AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY only when target is s3', () => {
    const env = buildResticEnv({
      kind: 's3',
      s3Endpoint: 'https://fsn1.your-objectstorage.com',
      s3Bucket: 'b',
      s3AccessKey: 'AK',
      s3SecretKey: 'SK',
    });
    expect(env.AWS_ACCESS_KEY_ID).toBe('AK');
    expect(env.AWS_SECRET_ACCESS_KEY).toBe('SK');
  });

  it('does NOT leak S3 creds for an SFTP target', () => {
    const env = buildResticEnv({
      kind: 'ssh',
      sshHost: 'h',
      sshPort: 22,
      sshUser: 'u',
      sshKey: 'k',
      sshPath: 'p',
    });
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it('returns an empty object for hostpath', () => {
    const env = buildResticEnv({ kind: 'hostpath', hostPath: '/x' });
    expect(Object.keys(env)).toHaveLength(0);
  });
});

describe('ResticConcurrencySemaphore', () => {
  it('admits up to N concurrent acquires, queues the rest', async () => {
    const sem = new ResticConcurrencySemaphore(2);
    const a = await sem.acquire();
    const b = await sem.acquire();
    let cAcquired = false;
    const cP = sem.acquire().then((release) => {
      cAcquired = true;
      return release;
    });
    // Yield once; c should still be queued because 2/2 used.
    await new Promise((r) => setImmediate(r));
    expect(cAcquired).toBe(false);
    a();
    const cRelease = await cP;
    expect(cAcquired).toBe(true);
    cRelease();
    b();
  });

  it('rejects a non-positive concurrency cap', () => {
    expect(() => new ResticConcurrencySemaphore(0)).toThrow(/positive/i);
    expect(() => new ResticConcurrencySemaphore(-1)).toThrow(/positive/i);
  });
});

describe('runResticBackup', () => {
  afterEach(() => {
    __resetResticSpawnForTest();
  });

  it('spawns restic with correct args for s3 target and pipes the input stream into stdin', async () => {
    const calls: Array<{
      bin: string;
      args: ReadonlyArray<string>;
      env: Record<string, string>;
    }> = [];

    __setResticSpawnForTest((bin, args, opts) => {
      calls.push({
        bin,
        args: [...args],
        env: { ...(opts.env ?? {}) },
      });
      // Drain stdin so the producer's write does not back-pressure forever.
      // restic in production reads stdin and writes to backend; here we
      // just consume.
      // The driver should give us stdin via opts.stdio or via the returned
      // child's .stdin. We model the latter.
      return {
        // Simulated stdout: emit the JSON summary restic --json prints,
        // including the snapshot id.
        stdout: Readable.from([
          JSON.stringify({
            message_type: 'summary',
            snapshot_id: 'abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234',
            total_bytes_processed: 12345,
            total_files_processed: 7,
          }) + '\n',
        ]),
        stderr: Readable.from([]),
        stdin: { write: () => true, end: () => undefined, on: () => undefined },
        on: (ev: string, cb: (code?: number) => void) => {
          if (ev === 'exit' || ev === 'close') {
            // Fire async so caller has a chance to attach handlers.
            setImmediate(() => cb(0));
          }
          return undefined;
        },
        kill: () => undefined,
      };
    });

    const target: BackupTarget = {
      kind: 's3',
      s3Endpoint: 'https://fsn1.your-objectstorage.com',
      s3Bucket: 'k8s-staging',
      s3AccessKey: 'AK',
      s3SecretKey: 'SK',
    };
    const stdin = Readable.from([Buffer.from('payload-bytes')]);

    const result = await runResticBackup({
      target,
      clientId: 'client-abc',
      component: 'files',
      passwordHex: FIXTURE_PASSWORD,
      stdinFilename: 'archive.tar',
      tags: ['bundle=42', 'mode=incremental'],
      stdin,
    });

    // Phase 1 piece #7 staging fix: runResticBackup now calls
    // ensureResticRepoInitialised first → 2 spawns: 1 init + 1 backup.
    // Filter for the backup call to assert its arg shape.
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const initCall = calls.find((x) => x.args.includes('init'));
    const c = calls.find((x) => x.args.includes('backup'));
    expect(initCall, 'expected an init call before backup').toBeTruthy();
    expect(c, 'expected a backup call').toBeTruthy();
    if (!c) throw new Error('unreachable');
    expect(c.bin).toBe('restic');
    expect(c.args).toContain('backup');
    expect(c.args).toContain('--stdin');
    expect(c.args).toContain('--stdin-filename');
    expect(c.args).toContain('archive.tar');
    expect(c.args).toContain('--json');
    expect(c.args).toContain('--repo');
    expect(c.args.find((a, i) => c.args[i - 1] === '--repo')).toBe(
      's3:https://fsn1.your-objectstorage.com/k8s-staging/restic-files/client-abc',
    );
    // tags are passed via --tag (one per occurrence).
    expect(c.args.filter((a) => a === '--tag')).toHaveLength(2);
    // Password env is RESTIC_PASSWORD (set by the driver from passwordHex).
    expect(c.env.RESTIC_PASSWORD).toBe(FIXTURE_PASSWORD);
    // S3 creds are exposed only for s3 target.
    expect(c.env.AWS_ACCESS_KEY_ID).toBe('AK');
    expect(c.env.AWS_SECRET_ACCESS_KEY).toBe('SK');

    expect(result.snapshotId).toBe('abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234');
    expect(result.totalBytesProcessed).toBe(12345);
    expect(result.totalFilesProcessed).toBe(7);
  });

  it('passes -o sftp.command for an SFTP target and does NOT leak the SSH key into the env directly', async () => {
    const calls: Array<{ args: ReadonlyArray<string>; env: Record<string, string> }> = [];
    __setResticSpawnForTest((_bin, args, opts) => {
      calls.push({ args: [...args], env: { ...(opts.env ?? {}) } });
      return {
        stdout: Readable.from([
          JSON.stringify({
            message_type: 'summary',
            snapshot_id: 'aa'.repeat(32),
            total_bytes_processed: 0,
            total_files_processed: 0,
          }) + '\n',
        ]),
        stderr: Readable.from([]),
        stdin: { write: () => true, end: () => undefined, on: () => undefined },
        on: (ev: string, cb: (code?: number) => void) => {
          if (ev === 'exit' || ev === 'close') setImmediate(() => cb(0));
          return undefined;
        },
        kill: () => undefined,
      };
    });

    const target: BackupTarget = {
      kind: 'ssh',
      sshHost: 'u335448-sub10.your-storagebox.de',
      sshPort: 23,
      sshUser: 'u335448-sub10',
      sshKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nABCDEF\n-----END OPENSSH PRIVATE KEY-----',
      sshPath: 'platform-backups',
    };

    await runResticBackup({
      target,
      clientId: 'client-abc',
      component: 'mailboxes',
      passwordHex: FIXTURE_PASSWORD,
      stdinFilename: 'maildir.tar',
      tags: [],
      stdin: Readable.from([]),
    });

    const args = calls[0]!.args;
    // sftp.command must contain ssh ... -s <user>@<host> sftp.
    const sftpOptIdx = args.findIndex((a) => a === '-o');
    expect(sftpOptIdx).toBeGreaterThanOrEqual(0);
    const cmd = args[sftpOptIdx + 1];
    expect(cmd).toMatch(/^sftp\.command=/);
    expect(cmd).toMatch(/-i\s+\S+/); // identity file referenced
    expect(cmd).toMatch(/-p '?23'?/); // port may be quoted post-#2 fix
    // user@host now shQuote'd because '@' is outside the safe charset.
    expect(cmd).toContain("'u335448-sub10@u335448-sub10.your-storagebox.de'");
    expect(cmd).toMatch(/sftp$/);
    // The SSH private key MUST NOT appear directly on the args. Only
    // the path to the on-disk identity file is exposed.
    expect(args.join(' ')).not.toContain('BEGIN OPENSSH');
    // Env must not carry AWS creds for SFTP.
    expect(calls[0]!.env.AWS_ACCESS_KEY_ID).toBeUndefined();
  });

  it('throws if restic exits non-zero', async () => {
    __setResticSpawnForTest(() => {
      return {
        stdout: Readable.from([]),
        stderr: Readable.from([Buffer.from('Fatal: bad password\n')]),
        stdin: { write: () => true, end: () => undefined, on: () => undefined },
        on: (ev: string, cb: (code?: number) => void) => {
          if (ev === 'exit' || ev === 'close') setImmediate(() => cb(1));
          return undefined;
        },
        kill: () => undefined,
      };
    });

    await expect(
      runResticBackup({
        target: { kind: 'hostpath', hostPath: '/tmp/r' },
        clientId: 'c',
        component: 'files',
        passwordHex: FIXTURE_PASSWORD,
        stdinFilename: 'a.tar',
        tags: [],
        stdin: Readable.from([]),
      }),
    ).rejects.toThrow(/bad password/);
  });

  it('kills the spawned restic when abortSignal fires + rejects with an aborted error', async () => {
    // The spawned child stays "running" until the test fires the abort
    // signal, at which point our route's abort hook SIGKILLs the child.
    // We model this by exposing a kill() that resolves the exit promise
    // with code 137 (SIGKILL convention).
    let exitCb: ((code: number) => void) | undefined;
    let killCalled = false;
    __setResticSpawnForTest((_bin, args) => {
      const isInit = args.includes('init');
      return {
        stdout: isInit ? Readable.from([]) : Readable.from([], { objectMode: false }),
        stderr: Readable.from([]),
        stdin: { write: () => true, end: () => undefined, on: () => undefined },
        on: (ev: string, cb: (code?: number) => void) => {
          if (ev === 'exit' || ev === 'close') {
            if (isInit) {
              // init exits cleanly so the backup proceeds
              setImmediate(() => cb(0));
            } else {
              // backup spawn — wait for kill() to fire
              exitCb = cb as (code: number) => void;
            }
          }
          return undefined;
        },
        kill: () => {
          killCalled = true;
          // restic receiving SIGKILL exits with code 137 — match
          // the convention so the runResticBackup error branch fires.
          if (exitCb) setImmediate(() => exitCb!(137));
          return true;
        },
      };
    });

    const abortController = new AbortController();
    const target: BackupTarget = { kind: 'hostpath', hostPath: '/tmp/r' };
    // Source stream that never ends — simulates the tenant Job streaming
    // a large tar that never completes because the client disconnected.
    let pushChunk: ((chunk: Buffer | null) => boolean) | undefined;
    const stdin = new Readable({
      read() { pushChunk = (c) => this.push(c); },
    });
    // Push a few bytes so the pipeline starts, then leave the stream
    // open until we abort.
    setImmediate(() => pushChunk?.(Buffer.from('payload')));

    const promise = runResticBackup({
      target,
      clientId: 'client-abc',
      component: 'files',
      passwordHex: FIXTURE_PASSWORD,
      stdinFilename: 'archive.tar',
      tags: [],
      stdin,
      abortSignal: abortController.signal,
    });

    // Fire the abort after the spawn has begun.
    setTimeout(() => abortController.abort(), 20);

    await expect(promise).rejects.toThrow(/aborted/i);
    expect(killCalled).toBe(true);
  });

  it('passes s3.connections=5 (not 10) — bounded pack-buffer envelope', async () => {
    const calls: Array<{ args: ReadonlyArray<string> }> = [];
    __setResticSpawnForTest((_bin, args) => {
      calls.push({ args: [...args] });
      return {
        stdout: Readable.from([
          JSON.stringify({
            message_type: 'summary',
            snapshot_id: 'a'.repeat(64),
            total_bytes_processed: 0,
            total_files_processed: 0,
          }) + '\n',
        ]),
        stderr: Readable.from([]),
        stdin: { write: () => true, end: () => undefined, on: () => undefined },
        on: (ev: string, cb: (code?: number) => void) => {
          if (ev === 'exit' || ev === 'close') setImmediate(() => cb(0));
          return undefined;
        },
        kill: () => undefined,
      };
    });

    await runResticBackup({
      target: {
        kind: 's3',
        s3Endpoint: 'https://fsn1.your-objectstorage.com',
        s3Bucket: 'k8s-staging',
        s3AccessKey: 'AK',
        s3SecretKey: 'SK',
      },
      clientId: 'client-abc',
      component: 'files',
      passwordHex: FIXTURE_PASSWORD,
      stdinFilename: 'archive.tar',
      tags: [],
      stdin: Readable.from([Buffer.from('x')]),
    });

    // Find the backup spawn (the init call is filtered out).
    const c = calls.find((x) => x.args.includes('backup'));
    expect(c, 'expected a backup spawn').toBeTruthy();
    if (!c) throw new Error('unreachable');
    // performanceOpts emits `-o s3.connections=5` for s3 targets.
    expect(c.args).toContain('s3.connections=5');
    // Defensive: ensure we did NOT regress to the old over-provisioned value.
    expect(c.args).not.toContain('s3.connections=10');
  });

  it('rejects an oversized clientId (defence against header-injection-style abuse)', async () => {
    await expect(
      runResticBackup({
        target: { kind: 'hostpath', hostPath: '/tmp/r' },
        clientId: 'a'.repeat(200),
        component: 'files',
        passwordHex: FIXTURE_PASSWORD,
        stdinFilename: 'a.tar',
        tags: [],
        stdin: Readable.from([]),
      }),
    ).rejects.toThrow(/clientId/i);
  });
});

// ─── Phase 1.5 multi-region / DR ───────────────────────────────────────────

describe('deriveDrRecoveryPassword', () => {
  it('uses a different info prefix than the primary key (no collision)', () => {
    const primary = deriveResticPassword(FIXTURE_KEY, 'tenant-x');
    const dr = deriveDrRecoveryPassword(FIXTURE_KEY, 'tenant-x');
    expect(dr).not.toBe(primary);
    // Sanity: still 64 hex chars.
    expect(dr).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for cross-region reproduction', () => {
    const a = deriveDrRecoveryPassword(FIXTURE_KEY, 'tenant-x');
    const b = deriveDrRecoveryPassword(FIXTURE_KEY, 'tenant-x');
    expect(a).toBe(b);
  });

  it('emits a Phase 0 lock vector for cross-region operator handoff', () => {
    // Locked here so a future refactor cannot drift Region B out of
    // sync with Region A.
    const out = deriveDrRecoveryPassword(FIXTURE_KEY, FIXTURE_CLIENT);
    expect(out).toMatch(/^[0-9a-f]{64}$/);
    // Snapshot the value so any change becomes a deliberate one.
    // Region B reproduces this byte-identical given DR_RECOVERY_KEY +
    // FIXTURE_CLIENT — that's the contract.
    expect(out).toBe('de1dd12685a7238c2ab5715fdbbc59583cff4b70cb0bbb1caf2dce2b860b4594');
  });

  // Reviewer #10: prove that the KEY itself matters, not just the info
  // prefix. Catches a future regression where someone accidentally
  // hardcodes the same secret for primary and DR.
  it('produces different output for different keys (DR key matters)', () => {
    const KEY_ALT = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
    const a = deriveDrRecoveryPassword(FIXTURE_KEY, FIXTURE_CLIENT);
    const b = deriveDrRecoveryPassword(KEY_ALT, FIXTURE_CLIENT);
    expect(a).not.toBe(b);
  });

  it('rejects clientIds that fail CLIENT_ID_RE (reviewer #1)', () => {
    expect(() => deriveDrRecoveryPassword(FIXTURE_KEY, '../escape')).toThrow(/CLIENT_ID_RE/);
    expect(() => deriveDrRecoveryPassword(FIXTURE_KEY, 'a/b')).toThrow(/CLIENT_ID_RE/);
    expect(() => deriveResticPassword(FIXTURE_KEY, '../escape')).toThrow(/CLIENT_ID_RE/);
  });
});

describe('deriveRegionId', () => {
  it('slugifies a domain by replacing dots with dashes', () => {
    expect(deriveRegionId('staging.success.com.na')).toBe('staging-success-com-na');
    expect(deriveRegionId('phoenix-host.net')).toBe('phoenix-host-net');
    expect(deriveRegionId('testing.phoenix-host.net')).toBe('testing-phoenix-host-net');
  });

  it('respects an operator override unchanged', () => {
    expect(deriveRegionId('staging.success.com.na', 'eu-fsn1')).toBe('eu-fsn1');
    expect(deriveRegionId('staging.success.com.na', '')).toBe('staging-success-com-na');
  });

  it('rejects override with disallowed characters (defence against tag injection)', () => {
    expect(() => deriveRegionId('x.y', 'eu fsn1')).toThrow(/region/i);
    expect(() => deriveRegionId('x.y', 'a/b')).toThrow(/region/i);
    expect(() => deriveRegionId('x.y', '')).not.toThrow();
  });
});

describe('buildSnapshotTags', () => {
  it('encodes the full multi-region tag set per ADR-036', () => {
    const tags = buildSnapshotTags({
      bundleId: 'bk-123',
      clientId: 'client-abc',
      tenantSlug: 'acme-corp',
      component: 'files',
      regionId: 'eu-fsn1',
      platformVersion: '0.0.0-deadbeef',
    });
    expect(tags).toEqual([
      `bundle-version=${BUNDLE_SCHEMA_VERSION}`,
      'platform-version=0.0.0-deadbeef',
      'region=eu-fsn1',
      'tenant-id=client-abc',
      'tenant-slug=acme-corp',
      'bundle-id=bk-123',
      'component=files',
    ]);
  });

  it('rejects values containing whitespace or shell metacharacters', () => {
    const base = {
      bundleId: 'bk',
      clientId: 'c',
      tenantSlug: 's',
      component: 'files' as const,
      regionId: 'r',
      platformVersion: 'v',
    };
    expect(() => buildSnapshotTags({ ...base, tenantSlug: 's lug' })).toThrow();
    expect(() => buildSnapshotTags({ ...base, regionId: 'a;b' })).toThrow();
    expect(() => buildSnapshotTags({ ...base, platformVersion: 'v\nx' })).toThrow();
  });

  it('BUNDLE_SCHEMA_VERSION matches the migration default (forward-incompat guard)', () => {
    expect(BUNDLE_SCHEMA_VERSION).toBe(2);
  });
});

describe('runResticRestore', () => {
  afterEach(() => {
    __resetResticSpawnForTest();
  });

  it('passes --no-lock when readOnly=true (cross-region restore from external repo)', async () => {
    const calls: Array<{ args: ReadonlyArray<string> }> = [];
    __setResticSpawnForTest((_bin, args) => {
      calls.push({ args: [...args] });
      return mockChildExit0();
    });

    await runResticRestore({
      target: { kind: 's3', s3Endpoint: 'https://x', s3Bucket: 'b', s3AccessKey: 'AK', s3SecretKey: 'SK' },
      snapshotId: 'aabbccddeeff' + 'aa'.repeat(26),
      passwordHex: FIXTURE_PASSWORD,
      targetDir: '/tmp/restore',
      readOnly: true,
    });

    const args = calls[0]!.args;
    expect(args).toContain('restore');
    expect(args).toContain('--no-lock');
    expect(args).toContain('--target');
    expect(args[args.indexOf('--target') + 1]).toBe('/tmp/restore');
  });

  it('omits --no-lock when readOnly=false (in-region restore)', async () => {
    const calls: Array<{ args: ReadonlyArray<string> }> = [];
    __setResticSpawnForTest((_bin, args) => {
      calls.push({ args: [...args] });
      return mockChildExit0();
    });
    await runResticRestore({
      target: { kind: 'hostpath', hostPath: '/r' },
      snapshotId: 'aa'.repeat(32),
      passwordHex: FIXTURE_PASSWORD,
      targetDir: '/tmp/r',
      readOnly: false,
    });
    expect(calls[0]!.args).not.toContain('--no-lock');
  });

  it('passes every include filter as a separate --include arg', async () => {
    const calls: Array<{ args: ReadonlyArray<string> }> = [];
    __setResticSpawnForTest((_bin, args) => {
      calls.push({ args: [...args] });
      return mockChildExit0();
    });
    await runResticRestore({
      target: { kind: 'hostpath', hostPath: '/r' },
      snapshotId: 'aa'.repeat(32),
      passwordHex: FIXTURE_PASSWORD,
      targetDir: '/tmp/r',
      readOnly: true,
      includes: ['/var/www/uploads/2026/05/photo.jpg', '/var/www/uploads/2026/06/'],
    });
    expect(calls[0]!.args.filter((a) => a === '--include')).toHaveLength(2);
  });

  it('rejects malformed snapshot ids (defence against arg injection)', async () => {
    await expect(
      runResticRestore({
        target: { kind: 'hostpath', hostPath: '/r' },
        snapshotId: '--rm-rf-/tmp',
        passwordHex: FIXTURE_PASSWORD,
        targetDir: '/tmp/r',
        readOnly: true,
      }),
    ).rejects.toThrow(/snapshot/i);
  });

  it('rejects targetDir that is not absolute or contains .. segments (reviewer #4)', async () => {
    await expect(
      runResticRestore({
        target: { kind: 'hostpath', hostPath: '/r' },
        snapshotId: 'aa'.repeat(32),
        passwordHex: FIXTURE_PASSWORD,
        targetDir: 'not-absolute',
        readOnly: true,
      }),
    ).rejects.toThrow(/targetDir/);
    await expect(
      runResticRestore({
        target: { kind: 'hostpath', hostPath: '/r' },
        snapshotId: 'aa'.repeat(32),
        passwordHex: FIXTURE_PASSWORD,
        targetDir: '/tmp/../etc',
        readOnly: true,
      }),
    ).rejects.toThrow(/targetDir/);
  });

  it('rejects include paths with .. segments or non-absolute form', async () => {
    await expect(
      runResticRestore({
        target: { kind: 'hostpath', hostPath: '/r' },
        snapshotId: 'aa'.repeat(32),
        passwordHex: FIXTURE_PASSWORD,
        targetDir: '/tmp/r',
        readOnly: true,
        includes: ['/legitimate/path', '../escape'],
      }),
    ).rejects.toThrow(/include/);
  });
});

describe('listResticSnapshots', () => {
  afterEach(() => {
    __resetResticSpawnForTest();
  });

  it('parses snapshots --json output and returns tag/id triples', async () => {
    __setResticSpawnForTest(() => {
      return {
        stdout: Readable.from([
          JSON.stringify([
            {
              id: 'aa'.repeat(32),
              short_id: 'aaaaaaaa',
              time: '2026-05-09T01:02:03Z',
              tags: ['region=eu-fsn1', 'tenant-id=c1', 'tenant-slug=acme', 'component=files', 'bundle-version=2', 'bundle-id=bk-1', 'platform-version=v1'],
            },
            {
              id: 'bb'.repeat(32),
              short_id: 'bbbbbbbb',
              time: '2026-05-09T02:03:04Z',
              tags: ['region=eu-fsn1', 'tenant-id=c2', 'tenant-slug=globex', 'component=mailboxes', 'bundle-version=2', 'bundle-id=bk-2', 'platform-version=v1'],
            },
          ]),
        ]),
        stderr: Readable.from([]),
        stdin: { write: () => true, end: () => undefined, on: () => undefined },
        on: (ev: string, cb: (code?: number) => void) => {
          if (ev === 'exit' || ev === 'close') setImmediate(() => cb(0));
          return undefined;
        },
        kill: () => undefined,
      };
    });
    const out = await listResticSnapshots({
      target: { kind: 'hostpath', hostPath: '/r' },
      passwordHex: FIXTURE_PASSWORD,
      readOnly: true,
    });
    expect(out).toHaveLength(2);
    expect(out[0]?.id).toBe('aa'.repeat(32));
    expect(out[0]?.tags).toContain('tenant-slug=acme');
  });

  it('rejects tag filters that fail TAG_FILTER_RE (reviewer #3)', async () => {
    await expect(
      listResticSnapshots({
        target: { kind: 'hostpath', hostPath: '/r' },
        passwordHex: FIXTURE_PASSWORD,
        readOnly: true,
        tagFilters: ['region=eu-fsn1', 'bad value with space'],
      }),
    ).rejects.toThrow(/tag filter/);
  });

  it('passes --tag <k=v> for every filter (server-side narrowing)', async () => {
    const calls: Array<{ args: ReadonlyArray<string> }> = [];
    __setResticSpawnForTest((_bin, args) => {
      calls.push({ args: [...args] });
      return {
        stdout: Readable.from([JSON.stringify([])]),
        stderr: Readable.from([]),
        stdin: { write: () => true, end: () => undefined, on: () => undefined },
        on: (ev: string, cb: (code?: number) => void) => {
          if (ev === 'exit' || ev === 'close') setImmediate(() => cb(0));
          return undefined;
        },
        kill: () => undefined,
      };
    });
    await listResticSnapshots({
      target: { kind: 'hostpath', hostPath: '/r' },
      passwordHex: FIXTURE_PASSWORD,
      readOnly: true,
      tagFilters: ['region=eu-fsn1', 'tenant-slug=acme'],
    });
    const args = calls[0]!.args;
    expect(args.filter((a) => a === '--tag')).toHaveLength(2);
  });
});

describe('addResticKey', () => {
  afterEach(() => {
    __resetResticSpawnForTest();
  });

  it('passes the new password via stdin (NOT --new-password-file on disk by default)', async () => {
    const calls: Array<{ args: ReadonlyArray<string>; stdinWrites: string[] }> = [];
    __setResticSpawnForTest((_bin, args) => {
      const stdinWrites: string[] = [];
      return {
        stdout: Readable.from([JSON.stringify({ added: true }) + '\n']),
        stderr: Readable.from([]),
        stdin: {
          write: (chunk: string | Buffer) => {
            stdinWrites.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
            return true;
          },
          end: () => {
            calls.push({ args: [...args], stdinWrites });
          },
          on: () => undefined,
        },
        on: (ev: string, cb: (code?: number) => void) => {
          if (ev === 'exit' || ev === 'close') setImmediate(() => cb(0));
          return undefined;
        },
        kill: () => undefined,
      };
    });

    await addResticKey({
      target: { kind: 'hostpath', hostPath: '/r' },
      currentPasswordHex: FIXTURE_PASSWORD,
      newPasswordHex: 'aa'.repeat(32),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toContain('key');
    expect(calls[0]!.args).toContain('add');
    // new password fed via stdin so it never appears in argv or
    // /proc/<pid>/environ.
    expect(calls[0]!.args.join(' ')).not.toContain('aa'.repeat(32));
    expect(calls[0]!.stdinWrites.join('')).toContain('aa'.repeat(32));
  });

  it('rejects an invalid password format (defence against shell injection)', async () => {
    await expect(
      addResticKey({
        target: { kind: 'hostpath', hostPath: '/r' },
        currentPasswordHex: FIXTURE_PASSWORD,
        newPasswordHex: 'not hex; rm -rf /',
      }),
    ).rejects.toThrow(/password/i);
  });

  // Reviewer #5/#12: cover the labelled key path and assert the
  // injection-via-label vector is rejected.
  it('passes valid hostLabel and userLabel through to argv', async () => {
    const calls: Array<{ args: ReadonlyArray<string> }> = [];
    __setResticSpawnForTest((_bin, args) => {
      calls.push({ args: [...args] });
      return mockChildExit0Stdin();
    });
    await addResticKey({
      target: { kind: 'hostpath', hostPath: '/r' },
      currentPasswordHex: FIXTURE_PASSWORD,
      newPasswordHex: 'aa'.repeat(32),
      hostLabel: 'eu-fsn1.platform-api',
      userLabel: 'dr-recovery',
    });
    const args = calls[0]!.args;
    expect(args[args.indexOf('--host') + 1]).toBe('eu-fsn1.platform-api');
    expect(args[args.indexOf('--user') + 1]).toBe('dr-recovery');
  });

  it('rejects hostLabel that looks like a flag (prevents argv-flag injection)', async () => {
    await expect(
      addResticKey({
        target: { kind: 'hostpath', hostPath: '/r' },
        currentPasswordHex: FIXTURE_PASSWORD,
        newPasswordHex: 'aa'.repeat(32),
        hostLabel: '--new-password-file',
      }),
    ).rejects.toThrow(/hostLabel/);
    await expect(
      addResticKey({
        target: { kind: 'hostpath', hostPath: '/r' },
        currentPasswordHex: FIXTURE_PASSWORD,
        newPasswordHex: 'aa'.repeat(32),
        userLabel: 'eu fsn1',
      }),
    ).rejects.toThrow(/userLabel/);
  });
});

function mockChildExit0Stdin(): import('./restic-driver.js').ResticChildLike {
  return {
    stdout: Readable.from([JSON.stringify({ added: true }) + '\n']),
    stderr: Readable.from([]),
    stdin: { write: () => true, end: () => undefined, on: () => undefined },
    on: (ev: string, cb: (code?: number) => void) => {
      if (ev === 'exit' || ev === 'close') setImmediate(() => cb(0));
      return undefined;
    },
    kill: () => undefined,
  };
}

// ─── Helper for restore mock (reused) ─────────────────────────────────────
function mockChildExit0(): import('./restic-driver.js').ResticChildLike {
  return {
    stdout: Readable.from([JSON.stringify({ message_type: 'summary' }) + '\n']),
    stderr: Readable.from([]),
    stdin: { write: () => true, end: () => undefined, on: () => undefined },
    on: (ev: string, cb: (code?: number) => void) => {
      if (ev === 'exit' || ev === 'close') setImmediate(() => cb(0));
      return undefined;
    },
    kill: () => undefined,
  };
}
