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
import { Writable as WritableCtor } from 'node:stream';
import { pipeline } from 'node:stream/promises';
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
  /** Hard wall-clock ceiling. Default: 1 hour. Mitigates reviewer #8
   *  (semaphore-exhaustion if restic neither reads stdin nor exits). */
  readonly timeoutMs?: number;
  /**
   * Caller-supplied abort signal. When fired, the spawned restic
   * process is SIGKILL'd and `runResticBackup` rejects with
   * `restic backup aborted`. Used by the HTTP restic-stream route to
   * release pod resources when the tenant Job's PUT connection drops
   * — otherwise the spawn loiters waiting on stdin forever, holding
   * a semaphore slot + ~200 MiB of RSS per failed attempt.
   * (Staging 2026-05-11: 5 stuck "running" backup_jobs each leaving a
   * zombie restic alive long enough to OOMKill the platform-api pod.)
   */
  readonly abortSignal?: AbortSignal;
}

const DEFAULT_BACKUP_TIMEOUT_MS = 60 * 60 * 1000;

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
  return hkdfHex(secretHex, `restic-tenant-${assertClientId(clientId)}`);
}

/**
 * Derive the per-tenant DR-recovery password from the cluster's
 * DR_RECOVERY_KEY (a separate 32-byte secret from
 * OIDC_ENCRYPTION_KEY). Phase 1.5 multi-region/DR.
 *
 * Region B reproduces this deterministically given DR_RECOVERY_KEY +
 * the source-region clientId; that lets it open Region A's restic
 * repo via the secondary password added by `restic key add`. The
 * primary HKDF-over-OIDC password stays Region-A-only.
 *
 * Distinct info prefix prevents collision with the primary
 * derivation: even if an operator mistakenly uses the same key for
 * both, the resulting passwords differ.
 */
export function deriveDrRecoveryPassword(secretHex: string, clientId: string): string {
  return hkdfHex(secretHex, `dr-recovery:${assertClientId(clientId)}`);
}

function hkdfHex(secretHex: string, info: string): string {
  if (typeof secretHex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(secretHex)) {
    throw new Error('HKDF: key must be 32 bytes (64 hex chars)');
  }
  const secret = Buffer.from(secretHex, 'hex');
  // Salt is empty buffer per ADR-036 spec; matches Phase 0 spike.
  const out = hkdfSync('sha256', secret, Buffer.alloc(0), Buffer.from(info), 32);
  return Buffer.from(out).toString('hex');
}

function assertClientId(clientId: string): string {
  // Reviewer #1 HIGH: enforce the same CLIENT_ID_RE that the URI builder
  // uses, so derivation, repo path, and runtime guard all agree on the
  // valid id space. Otherwise a Phase 3 executor that parses tenant-id
  // from a snapshot tag could pass derivation but fail later — confusing.
  if (typeof clientId !== 'string' || !CLIENT_ID_RE.test(clientId)) {
    throw new Error(`clientId '${String(clientId).slice(0, 64)}' fails CLIENT_ID_RE`);
  }
  return clientId;
}

// ─── Region id derivation (Phase 1.5) ───────────────────────────────────────

const REGION_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Derive the snapshot-tag region id from the platform DNS apex
 * (PLATFORM_BASE_DOMAIN). Slugified so the value is shell-safe in
 * any context that consumes the tag (CLI args, SQL LIKE, URL paths).
 *
 * Operator may override via `tenant_backup_v2_settings.region_id_override`
 * if the auto-derived value collides with another cluster sharing the
 * same domain.
 */
export function deriveRegionId(domain: string, override?: string): string {
  if (override) {
    if (!REGION_ID_RE.test(override)) {
      throw new Error(
        `deriveRegionId: override '${override}' must match ${REGION_ID_RE.source}`,
      );
    }
    return override;
  }
  const slug = domain.toLowerCase().replace(/\./g, '-');
  if (!REGION_ID_RE.test(slug)) {
    throw new Error(
      `deriveRegionId: derived '${slug}' from domain '${domain}' is not a valid region id`,
    );
  }
  return slug;
}

