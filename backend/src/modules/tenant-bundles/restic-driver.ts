/**
 * Restic driver — Phase 1 of tenant-backup-v2 (ADR-036).
 *
 * Runs restic CLI on the platform-api side as a subprocess. The tenant
 * Job pipes its captured payload (a tar stream of the PVC contents,
 * possibly with a Maildir tree, plus a per-database SQL dump prepared
 * by the pre-capture hook) into platform-api via the existing HMAC-
 * authenticated upload route. From there, the byte stream is forwarded
 * straight into `restic backup --stdin` whose stdout we parse for the
 * snapshot id.
 *
 * Trust boundary:
 *   - Tenant Job is in tenant ns. Has tenant data. Has NO backup creds.
 *   - platform-api is in platform ns. Has backup creds. Spawns restic.
 *   - Backend store creds (S3 access key, SSH private key) materialise
 *     ONLY in this process. SSH keys are written to mode-0600 tmpfiles
 *     in `os.tmpdir()` and unlinked in a `finally`.
 *
 * Per-tenant isolation:
 *   - Repo URI is `<store>/restic-{component}/<clientId>/`.
 *   - Repo password is HKDF-SHA256(OIDC_ENCRYPTION_KEY, info=
 *     `restic-tenant-${clientId}`). Cryptographic isolation: even on
 *     misconfigured repo paths, restic refuses to open with the wrong
 *     password.
 *   - The HKDF lock vector is asserted in restic-driver.test.ts so a
 *     future refactor cannot drift from Phase 0's measurement.
 *
 * Concurrency:
 *   - In-process semaphore (default cap 4) bounds simultaneous restic
 *     spawns per pod. With a 1Gi platform-api limit and ~200MiB peak per
 *     restic process, 4 is the safe ceiling.
 *   - A cluster-wide cap (Postgres advisory locks) is implemented in
 *     global-inflight-gate.ts and composed at call sites; this module is
 *     only responsible for the per-pod gate.
 *
 * What this module does NOT do:
 *   - It does not own the upload HTTP route (see internal-upload-route).
 *   - It does not maintain DB rows (see orchestrator).
 *   - It does not derive the password's source key (the orchestrator
 *     reads `OIDC_ENCRYPTION_KEY` and passes it in).
 */

