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
  buildResticRepoUri,
  buildResticEnv,
  ResticConcurrencySemaphore,
  __setResticSpawnForTest,
  __resetResticSpawnForTest,
  runResticBackup,
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

    expect(calls).toHaveLength(1);
    const c = calls[0]!;
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
    expect(cmd).toContain('-p 23');
    expect(cmd).toContain('-s u335448-sub10@u335448-sub10.your-storagebox.de sftp');
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