// ─── Snapshot tag schema (Phase 1.5) ────────────────────────────────────────

/**
 * Bumps when the on-store snapshot tag layout or restore-side
 * interpretation changes in a way that requires migration. Read-side
 * code refuses to restore a snapshot whose `bundle-version=` exceeds
 * this constant (forward-incompat).
 */
export const BUNDLE_SCHEMA_VERSION = 2;

/** Restic tag values must avoid whitespace and shell metacharacters.
 *  Reviewer #6 MEDIUM: include `+` so semver build metadata
 *  (e.g. 1.2.3+build.456) does not silently fail at backup time. */
const TAG_VALUE_RE = /^[A-Za-z0-9._@+/-]+$/;
/** Format-checked, used to reject argv-flag-injection-style values
 *  in tag filters and key labels (reviewer #3, #5). The leading-char
 *  guard rejects '--rm' and similar that would be parsed as an argv
 *  flag if argv parsing ever changed in restic. */
const TAG_FILTER_RE = /^[A-Za-z0-9_][A-Za-z0-9._@+=/-]{0,254}$/;
const LABEL_RE = /^[A-Za-z0-9_][A-Za-z0-9._@/-]{0,254}$/;
/** Absolute path with no `..` segments. Used for runResticRestore
 *  targetDir + includes (reviewer #4). */
const ABS_PATH_RE = /^\/(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]*$/;

export interface SnapshotTagInputs {
  readonly bundleId: string;
  readonly clientId: string;
  readonly tenantSlug: string;
  readonly component: ResticComponent;
  readonly regionId: string;
  readonly platformVersion: string;
}