import { hkdfSync, randomBytes } from 'node:crypto';
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { writeFile, unlink, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Restic-bound view of a `backup_configurations` row. The orchestrator
 * decrypts the credential blobs before constructing this; this module
 * never sees the encrypted form.
 */
export type BackupTarget =
  | {
      readonly kind: 's3';
      readonly s3Endpoint: string;
      readonly s3Bucket: string;
      readonly s3Region?: string;
      /** Optional path segment between bucket and the per-tenant restic dir. */
      readonly s3Prefix?: string;
      readonly s3AccessKey: string;
      readonly s3SecretKey: string;
    }
  | {
      readonly kind: 'ssh';
      readonly sshHost: string;
      readonly sshPort: number;
      readonly sshUser: string;
      /** OpenSSH private key in PEM form. Written to a per-call tmpfile. */
      readonly sshKey: string;
      /** Base path on the SFTP server (relative to the user's chroot). */
      readonly sshPath: string;
    }
  | {
      readonly kind: 'hostpath';
      readonly hostPath: string;
    };

/**
 * The fixed set of components that are valid for restic-backed capture.
 * `config` and `secrets` stay full each run and never use restic, so
 * they are deliberately excluded.
 */
export type ResticComponent = 'files' | 'mailboxes';
const ALLOWED_COMPONENTS: ReadonlySet<string> = new Set<ResticComponent>(['files', 'mailboxes']);

/** Permissive but bounded shape for clientIds. The platform schema uses
 *  UUIDs / kebab-style IDs; this regex rejects path traversal and shell
 *  metacharacters defensively. */
const CLIENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface ResticBackupResult {
  readonly snapshotId: string;
  readonly totalBytesProcessed: number;
  readonly totalFilesProcessed: number;
}

export interface RunResticBackupArgs {
  readonly target: BackupTarget;
  readonly clientId: string;
  readonly component: ResticComponent;
  readonly passwordHex: string;
  readonly stdinFilename: string;
  readonly tags: ReadonlyArray<string>;
  readonly stdin: Readable;
  /** Per-pod concurrency gate. Defaults to a process-singleton (DEFAULT_SEM). */
  readonly semaphore?: ResticConcurrencySemaphore;
}

// ─── Password derivation ────────────────────────────────────────────────────

/**
 * Derive a per-tenant restic repo password from the platform
 * OIDC_ENCRYPTION_KEY using HKDF-SHA256.
 *
 * Lock vector (Phase 0 spike):
 *   key    = 0123…cdef (32 bytes hex)
 *   client = "fixture-client-001"
 *   ⇒ password = 9cc1efeff2216dd12759fb93b3b3948f830036b87f5d6a29f8470108dc4d39a8
 *
 * This is asserted in restic-driver.test.ts.
 */
export function deriveResticPassword(secretHex: string, clientId: string): string {
  if (typeof secretHex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(secretHex)) {
    throw new Error('deriveResticPassword: key must be 32 bytes (64 hex chars)');
  }
  if (typeof clientId !== 'string' || clientId.length === 0) {
    throw new Error('deriveResticPassword: clientId must be a non-empty string');
  }
  const secret = Buffer.from(secretHex, 'hex');
  const info = Buffer.from(`restic-tenant-${clientId}`);
  // Salt is empty buffer per ADR-036 spec; matches Phase 0 spike.
  const out = hkdfSync('sha256', secret, Buffer.alloc(0), info, 32);
  return Buffer.from(out).toString('hex');
}

// ─── Repo URI builder ───────────────────────────────────────────────────────

export function buildResticRepoUri(
  target: BackupTarget,
  clientId: string,
  component: ResticComponent,
): string {
  if (!ALLOWED_COMPONENTS.has(component)) {
    throw new Error(`buildResticRepoUri: invalid component '${component}'`);
  }
  if (!CLIENT_ID_RE.test(clientId)) {
    throw new Error(`buildResticRepoUri: invalid clientId '${clientId}'`);
  }
  switch (target.kind) {
    case 's3': {
      const prefix = (target.s3Prefix ?? '').replace(/^\/+|\/+$/g, '');
      const segments = [target.s3Endpoint.replace(/\/$/, ''), target.s3Bucket];
      if (prefix) segments.push(prefix);
      segments.push(`restic-${component}`, clientId);
      return `s3:${segments.join('/')}`;
    }
    case 'ssh': {
      const path = target.sshPath.replace(/^\/+|\/+$/g, '');
      const tail = path
        ? `${path}/restic-${component}/${clientId}`
        : `restic-${component}/${clientId}`;
      return `sftp:${target.sshUser}@${target.sshHost}:${tail}`;
    }
    case 'hostpath': {
      const root = target.hostPath.replace(/\/$/, '');
      return `${root}/restic-${component}/${clientId}`;
    }
  }
}

// ─── Env builder ────────────────────────────────────────────────────────────

/**
 * Build the env subset that gets passed to the restic subprocess for a
 * given target. RESTIC_PASSWORD is added by the spawn helper; this
 * function only handles backend-specific creds.
 */
export function buildResticEnv(target: BackupTarget): Record<string, string> {
  switch (target.kind) {
    case 's3':
      return {
        AWS_ACCESS_KEY_ID: target.s3AccessKey,
        AWS_SECRET_ACCESS_KEY: target.s3SecretKey,
        ...(target.s3Region ? { AWS_DEFAULT_REGION: target.s3Region } : {}),
      };
    case 'ssh':
    case 'hostpath':
      return {};
  }
}

// ─── Concurrency semaphore ──────────────────────────────────────────────────

export class ResticConcurrencySemaphore {
  private readonly cap: number;
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(cap: number) {
    if (!Number.isFinite(cap) || cap < 1) {
      throw new Error('ResticConcurrencySemaphore: cap must be a positive integer');
    }
    this.cap = Math.floor(cap);
  }

  async acquire(): Promise<() => void> {
    if (this.inFlight < this.cap) {
      this.inFlight += 1;
      return () => this.release();
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.inFlight += 1;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    this.inFlight -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }
}

const DEFAULT_CAP = Math.max(1, Number.parseInt(process.env.TENANT_BUNDLES_MAX_CONCURRENT_RESTIC ?? '4', 10) || 4);
const DEFAULT_SEM = new ResticConcurrencySemaphore(DEFAULT_CAP);

// ─── Spawn shim (overridable for tests) ─────────────────────────────────────

/** Subset of ChildProcess we rely on. */
export interface ResticChildLike {
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly stdin: Pick<Writable, 'write' | 'end' | 'on'>;
  on(event: 'exit' | 'close', cb: (code: number | null) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

export type ResticSpawn = (
  bin: string,
  args: ReadonlyArray<string>,
  opts: { env?: Record<string, string> },
) => ResticChildLike;

let spawnImpl: ResticSpawn | null = null;

/** Test hook — supply a fake spawn so unit tests can assert args/env. */
export function __setResticSpawnForTest(impl: ResticSpawn): void {
  spawnImpl = impl;
}
export function __resetResticSpawnForTest(): void {
  spawnImpl = null;
}

function spawnRestic(
  args: ReadonlyArray<string>,
  env: Record<string, string>,
): ResticChildLike {
  if (spawnImpl) return spawnImpl('restic', args, { env });
  // Real spawn — inherit just the env subset we built (no PATH inheritance
  // would break restic finding its libs, so we layer env on top of the
  // existing PATH). PATH-only inherit is used so unrelated env doesn't
  // leak into the subprocess.
  const child: ChildProcessWithoutNullStreams = nodeSpawn('restic', args as string[], {
    env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return child;
}

// ─── SSH key tmpfile lifecycle ──────────────────────────────────────────────

interface PreparedSftpEnv {
  readonly args: string[];
  readonly cleanup: () => Promise<void>;
}

/**
 * Materialise the SSH private key into a per-call tmpfile (mode 0600)
 * and return the `-o sftp.command=...` arg restic needs, plus a
 * cleanup hook the caller MUST invoke in a finally.
 *
 * The key value never appears on the argv. The argv reference is the
 * tmpfile path; the file is unlinked when cleanup runs.
 */
async function prepareSftpArgs(target: Extract<BackupTarget, { kind: 'ssh' }>): Promise<PreparedSftpEnv> {
  const dir = await mkdtemp(join(tmpdir(), 'restic-sftp-'));
  const keyPath = join(dir, 'id');
  await writeFile(keyPath, target.sshKey, { mode: 0o600 });
  const cmd =
    `ssh -i ${shQuote(keyPath)} -p ${target.sshPort} ` +
    `-o StrictHostKeyChecking=accept-new ` +
    `-o BatchMode=yes ` +
    `-o ServerAliveInterval=30 ` +
    `-s ${target.sshUser}@${target.sshHost} sftp`;
  const args = ['-o', `sftp.command=${cmd}`];
  return {
    args,
    cleanup: async () => {
      try {
        await unlink(keyPath);
      } catch {
        /* ignore */
      }
      try {
        await rm(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

/** Single-quote a token for safe inclusion in a shell command. */
function shQuote(s: string): string {
  if (/^[A-Za-z0-9_./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ─── Main entrypoint: runResticBackup ───────────────────────────────────────

/**
 * Spawn `restic backup --stdin` against the per-tenant repo. Pipes
 * `stdin` to the child. Returns the snapshot id parsed from the JSON
 * summary line on stdout.
 *
 * Caller is responsible for ensuring the repo has been initialised
 * (see initRepoIfMissing). Concurrency is gated by the caller-supplied
 * semaphore (defaults to a process-singleton).
 */
export async function runResticBackup(args: RunResticBackupArgs): Promise<ResticBackupResult> {
  if (!CLIENT_ID_RE.test(args.clientId)) {
    throw new Error(`runResticBackup: invalid clientId '${args.clientId}'`);
  }
  const sem = args.semaphore ?? DEFAULT_SEM;
  const release = await sem.acquire();
  let sftpCleanup: (() => Promise<void>) | null = null;
  try {
    const repoUri = buildResticRepoUri(args.target, args.clientId, args.component);
    const env = {
      ...buildResticEnv(args.target),
      RESTIC_PASSWORD: args.passwordHex,
    };

    const cliArgs: string[] = [];
    if (args.target.kind === 'ssh') {
      const prepared = await prepareSftpArgs(args.target);
      sftpCleanup = prepared.cleanup;
      cliArgs.push(...prepared.args);
    }
    cliArgs.push('--repo', repoUri);
    cliArgs.push('backup');
    cliArgs.push('--stdin');
    cliArgs.push('--stdin-filename', args.stdinFilename);
    cliArgs.push('--json');
    for (const tag of args.tags) {
      cliArgs.push('--tag', tag);
    }

    const child = spawnRestic(cliArgs, env);

    // Pipe the source stream into restic stdin.
    const stdinPromise = new Promise<void>((resolveWrite, rejectWrite) => {
      args.stdin.on('error', rejectWrite);
      args.stdin.on('end', resolveWrite);
      args.stdin.on('data', (chunk: Buffer | string) => {
        try {
          child.stdin.write(chunk as never);
        } catch (err) {
          rejectWrite(err);
        }
      });
    });

    let stdoutBuf = '';
    let stderrBuf = '';
    child.stdout.on('data', (c: Buffer) => {
      stdoutBuf += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      stderrBuf += c.toString('utf8');
    });

    const exitPromise = new Promise<number>((resolveExit) => {
      const finish = (code: number | null) => resolveExit(code ?? 0);
      child.on('exit', finish);
      child.on('close', finish);
    });

    try {
      await stdinPromise;
    } finally {
      try {
        child.stdin.end();
      } catch {
        /* ignore — child may already be gone */
      }
    }

    const code = await exitPromise;
    if (code !== 0) {
      throw new Error(`restic backup exited ${code}: ${stderrBuf.trim() || stdoutBuf.trim()}`);
    }

    // Parse last JSON summary line. restic emits one JSON object per line
    // when --json is passed; the summary line carries `message_type: summary`.
    const summary = parseResticSummary(stdoutBuf);
    if (!summary) {
      throw new Error(`restic backup: no summary in output: ${stdoutBuf.slice(0, 500)}`);
    }
    return summary;
  } finally {
    if (sftpCleanup) {
      await sftpCleanup();
    }
    release();
  }
}

function parseResticSummary(stdoutBuf: string): ResticBackupResult | null {
  // Walk lines bottom-up; the summary is typically the last JSON line.
  const lines = stdoutBuf.split('\n').filter((l) => l.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    if (!line.startsWith('{')) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (obj.message_type === 'summary' && typeof obj.snapshot_id === 'string') {
        return {
          snapshotId: String(obj.snapshot_id),
          totalBytesProcessed: Number(obj.total_bytes_processed ?? 0),
          totalFilesProcessed: Number(obj.total_files_processed ?? 0),
        };
      }
    } catch {
      // Ignore non-JSON lines (e.g. password prompt fallbacks).
    }
  }
  return null;
}

// ─── Random-suffix helper (used by initRepoIfMissing follow-ups) ────────────

export function randomSuffix(byteLen = 4): string {
  return randomBytes(byteLen).toString('hex');
}
