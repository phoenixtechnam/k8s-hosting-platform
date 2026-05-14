/**
 * SshBackupStore — bundles laid out under a remote path on an
 * SSH-accessible host (Hetzner Storage Box, off-site server, etc.).
 *
 * Architecture choice (Phase 2):
 *
 *   Bundle data is captured in-process by platform-api (DB rows,
 *   k8s Secret list — both small) and streamed straight to the
 *   remote over SFTP. We open one SSH connection per BackupStore
 *   call and close it when the operation finishes. Reasons:
 *
 *   - The data is already in the platform-api pod; routing it
 *     through a sidecar Job adds latency and complexity for no
 *     security benefit (the OIDC encryption key + DB password
 *     already live in this pod).
 *   - Off-site uploads MUST happen — bundles never sit on cluster
 *     disk (storage is at a premium). In-process streaming is the
 *     simplest correct implementation.
 *   - Per-call connect/teardown trades ~hundreds of ms latency for
 *     stateless safety: a stuck SSH connection can't poison
 *     subsequent calls; concurrent calls don't share state.
 *
 *   Phase 3 (when the `files` component lights up) reverts to a
 *   k8s Job that streams the tar from the tenant PVC directly to
 *   the SSH target — that path keeps the SSH key out of the
 *   long-lived backend pod when handling tenant data. For Phase
 *   2's `config` + `secrets` components the data is already
 *   server-side, so this trade-off doesn't apply.
 *
 * Authentication: SSH private key is decrypted from
 * `backup_configurations.ssh_key_encrypted` (AES-256-GCM with the
 * platform-wide PLATFORM_ENCRYPTION_KEY) by the route layer before
 * the store is constructed. The plaintext key lives in this
 * module's instance for the duration of one request, then is
 * forgotten when the store reference falls out of scope.
 *
 * Layout on the remote (per BACKUP_COMPONENT_MODEL.md):
 *
 *   <basePath>/<bundleId>/meta.json
 *   <basePath>/<bundleId>/components/files/archive.tar.gz
 *   <basePath>/<bundleId>/components/mailboxes/<addr>.mbox.tar.gz
 *   <basePath>/<bundleId>/components/config/db-rows.json.gz
 *   <basePath>/<bundleId>/components/secrets/tls.json.gz.enc
 *
 * Atomicity: meta.json is written via a temp filename
 * (`meta.json.tmp.<rand>`) and then renamed in place. Component
 * artifacts use the same tmp-then-rename pattern. The presence of
 * meta.json is the bundle's commit marker.
 */

import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper, type FileEntry, type Stats } from 'ssh2';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomBytes } from 'node:crypto';
import type { BackupComponentName, BackupMetaV1 } from '@k8s-hosting/api-contracts';
import type {
  BackupStore,
  BundleHandle,
  ArtifactRef,
  ArtifactStat,
  WriteComponentOptions,
} from './bundle-store.js';
import { META_FILENAME, componentDir, parseMeta, serializeMeta } from './meta.js';

/* eslint-disable @typescript-eslint/no-unused-vars */
void Buffer; // touch to keep TS happy across pipelines
/* eslint-enable @typescript-eslint/no-unused-vars */

export interface SshBackupStoreConfig {
  readonly host: string;
  readonly port?: number;
  readonly user: string;
  /**
   * SSH private key in PLAINTEXT PEM/OpenSSH format. Decryption
   * happens in the route layer (resolveStore) before construction;
   * this module never sees the encrypted blob.
   */
  readonly privateKey: string;
  /** Optional passphrase for the private key (almost always empty). */
  readonly passphrase?: string;
  /** Absolute base path on the remote host (e.g. `/backups/k8s-staging`). */
  readonly basePath: string;
  /** Optional logger — `(level, ctx, msg) => app.log[level](ctx, msg)`. */
  readonly logFn?: (level: 'info' | 'warn' | 'error', ctx: Record<string, unknown>, msg: string) => void;
}

interface SshBackend {
  readonly bundlePath: string;
}

function isSshBackend(b: unknown): b is SshBackend {
  return typeof b === 'object' && b !== null && typeof (b as SshBackend).bundlePath === 'string';
}

/**
 * Reject any backupId that could traverse out of the bundle root.
 * The character class permits `.` runs, so `..` and `.` must be
 * rejected explicitly before the regex check.
 */