export function buildSnapshotTags(inputs: SnapshotTagInputs): string[] {
  const fields: ReadonlyArray<readonly [string, string]> = [
    ['bundle-version', String(BUNDLE_SCHEMA_VERSION)],
    ['platform-version', inputs.platformVersion],
    ['region', inputs.regionId],
    ['tenant-id', inputs.clientId],
    ['tenant-slug', inputs.tenantSlug],
    ['bundle-id', inputs.bundleId],
    ['component', inputs.component],
  ];
  for (const [k, v] of fields) {
    if (typeof v !== 'string' || v.length === 0 || v.length > 255) {
      throw new Error(`buildSnapshotTags: empty or oversized value for '${k}'`);
    }
    if (!TAG_VALUE_RE.test(v)) {
      throw new Error(`buildSnapshotTags: tag value for '${k}' contains disallowed characters`);
    }
  }
  if (!ALLOWED_COMPONENTS.has(inputs.component)) {
    throw new Error(`buildSnapshotTags: invalid component '${inputs.component}'`);
  }
  return fields.map(([k, v]) => `${k}=${v}`);
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
  // Reviewer #2 HIGH: every interpolation defensively shQuote'd. The
  // sftp.command string is passed to /bin/sh -c by SSH itself, so a
  // metacharacter in sshUser or sshHost would otherwise inject options
  // or commands. shQuote is a no-op on already-safe values.
  //
  // Phase 1 piece #10 perf: pin to the AES-NI hardware-accelerated
  // cipher (default cipher selection negotiates aes256-ctr which is
  // ~2× slower at our 5 GiB workload); disable SSH compression because
  // restic data is already chunked + encrypted (incompressible) and
  // CompressionLevel cycles waste CPU.
  const cmd =
    `ssh -i ${shQuote(keyPath)} -p ${shQuote(String(target.sshPort))} ` +
    `-c aes128-gcm@openssh.com ` +
    `-o Compression=no ` +
    `-o StrictHostKeyChecking=accept-new ` +
    `-o BatchMode=yes ` +
    `-o ServerAliveInterval=30 ` +
    `-s ${shQuote(`${target.sshUser}@${target.sshHost}`)} sftp`;
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

/**
 * Per-target restic options that maximize throughput. Returns a flat
 * `-o key=val …` arg list.
 *
 * - S3: `s3.connections=10` parallelizes pack uploads/downloads (default 5).
 *   Hetzner Object Storage handles 10 concurrent connections without
 *   throttling at our scale; AWS S3 docs recommend 25-100 for throughput.
 *   Higher gives diminishing returns and grows memory.
 *
 * - SFTP: no restic-side options; the SSH-side cipher + compression
 *   tuning lives in `prepareSftpArgs` (the `sftp.command` value).
 *
 * - hostpath: nothing to tune.
 */
function performanceOpts(target: BackupTarget): string[] {
  switch (target.kind) {
    case 's3':
      return ['-o', 's3.connections=10'];
    case 'ssh':
    case 'hostpath':
      return [];
  }
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
    // Backend-specific perf flags (s3.connections, etc.). Must come
    // BEFORE the subcommand for restic to parse them.
    cliArgs.push(...performanceOpts(args.target));
    cliArgs.push('backup');
    cliArgs.push('--stdin');
    cliArgs.push('--stdin-filename', args.stdinFilename);
    cliArgs.push('--json');
    // Memory-bounded restic flags (Phase 1 piece #8 — staging measured
    // 389 MiB peak on 5 GiB stream; target <256 MiB):
    // - read-concurrency 1: single reader (no concurrent stdin makes sense)
    // - compression off: tenant tar carries already-compressed content
    //   (jpegs, mp4, .gz dumps) where restic compression wastes CPU + RAM
    //   for ≤1% gain. Drops restic working set by ~80–120 MiB.
    // - pack-size 64 (default 16): 4× fewer S3/SFTP round-trips per backup.
    //   Cuts restore wall-clock substantially (RTT-dominated). Memory cost
    //   is one in-flight pack buffer ≈ +48 MiB; still well under 256 MiB.
    cliArgs.push('--read-concurrency', '1');
    cliArgs.push('--compression', 'off');
    cliArgs.push('--pack-size', '64');
    for (const tag of args.tags) {
      cliArgs.push('--tag', tag);
    }

    // Phase 1 piece #7 staging fix: ensure repo is initialised before
    // first backup. `restic backup` exits non-zero if the repo doesn't
    // exist; that exit kills the spawned subprocess; the next stdin
    // write then emits EPIPE on a Socket with no listener and Node
    // crashes the entire platform-api process. Initialising up-front
    // is idempotent (restic init returns "config file already exists"
    // when present) and quick (~5s on first call, instant after).
    await ensureResticRepoInitialised({
      target: args.target,
      passwordHex: args.passwordHex,
      repoUri,
    });

    const child = spawnRestic(cliArgs, env);

    // Phase 1 piece #11 — abort hook. When the route's HTTP request is
    // aborted (tenant Job crashed mid-PUT, platform-api gets ECONNRESET
    // from the upstream NIC, etc.), the caller fires args.abortSignal
    // and we SIGKILL the spawned restic so the semaphore slot + ~200
    // MiB RSS get released immediately. Without this, the spawn loiters
    // on stdin forever (the pipeline source is dead but the child has
    // no way to learn that) and accumulating zombies eventually OOM-kill
    // the pod. Staging 2026-05-11 showed 5 stuck "running" backup_jobs,
    // each leaving one such zombie.
    //
    // The source stream (args.stdin) is also destroyed — otherwise the
    // `pipeline(args.stdin, safeRestStdin)` Promise stays pending forever
    // because the source keeps producing chunks while the sink is gone,
    // and Promise.all([stdinPromise, exitPromise]) below would block on
    // it until the timeout. Destroying the source rejects the pipeline,
    // freeing the awaiter.
    const cancelSpawn = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore — child may already be gone */
      }
      try {
        (args.stdin as Readable).destroy?.(new Error('restic backup aborted'));
      } catch {
        /* ignore — source may already be ended */
      }
    };
    let abortListener: (() => void) | undefined;
    if (args.abortSignal) {
      if (args.abortSignal.aborted) {
        cancelSpawn();
      } else {
        abortListener = cancelSpawn;
        args.abortSignal.addEventListener('abort', abortListener, { once: true });
      }
    }

    // Phase 1 piece #7 OOM fix: pipe with proper backpressure.
    // The previous data-event listener didn't respect child.stdin's
    // returned-false from write() — chunks piled up in the writable
    // buffer faster than restic could consume them, growing memory
    // until pod OOM-killed (exit 137 on staging 2026-05-10).
    //
    // node:stream/promises pipeline() handles backpressure end-to-end:
    // the source pauses when the destination signals it's full,
    // resumes on 'drain'. Memory stays bounded to the highWaterMark
    // (default 16 KiB).
    //
    // EPIPE: pipeline() forwards errors from either side; we wrap
    // restic's stdin in a Writable that swallows post-close EPIPE
    // (benign — restic's exit code is the real signal).
    const ericChildStdin = child.stdin as Writable;
    const safeRestStdin = new WritableCtor({
      // 256 KiB — fewer context switches at high throughput than the
      // 64 KiB default; still bounded so a stalled restic doesn't
      // accumulate a runaway buffer. Pairs with the 1 MiB tar chunk
      // size that the tenant Job's curl uses for its outbound side.
      highWaterMark: 256 * 1024,
      write(chunk, _enc, cb) {
        if (!ericChildStdin.writable) {
          // restic exited; drop the chunk. The exit watcher will
          // surface the underlying restic failure shortly.
          cb();
          return;
        }
        ericChildStdin.write(chunk, (err) => {
          if (err && (err as NodeJS.ErrnoException).code === 'EPIPE') {
            // benign — restic closed its end. Don't propagate.
            cb();
          } else {
            cb(err ?? undefined);
          }
        });
      },
      final(cb) {
        try {
          ericChildStdin.end();
        } catch {
          /* ignore */
        }
        cb();
      },
    });
    // Belt-and-braces: a direct EPIPE on child.stdin (e.g. between
    // the readable check and the write callback) still needs a
    // listener or Node throws unhandled.
    ericChildStdin.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code !== 'EPIPE') {
        // eslint-disable-next-line no-console
        console.warn(`[restic-driver] child stdin error: ${(err as Error).message}`);
      }
    });
    const stdinPromise: Promise<void> = pipeline(args.stdin, safeRestStdin).catch((err) => {
      // EPIPE through pipeline: treat as benign so the exit watcher
      // can surface restic's true exit code/stderr instead.
      if ((err as NodeJS.ErrnoException).code === 'EPIPE') return;
      // Abort path: cancelSpawn destroys the source with this exact
      // message so the pipeline can unblock. Swallow so the exit
      // watcher reports the SIGKILL, then the post-await check on
      // abortSignal.aborted throws the user-facing aborted error.
      if (err instanceof Error && /restic backup aborted/.test(err.message)) return;
      throw err;
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

    // Reviewer #8 MEDIUM: hard timeout. Without this, a stalled
    // restic (network black-hole to S3, lock contention, kernel pipe
    // back-pressure deadlock) would hold the per-pod semaphore slot
    // indefinitely. With cap=4, four such stalls halt every tenant
    // backup in this pod until restart.
    const timeoutMs = args.timeoutMs ?? DEFAULT_BACKUP_TIMEOUT_MS;
    let timeoutTimer: NodeJS.Timeout | undefined;
    const timeoutP = new Promise<{ kind: 'timeout' }>((resolveTimeout) => {
      timeoutTimer = setTimeout(() => resolveTimeout({ kind: 'timeout' }), timeoutMs);
    });

    try {
      const winner = await Promise.race([
        Promise.all([stdinPromise, exitPromise]).then(([_, code]) => ({ kind: 'done' as const, code })),
        timeoutP,
      ]);
      if (winner.kind === 'timeout') {
        try {
          child.kill('SIGTERM');
        } catch {
          /* ignore */
        }
        // Best-effort wait so the process unwinds before we return; do
        // NOT await indefinitely.
        await Promise.race([
          exitPromise,
          new Promise((res) => setTimeout(res, 5_000)),
        ]);
        throw new Error(
          `restic backup timed out after ${Math.round(timeoutMs / 1000)}s (clientId=${args.clientId} component=${args.component})`,
        );
      }
      if (args.abortSignal?.aborted) {
        // SIGKILL'd exit codes are reported as 137 on Linux, but the
        // exit watcher is generic. Throw a recognisable error so the
        // caller can map it to a 499/ABORTED HTTP response and the
        // orchestrator can record it as a transient failure rather
        // than a "real" restic crash.
        throw new Error('restic backup aborted (HTTP request cancelled)');
      }
      if (winner.code !== 0) {
        throw new Error(`restic backup exited ${winner.code}: ${stderrBuf.trim() || stdoutBuf.trim()}`);
      }
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (abortListener && args.abortSignal) {
        args.abortSignal.removeEventListener('abort', abortListener);
      }
      try {
        child.stdin.end();
      } catch {
        /* ignore — child may already be gone */
      }
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

// ─── Restore (Phase 1.5) ────────────────────────────────────────────────────

const SNAPSHOT_ID_RE = /^[0-9a-f]{8,64}$/;

export interface RunResticRestoreArgs {
  readonly target: BackupTarget;
  readonly snapshotId: string;
  readonly passwordHex: string;
  readonly targetDir: string;
  readonly includes?: ReadonlyArray<string>;
  /** When true, passes --no-lock — required for read-only buckets and
   *  for cross-region external restores where Region B has no write
   *  access to Region A's lock keyspace. */
  readonly readOnly: boolean;
  readonly semaphore?: ResticConcurrencySemaphore;
}

/**
 * Run `restic restore <snapshotId> --target <dir> [--include …]
 * [--no-lock]`. Used both for in-region restores (readOnly=false) and
 * cross-region read-only restores from external repos
 * (readOnly=true).
 */
export async function runResticRestore(args: RunResticRestoreArgs): Promise<void> {
  if (!SNAPSHOT_ID_RE.test(args.snapshotId)) {
    throw new Error(`runResticRestore: invalid snapshotId '${args.snapshotId}'`);
  }
  // Reviewer #4 MEDIUM: validate targetDir (must be an absolute path
  // without `..` segments) and every include path before they reach
  // restic argv. nodeSpawn protects against shell injection, but a
  // value like `--rm` would silently no-op (no matches) and a path
  // like `/` would let the restore overwrite the platform root.
  if (!ABS_PATH_RE.test(args.targetDir)) {
    throw new Error(`runResticRestore: invalid targetDir '${args.targetDir}'`);
  }
  for (const inc of args.includes ?? []) {
    if (!ABS_PATH_RE.test(inc)) {
      throw new Error(`runResticRestore: invalid include path '${inc}'`);
    }
  }
  const sem = args.semaphore ?? DEFAULT_SEM;
  const release = await sem.acquire();
  let sftpCleanup: (() => Promise<void>) | null = null;
  try {
    const repoUriComponentScan = args.target;
    const repoUri = buildResticRepoUriForRestore(repoUriComponentScan, args.snapshotId);
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
    cliArgs.push(...performanceOpts(args.target));
    if (args.readOnly) cliArgs.push('--no-lock');
    cliArgs.push('restore', args.snapshotId);
    cliArgs.push('--target', args.targetDir);
    // Phase 1 piece #10 perf: parallel pack decryption (default 8).
    // Doubles restore throughput on the staging Storage Box test.
    cliArgs.push('--workers', '16');
    for (const inc of args.includes ?? []) {
      cliArgs.push('--include', inc);
    }
    cliArgs.push('--json');

    const child = spawnRestic(cliArgs, env);
    let stderrBuf = '';
    child.stderr.on('data', (c: Buffer) => {
      stderrBuf += c.toString('utf8');
    });
    // Drain stdout so the child doesn't block on pipe back-pressure.
    child.stdout.on('data', () => {
      /* drop */
    });
    const code = await new Promise<number>((resolve) => {
      const finish = (c: number | null) => resolve(c ?? 0);
      child.on('exit', finish);
      child.on('close', finish);
    });
    if (code !== 0) {
      throw new Error(`restic restore exited ${code}: ${stderrBuf.trim()}`);
    }
  } finally {
    if (sftpCleanup) await sftpCleanup();
    release();
  }
}

// ─── Snapshot listing (Phase 1.5) ───────────────────────────────────────────

export interface ResticSnapshotMeta {
  readonly id: string;
  readonly shortId: string;
  readonly time: string;
  readonly tags: ReadonlyArray<string>;
}

export interface ListResticSnapshotsArgs {
  readonly target: BackupTarget;
  readonly passwordHex: string;
  readonly readOnly: boolean;
  /** Server-side narrowing: every filter becomes `--tag <k=v>`. */
  readonly tagFilters?: ReadonlyArray<string>;
  readonly semaphore?: ResticConcurrencySemaphore;
}

export async function listResticSnapshots(args: ListResticSnapshotsArgs): Promise<ResticSnapshotMeta[]> {
  const sem = args.semaphore ?? DEFAULT_SEM;
  const release = await sem.acquire();
  let sftpCleanup: (() => Promise<void>) | null = null;
  try {
    // For listing we don't need a per-component repo URI — the restic
    // repo IS the per-(client,component) directory. Caller passes a
    // BackupTarget already pointed at a specific repo prefix; we
    // mirror it without appending. Use a pseudo-component to satisfy
    // the type constraint on the URI builder; for listing we skip the
    // URI rewrite and use the target's repo path directly. Implementation
    // detail: callers always invoke via resolveExternalRepoUri which
    // yields the exact repo URI — listing is a thin shim around that.
    const repoUri = buildResticRepoUriForRestore(args.target, 'list-only');
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
    cliArgs.push(...performanceOpts(args.target));
    if (args.readOnly) cliArgs.push('--no-lock');
    cliArgs.push('snapshots', '--json');
    // Reviewer #3 HIGH: validate every tag filter before it reaches
    // argv. A filter starting with `--` would not inject a flag (restic
    // parses positionally) but inconsistent shapes are still a smell;
    // we want a tight allowlist so route-bound callers can't pass
    // arbitrary user input through.
    for (const t of args.tagFilters ?? []) {
      if (!TAG_FILTER_RE.test(t)) {
        throw new Error(`listResticSnapshots: invalid tag filter '${t}'`);
      }
      cliArgs.push('--tag', t);
    }
    const child = spawnRestic(cliArgs, env);
    let stdoutBuf = '';
    let stderrBuf = '';
    child.stdout.on('data', (c: Buffer) => {
      stdoutBuf += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      stderrBuf += c.toString('utf8');
    });
    const code = await new Promise<number>((resolve) => {
      const finish = (c: number | null) => resolve(c ?? 0);
      child.on('exit', finish);
      child.on('close', finish);
    });
    if (code !== 0) {
      throw new Error(`restic snapshots exited ${code}: ${stderrBuf.trim()}`);
    }
    const parsed = parseSnapshotList(stdoutBuf);
    return parsed;
  } finally {
    if (sftpCleanup) await sftpCleanup();
    release();
  }
}

function parseSnapshotList(stdoutBuf: string): ResticSnapshotMeta[] {
  const trimmed = stdoutBuf.trim();
  if (!trimmed) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`restic snapshots: malformed JSON (${(err as Error).message})`);
  }
  if (!Array.isArray(arr)) return [];
  return arr.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      id: String(r.id ?? ''),
      shortId: String(r.short_id ?? ''),
      time: String(r.time ?? ''),
      tags: Array.isArray(r.tags) ? (r.tags as unknown[]).map(String) : [],
    };
  });
}

/**
 * For restore + list operations the caller provides a BackupTarget
 * that ALREADY points at the per-tenant repo. We pass it through
 * verbatim to restic. (For backup we own the prefix construction —
 * see buildResticRepoUri.)
 */
function buildResticRepoUriForRestore(target: BackupTarget, _hint: string): string {
  switch (target.kind) {
    case 's3':
      return `s3:${target.s3Endpoint.replace(/\/$/, '')}/${target.s3Bucket}${
        target.s3Prefix ? `/${target.s3Prefix.replace(/^\/+|\/+$/g, '')}` : ''
      }`;
    case 'ssh': {
      const path = target.sshPath.replace(/^\/+|\/+$/g, '');
      return path
        ? `sftp:${target.sshUser}@${target.sshHost}:${path}`
        : `sftp:${target.sshUser}@${target.sshHost}:`;
    }
    case 'hostpath':
      return target.hostPath.replace(/\/$/, '');
  }
}

// ─── Key management (Phase 1.5) ─────────────────────────────────────────────

const PASSWORD_HEX_RE = /^[0-9a-fA-F]{64}$/;

export interface AddResticKeyArgs {
  readonly target: BackupTarget;
  /** Existing password that already opens the repo (typically the
   *  source-region primary password). */
  readonly currentPasswordHex: string;
  /** New password to add (DR-recovery or one-shot migration key). */
  readonly newPasswordHex: string;
  /** Free-text label restic stores with the new key. Helps operators
   *  identify which key to remove later. */
  readonly hostLabel?: string;
  readonly userLabel?: string;
  readonly semaphore?: ResticConcurrencySemaphore;
}