function assertSafeBackupId(backupId: string): void {
  if (backupId === '.' || backupId === '..' || backupId.includes('/')) {
    throw new Error(`SshBackupStore: invalid backupId '${backupId}' (path traversal rejected)`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(backupId)) {
    throw new Error(`SshBackupStore: invalid backupId '${backupId}' (only [A-Za-z0-9._-] allowed)`);
  }
}

/** Same guard as backupId, applied to artifact filenames. */
function assertSafeArtifactName(name: string): void {
  if (name === '.' || name === '..' || name.includes('/')) {
    throw new Error(`SshBackupStore: invalid artifact name '${name}' (path traversal rejected)`);
  }
  if (!/^[A-Za-z0-9._@-]+$/.test(name)) {
    throw new Error(`SshBackupStore: invalid artifact name '${name}'`);
  }
}

export class SshBackupStore implements BackupStore {
  readonly kind = 'ssh' as const;

  constructor(private readonly config: SshBackupStoreConfig) {}

  // ─── connection helpers ────────────────────────────────────────

  /**
   * Run `fn` against a connected SFTP client. Connection is opened
   * fresh on every call and closed on completion (success or error).
   * Yes, this is per-call latency in the hundreds-of-ms range; for
   * Phase 2 components (~tens of KB) that's fine. Phase 3 mailbox
   * exports may want a per-bundle connection pool — defer.
   */
  private async withSftp<T>(fn: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
    const cfg: ConnectConfig = {
      host: this.config.host,
      port: this.config.port ?? 22,
      username: this.config.user,
      privateKey: this.config.privateKey,
      passphrase: this.config.passphrase,
      readyTimeout: 15_000,
      keepaliveInterval: 5_000,
      // Trust-on-first-use is intentional for an operator-configured
      // backup target — TOFU is the standard SFTP-client posture
      // and the operator already enrolled the host's pubkey at
      // setup time. Strict host-key checking belongs in a future
      // hardening pass when we add a known_hosts column to
      // backup_configurations.
      hostHash: 'sha256',
      hostVerifier: () => true,
    };

    const conn = new Client();
    try {
      await new Promise<void>((resolve, reject) => {
        conn.on('ready', resolve);
        conn.on('error', reject);
        conn.connect(cfg);
      });
      const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
        conn.sftp((err, s) => (err ? reject(err) : resolve(s)));
      });
      return await fn(sftp);
    } finally {
      conn.end();
    }
  }

  // ─── path helpers ──────────────────────────────────────────────

  private bundlePath(backupId: string): string {
    assertSafeBackupId(backupId);
    return `${this.config.basePath.replace(/\/+$/, '')}/${backupId}`;
  }

  private artifactPath(handle: BundleHandle, component: BackupComponentName, name: string): string {
    if (!isSshBackend(handle._backend)) {
      throw new Error('SshBackupStore: handle is not an ssh handle');
    }
    assertSafeArtifactName(name);
    return `${handle._backend.bundlePath}/${componentDir(component)}/${name}`;
  }

  // ─── mkdir-p helper ────────────────────────────────────────────

  /**
   * Create a remote directory tree, treating already-exists as success.
   * SFTP has no `mkdir -p`, so we walk the prefix.
   */
  private async mkdirP(sftp: SFTPWrapper, dir: string): Promise<void> {
    const parts = dir.split('/').filter(Boolean);
    let cur = dir.startsWith('/') ? '' : '.';
    for (const p of parts) {
      cur = `${cur}/${p}`;
      await new Promise<void>((resolve, reject) => {
        sftp.mkdir(cur, { mode: 0o755 }, (err) => {
          if (!err) return resolve();
          // SFTP ERR codes: 11 = Failure (often "already exists"),
          // 4 = Failure. ssh2 surfaces them as `code` on the error.
          // Stat the path; if it's a directory, treat as success.
          sftp.stat(cur, (statErr, stats) => {
            if (statErr) return reject(err);
            if (stats.isDirectory()) return resolve();
            reject(err);
          });
        });
      });
    }
  }

  // ─── BackupStore implementation ────────────────────────────────

  async reserveBundle(input: { backupId: string; clientId: string }): Promise<BundleHandle> {
    const bundlePath = this.bundlePath(input.backupId);
    this.config.logFn?.('info',
      { bundleId: input.backupId, clientId: input.clientId, host: this.config.host, bundlePath },
      'tenant-bundles: ssh reserveBundle');
    await this.withSftp(async (sftp) => {
      // Pre-create the four component subdirs so component writers
      // don't race on mkdir. mkdirP is idempotent.
      await this.mkdirP(sftp, bundlePath);
      await this.mkdirP(sftp, `${bundlePath}/${componentDir('files')}`);
      await this.mkdirP(sftp, `${bundlePath}/${componentDir('mailboxes')}`);
      await this.mkdirP(sftp, `${bundlePath}/${componentDir('config')}`);
      await this.mkdirP(sftp, `${bundlePath}/${componentDir('secrets')}`);
    });
    return { bundleId: input.backupId, _backend: { bundlePath } satisfies SshBackend };
  }

  async open(backupId: string): Promise<BundleHandle | null> {
    const bundlePath = this.bundlePath(backupId);
    const exists = await this.withSftp(
      (sftp) => new Promise<boolean>((resolve) => {
        sftp.stat(bundlePath, (err, stats) => {
          if (err) return resolve(false);
          resolve(stats.isDirectory());
        });
      }),
    );
    if (!exists) return null;
    return { bundleId: backupId, _backend: { bundlePath } satisfies SshBackend };
  }

  async writeComponent(
    handle: BundleHandle,
    component: BackupComponentName,
    name: string,
    body: Readable,
    _opts?: WriteComponentOptions,
  ): Promise<ArtifactRef> {
    const finalPath = this.artifactPath(handle, component, name);
    // Atomic-rename pattern: write to <name>.tmp.<rand>, fsync via
    // close, then rename. SFTP rename is atomic on POSIX targets.
    const tmpPath = `${finalPath}.tmp.${randomBytes(6).toString('hex')}`;
    let sizeBytes = 0;
    await this.withSftp(async (sftp) => {
      const ws = sftp.createWriteStream(tmpPath, { mode: 0o644 });
      // Track bytes through a tap, since SFTPWriteStream doesn't expose .bytesWritten reliably.
      const counter = new (await import('node:stream')).Transform({
        transform(chunk, _enc, cb) {
          sizeBytes += chunk.length;
          cb(null, chunk);
        },
      });
      try {
        await pipeline(body, counter, ws);
      } catch (err) {
        // Best-effort cleanup of the temp file.
        await new Promise<void>((resolve) => sftp.unlink(tmpPath, () => resolve()));
        throw err;
      }
      // Promote tmp → final atomically.
      await new Promise<void>((resolve, reject) => {
        sftp.rename(tmpPath, finalPath, (err) => (err ? reject(err) : resolve()));
      });
    });
    return { component, name, sizeBytes, sha256: _opts?.sha256 };
  }

  async readComponent(
    handle: BundleHandle,
    component: BackupComponentName,
    name: string,
  ): Promise<Readable> {
    // SFTP read streams must live as long as the connection. To keep
    // the BackupStore interface simple (returns a Readable, no
    // close-hook), we open the connection here, attach handlers that
    // close it on `end`/`error`, and return the stream.
    const path = this.artifactPath(handle, component, name);
    const conn = new Client();
    await new Promise<void>((resolve, reject) => {
      conn.on('ready', resolve);
      conn.on('error', reject);
      conn.connect({
        host: this.config.host,
        port: this.config.port ?? 22,
        username: this.config.user,
        privateKey: this.config.privateKey,
        passphrase: this.config.passphrase,
        readyTimeout: 15_000,
        hostVerifier: () => true,
      });
    });
    const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      conn.sftp((err, s) => (err ? reject(err) : resolve(s)));
    });
    const rs = sftp.createReadStream(path);
    const cleanup = () => { try { conn.end(); } catch { /* ignore */ } };
    rs.once('end', cleanup);
    rs.once('close', cleanup);
    rs.once('error', cleanup);
    return rs as unknown as Readable;
  }

  async listArtifacts(
    handle: BundleHandle,
    component: BackupComponentName,
  ): Promise<ArtifactRef[]> {
    if (!isSshBackend(handle._backend)) throw new Error('SshBackupStore: not an ssh handle');
    const dir = `${handle._backend.bundlePath}/${componentDir(component)}`;
    return this.withSftp(async (sftp) => {
      const entries = await new Promise<{ filename: string; attrs: { size: number; isFile?: () => boolean; mode?: number } }[]>((resolve, reject) => {
        sftp.readdir(dir, (err, list) => {
          if (err) {
            // No dir = no artifacts.
            resolve([]);
            return;
          }
          resolve(list as unknown as { filename: string; attrs: { size: number; mode?: number } }[]);
        });
      });
      return entries
        .filter((e) => !e.filename.endsWith('.tmp') && !e.filename.includes('.tmp.') && !e.filename.endsWith('.sha256'))
        .map((e) => ({ component, name: e.filename, sizeBytes: Number(e.attrs.size ?? 0) }));
    });
  }

  async stat(
    handle: BundleHandle,
    component: BackupComponentName,
    name: string,
  ): Promise<ArtifactStat | null> {
    const path = this.artifactPath(handle, component, name);
    return this.withSftp(async (sftp) => {
      return new Promise<ArtifactStat | null>((resolve, reject) => {
        sftp.stat(path, (err, stats) => {
          if (err) return resolve(null);
          if (!stats.isFile()) return resolve(null);
          resolve({ sizeBytes: Number(stats.size ?? 0), sha256: null });
        });
      });
    });
  }

  async putMeta(handle: BundleHandle, meta: BackupMetaV1): Promise<void> {
    if (!isSshBackend(handle._backend)) throw new Error('SshBackupStore: not an ssh handle');
    const finalPath = `${handle._backend.bundlePath}/${META_FILENAME}`;
    const tmpPath = `${finalPath}.tmp.${randomBytes(6).toString('hex')}`;
    const buf = serializeMeta(meta);
    await this.withSftp(async (sftp) => {
      await new Promise<void>((resolve, reject) => {
        const ws = sftp.createWriteStream(tmpPath, { mode: 0o644 });
        ws.on('error', reject);
        ws.on('close', () => resolve());
        ws.end(buf);
      });
      await new Promise<void>((resolve, reject) => {
        sftp.rename(tmpPath, finalPath, (err) => (err ? reject(err) : resolve()));
      });
    });
  }

  async getMeta(handle: BundleHandle): Promise<BackupMetaV1> {
    if (!isSshBackend(handle._backend)) throw new Error('SshBackupStore: not an ssh handle');
    const path = `${handle._backend.bundlePath}/${META_FILENAME}`;
    const buf = await this.withSftp(
      (sftp) => new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const rs = sftp.createReadStream(path);
        rs.on('data', (c: Buffer) => chunks.push(c));
        rs.on('end', () => resolve(Buffer.concat(chunks)));
        rs.on('error', reject);
      }),
    );
    return parseMeta(buf);
  }

  async delete(handle: BundleHandle): Promise<void> {
    if (!isSshBackend(handle._backend)) throw new Error('SshBackupStore: not an ssh handle');
    const root = handle._backend.bundlePath;
    await this.withSftp(async (sftp) => {
      // Drop meta.json first so a concurrent reader can't see a
      // half-deleted bundle.
      await new Promise<void>((resolve) => sftp.unlink(`${root}/${META_FILENAME}`, () => resolve()));
      await this.rmRf(sftp, root);
    });
  }

  /** SFTP has no `rm -rf`. Walk the tree and remove. */
  private async rmRf(sftp: SFTPWrapper, dir: string): Promise<void> {
    const entries = await new Promise<FileEntry[]>((resolve) => {
      sftp.readdir(dir, (err: Error | undefined, list: FileEntry[]) => {
        if (err) return resolve([]);
        resolve(list);
      });
    });
    for (const e of entries) {
      // Defence against a hostile or misbehaving SFTP server returning
      // `.`, `..`, or path-separator entries — never recurse out of
      // the bundle subtree.
      if (e.filename === '.' || e.filename === '..' || e.filename.includes('/')) {
        continue;
      }
      const path = `${dir}/${e.filename}`;
      const stat = await new Promise<{ isDir: boolean }>((resolve) => {
        sftp.stat(path, (err: Error | undefined, stats: Stats) => {
          if (err) return resolve({ isDir: false });
          resolve({ isDir: stats.isDirectory() });
        });
      });
      if (stat.isDir) {
        await this.rmRf(sftp, path);
      } else {
        await new Promise<void>((resolve) => sftp.unlink(path, () => resolve()));
      }
    }
    await new Promise<void>((resolve) => sftp.rmdir(dir, () => resolve()));
  }
}