/**
 * Run `restic key add`. The new password is fed via stdin so it never
 * appears on argv or in /proc/<pid>/environ. Used by the orchestrator
 * after first-successful-backup to attach the cluster's DR-recovery
 * password, and by the admin UI for one-shot migration keys.
 */
export async function addResticKey(args: AddResticKeyArgs): Promise<void> {
  if (!PASSWORD_HEX_RE.test(args.currentPasswordHex)) {
    throw new Error('addResticKey: currentPasswordHex must be 64 hex chars');
  }
  if (!PASSWORD_HEX_RE.test(args.newPasswordHex)) {
    throw new Error('addResticKey: newPasswordHex must be 64 hex chars');
  }
  const sem = args.semaphore ?? DEFAULT_SEM;
  const release = await sem.acquire();
  let sftpCleanup: (() => Promise<void>) | null = null;
  try {
    const repoUri = buildResticRepoUriForRestore(args.target, 'key-add');
    const env = {
      ...buildResticEnv(args.target),
      RESTIC_PASSWORD: args.currentPasswordHex,
    };
    const cliArgs: string[] = [];
    if (args.target.kind === 'ssh') {
      const prepared = await prepareSftpArgs(args.target);
      sftpCleanup = prepared.cleanup;
      cliArgs.push(...prepared.args);
    }
    cliArgs.push('--repo', repoUri);
    cliArgs.push(...performanceOpts(args.target));
    cliArgs.push('key', 'add');
    cliArgs.push('--new-password-file', '/dev/stdin');
    // Reviewer #5 MEDIUM: validate labels — a value like
    // '--new-password-file' would push '--host' '--new-password-file'
    // into argv, redirecting restic's password file to whatever the
    // userLabel value happens to be (the next argv element).
    if (args.hostLabel) {
      if (!LABEL_RE.test(args.hostLabel)) {
        throw new Error(`addResticKey: invalid hostLabel '${args.hostLabel}'`);
      }
      cliArgs.push('--host', args.hostLabel);
    }
    if (args.userLabel) {
      if (!LABEL_RE.test(args.userLabel)) {
        throw new Error(`addResticKey: invalid userLabel '${args.userLabel}'`);
      }
      cliArgs.push('--user', args.userLabel);
    }

    const child = spawnRestic(cliArgs, env);
    let stderrBuf = '';
    child.stdout.on('data', () => {
      /* drop */
    });
    child.stderr.on('data', (c: Buffer) => {
      stderrBuf += c.toString('utf8');
    });
    child.stdin.write(args.newPasswordHex);
    child.stdin.end();
    const code = await new Promise<number>((resolve) => {
      const finish = (c: number | null) => resolve(c ?? 0);
      child.on('exit', finish);
      child.on('close', finish);
    });
    if (code !== 0) {
      throw new Error(`restic key add exited ${code}: ${stderrBuf.trim()}`);
    }
  } finally {
    if (sftpCleanup) await sftpCleanup();
    release();
  }
}

// ─── Repo initialisation (Phase 1 piece #7) ─────────────────────────────────

/**
 * Run `restic init` if the repo doesn't exist yet. Idempotent:
 * restic returns exit 0 with "config file already exists" when the
 * repo is already present, and we treat any "already exists" stderr
 * as success regardless of exit code (defence against future restic
 * exit-code changes).
 *
 * Required because `restic backup --stdin` against an uninitialised
 * repo exits immediately with non-zero. The early exit then closes
 * the subprocess's stdin, which makes our pipe write throw EPIPE on
 * a Socket with no error listener — and Node's default behaviour is
 * to crash the entire process.
 */
async function ensureResticRepoInitialised(args: {
  target: BackupTarget;
  passwordHex: string;
  repoUri: string;
}): Promise<void> {
  const env = {
    ...buildResticEnv(args.target),
    RESTIC_PASSWORD: args.passwordHex,
  };
  let sftpCleanup: (() => Promise<void>) | null = null;
  try {
    const cliArgs: string[] = [];
    if (args.target.kind === 'ssh') {
      const prepared = await prepareSftpArgs(args.target);
      sftpCleanup = prepared.cleanup;
      cliArgs.push(...prepared.args);
    }
    cliArgs.push('--repo', args.repoUri);
    cliArgs.push(...performanceOpts(args.target));
    cliArgs.push('init');

    const child = spawnRestic(cliArgs, env);
    let stdoutBuf = '';
    let stderrBuf = '';
    child.stdout.on('data', (c: Buffer) => {
      stdoutBuf += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      stderrBuf += c.toString('utf8');
    });
    // Unused stdin — close it immediately so restic doesn't wait.
    try {
      child.stdin.on('error', () => undefined);
      child.stdin.end();
    } catch {
      /* ignore */
    }
    const code = await new Promise<number>((resolve) => {
      const finish = (c: number | null) => resolve(c ?? 0);
      child.on('exit', finish);
      child.on('close', finish);
    });
    if (code === 0) return;
    // Idempotent paths: "config file already exists" / "repository already initialized"
    const combined = (stderrBuf + stdoutBuf).toLowerCase();
    if (combined.includes('already') && (combined.includes('exists') || combined.includes('initialized'))) {
      return;
    }
    throw new Error(`restic init exited ${code}: ${stderrBuf.trim() || stdoutBuf.trim()}`);
  } finally {
    if (sftpCleanup) await sftpCleanup();
  }
}

// ─── Random-suffix helper (used by initRepoIfMissing follow-ups) ────────────

export function randomSuffix(byteLen = 4): string {
  return randomBytes(byteLen).toString('hex');
}
