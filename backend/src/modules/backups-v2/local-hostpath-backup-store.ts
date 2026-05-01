/**
 * LocalHostPathBackupStore — bundles laid out as a directory tree on
 * a hostPath volume mounted into the platform-api pod.
 *
 * Layout (per BACKUP_COMPONENT_MODEL.md):
 *
 *   <root>/<bundleId>/
 *     meta.json                          (commit marker — written last)
 *     components/files/archive.tar.gz
 *     components/files/archive.tar.gz.sha256
 *     components/files/tree.jsonl.gz
 *     components/mailboxes/<addr>.mbox.tar.gz
 *     components/mailboxes/<addr>.mbox.tar.gz.sha256
 *     components/config/db-rows.json.gz
 *     components/secrets/tls.json.gz.enc
 *
 * Atomicity: meta.json is written via rename(.tmp → meta.json) so the
 * presence of meta.json is the single commit marker. Component writes
 * use the same tmp-then-rename pattern within their component dir so
 * a crash mid-upload never leaves a half-written artifact visible.
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat as fsStat, readdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import type { BackupComponentName, BackupMetaV1 } from '@k8s-hosting/api-contracts';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type {
  BackupStore,
  BundleHandle,
  ArtifactRef,
  ArtifactStat,
  WriteComponentOptions,
} from './bundle-store.js';
import { META_FILENAME, componentDir, parseMeta, serializeMeta } from './meta.js';
import { ensureHostpathDirs } from './hostpath-job.js';

/**
 * Constructor input for the production wiring (Phase 2).
 *
 * Exists because the platform-api pod runs as uid 1000 but the
 * /var/lib/platform/snapshots hostPath on every node is owned by
 * root:root 0755 — so the pod can't `mkdir` under it directly.
 *
 * The store delegates the parent-directory create to a one-shot Job
 * (running as root in PLATFORM_TENANT_OPS_NS) the first time
 * `reserveBundle` is called for a given root. After that, the parent
 * is 0777 and the pod can create per-bundle subdirs in-process.
 *
 * The unit-test wiring (single-arg `new LocalHostPathBackupStore(tmpdir)`)
 * skips the Job entirely; tmpdirs are pod-writable.
 */
export interface LocalHostPathStoreConfig {
  /** In-pod path the store reads/writes (e.g. /snapshots/_bundles_v2). */
  readonly inPodRoot: string;
  /** Node-side hostPath the snapshots volume is backed by (e.g.
   *  /var/lib/platform/snapshots). The Job mounts this. */
  readonly hostpathRoot: string;
  /** In-Job mount path of that hostPath (matches platform-api's
   *  mountPath, typically /snapshots). */
  readonly mountPath: string;
  /** K8s client. When undefined the store skips the Job (tests). */
  readonly k8s?: K8sClients;
  /** Optional logger — typically `(level, ctx, msg) => app.log[level](ctx, msg)`.
   *  Used for forensic-trail entries on privileged-Job spawns. */
  readonly logFn?: (level: 'info' | 'warn' | 'error', ctx: Record<string, unknown>, msg: string) => void;
}

interface HostPathBackend {
  readonly root: string;
  readonly bundleDir: string;
}

function isHostPathBackend(b: unknown): b is HostPathBackend {
  return typeof b === 'object' && b !== null
    && typeof (b as HostPathBackend).root === 'string'
    && typeof (b as HostPathBackend).bundleDir === 'string';
}

export class LocalHostPathBackupStore implements BackupStore {
  readonly kind = 'hostpath' as const;

  private readonly root: string;
  private readonly normalizedRoot: string;
  private readonly hostpathRoot?: string;
  private readonly mountPath?: string;
  private readonly k8s?: K8sClients;
  private readonly logFn?: LocalHostPathStoreConfig['logFn'];
  /**
   * Memoised promise — the dir-create Job runs at most once per
   * process per root. Concurrent reserveBundle callers all share this
   * one promise instead of each spawning their own Job. On error the
   * promise is reset to null so the next call can retry.
   */
  private parentEnsuredPromise: Promise<void> | null = null;

  /**
   * Two construction modes:
   *   1. Test wiring — `new LocalHostPathBackupStore('/tmp/xxx')`. The
   *      tmpdir is already pod-writable, no Job needed.
   *   2. Production wiring — `new LocalHostPathBackupStore({ inPodRoot, hostpathRoot, mountPath, k8s })`.
   *      The store will run a one-shot root-Job to ensure the parent
   *      hostPath dir is 0777 before the pod tries to mkdir under it.
   */
  constructor(config: string | LocalHostPathStoreConfig) {
    if (typeof config === 'string') {
      this.root = config;
    } else {
      this.root = config.inPodRoot;
      this.hostpathRoot = config.hostpathRoot;
      this.mountPath = config.mountPath;
      this.k8s = config.k8s;
      this.logFn = config.logFn;
    }
    this.normalizedRoot = resolve(this.root);
  }

  /**
   * Ensure the in-pod parent dir exists with 0777 perms by running a
   * one-shot root Job that does `install -d -m 0777` on the
   * corresponding host path. Called lazily on first reserveBundle.
   *
   * Idempotent — `install -d` is a no-op when the dir already has the
   * right mode, and we memoise the result for the lifetime of the
   * process so the Job runs at most once per platform-api pod.
   */
  private ensureParentWritable(bundleId: string, clientId: string): Promise<void> {
    if (!this.k8s || !this.hostpathRoot || !this.mountPath) {
      // Test/dev wiring — assume the parent is already pod-writable
      // (e.g. an mkdtemp under /tmp). Skip the Job.
      return Promise.resolve();
    }
    // Memoise the promise: every concurrent caller shares the same
    // Job spawn + poll. On failure we reset to null so the next call
    // can retry (e.g. transient apiserver 5xx, expired Job ttl).
    if (this.parentEnsuredPromise) return this.parentEnsuredPromise;

    // Compute the node-side path for the in-pod root. We rely on the
    // caller having configured `mountPath` to match where the platform-api
    // pod mounts `hostpathRoot`. So `inPodRoot` should sit under `mountPath`.
    if (!this.root.startsWith(this.mountPath)) {
      return Promise.reject(new Error(
        `LocalHostPathBackupStore: inPodRoot '${this.root}' must be under mountPath '${this.mountPath}'`,
      ));
    }
    const subPath = this.root.slice(this.mountPath.length).replace(/^\/+/, '');
    const hostParent = subPath ? `${this.hostpathRoot}/${subPath}` : this.hostpathRoot;
    // Capture the host-side path in the in-memory log so a future
    // forensic review can reconstruct when bundle dirs were created
    // on this node. The orchestrator writes the backup_jobs row
    // separately; this line specifically covers the privileged dir
    // create.
    this.logFn?.('info', { bundleId, clientId, hostParent, ns: 'platform-tenant-ops' },
      'backups-v2: ensuring bundle hostpath parent (root Job)');
    this.parentEnsuredPromise = ensureHostpathDirs({
      k8s: this.k8s,
      bundleId,
      clientId,
      hostpathRoot: this.hostpathRoot,
      mountPath: this.mountPath,
      paths: [hostParent],
    }).catch((err) => {
      // Reset so a transient failure doesn't permanently wedge the
      // process — the next reserveBundle gets a fresh attempt.
      this.parentEnsuredPromise = null;
      throw err;
    });
    return this.parentEnsuredPromise;
  }

  /**
   * Build a bundle directory path inside `root`, rejecting any backupId
   * that resolves outside of it (path traversal defence).
   * Callers normally have backupId from `randomUUID()`, but DELETE/GET
   * routes accept it from the URL — so we never trust it without checking.
   */
  private safeBundleDir(backupId: string): string {
    const candidate = resolve(this.normalizedRoot, backupId);
    if (candidate !== this.normalizedRoot && !candidate.startsWith(`${this.normalizedRoot}/`)) {
      throw new Error(`LocalHostPathBackupStore: invalid backupId '${backupId}' (path traversal rejected)`);
    }
    return candidate;
  }

  private resolveBackend(handle: BundleHandle): HostPathBackend {
    if (!isHostPathBackend(handle._backend)) {
      throw new Error('LocalHostPathBackupStore: handle is not a hostpath handle');
    }
    return handle._backend;
  }

  private artifactPath(backend: HostPathBackend, component: BackupComponentName, name: string): string {
    return join(backend.bundleDir, componentDir(component), name);
  }

  async reserveBundle(input: { backupId: string; clientId: string }): Promise<BundleHandle> {
    // Make sure the parent root is pod-writable before the in-process
    // mkdir. Idempotent + memoised — first call spawns a tiny Job, all
    // subsequent calls in the same process are no-ops.
    await this.ensureParentWritable(input.backupId, input.clientId);
    const bundleDir = this.safeBundleDir(input.backupId);
    // Create the bundle root + four component subdirs up-front so component
    // writers don't race on mkdir for sibling artifacts.
    await mkdir(bundleDir, { recursive: true });
    await Promise.all([
      mkdir(join(bundleDir, componentDir('files')), { recursive: true }),
      mkdir(join(bundleDir, componentDir('mailboxes')), { recursive: true }),
      mkdir(join(bundleDir, componentDir('config')), { recursive: true }),
      mkdir(join(bundleDir, componentDir('secrets')), { recursive: true }),
    ]);
    return {
      bundleId: input.backupId,
      _backend: { root: this.root, bundleDir },
    };
  }

  async open(backupId: string): Promise<BundleHandle | null> {
    const bundleDir = this.safeBundleDir(backupId);
    try {
      const s = await fsStat(bundleDir);
      if (!s.isDirectory()) return null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    return { bundleId: backupId, _backend: { root: this.root, bundleDir } };
  }

  async writeComponent(
    handle: BundleHandle,
    component: BackupComponentName,
    name: string,
    body: Readable,
    _opts?: WriteComponentOptions,
  ): Promise<ArtifactRef> {
    const backend = this.resolveBackend(handle);
    const finalPath = this.artifactPath(backend, component, name);
    // Tmp-then-rename to keep the partial artifact invisible on crash.
    const tmpPath = `${finalPath}.tmp`;
    await mkdir(dirname(tmpPath), { recursive: true });
    await pipeline(body, createWriteStream(tmpPath));
    await rename(tmpPath, finalPath);
    const s = await fsStat(finalPath);
    return {
      component,
      name,
      sizeBytes: s.size,
      sha256: _opts?.sha256,
    };
  }

  async readComponent(
    handle: BundleHandle,
    component: BackupComponentName,
    name: string,
  ): Promise<Readable> {
    const backend = this.resolveBackend(handle);
    return createReadStream(this.artifactPath(backend, component, name));
  }

  async listArtifacts(
    handle: BundleHandle,
    component: BackupComponentName,
  ): Promise<ArtifactRef[]> {
    const backend = this.resolveBackend(handle);
    const dir = join(backend.bundleDir, componentDir(component));
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const refs: ArtifactRef[] = [];
    for (const name of entries) {
      // Skip in-flight tmp files and sha256 sidecars — they are not artifacts.
      if (name.endsWith('.tmp')) continue;
      if (name.endsWith('.sha256')) continue;
      const s = await fsStat(join(dir, name));
      if (!s.isFile()) continue;
      refs.push({ component, name, sizeBytes: s.size });
    }
    return refs;
  }

  async stat(
    handle: BundleHandle,
    component: BackupComponentName,
    name: string,
  ): Promise<ArtifactStat | null> {
    const backend = this.resolveBackend(handle);
    const path = this.artifactPath(backend, component, name);
    try {
      const s = await fsStat(path);
      if (!s.isFile()) return null;
      // Sidecar sha256 is opportunistically read so callers don't have
      // to hash the artifact a second time.
      let sha256: string | null = null;
      try {
        sha256 = (await readFile(`${path}.sha256`, 'utf8')).trim().split(/\s+/)[0] ?? null;
      } catch { /* sidecar missing — fine */ }
      return { sizeBytes: s.size, sha256 };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async putMeta(handle: BundleHandle, meta: BackupMetaV1): Promise<void> {
    const backend = this.resolveBackend(handle);
    const finalPath = join(backend.bundleDir, META_FILENAME);
    const tmpPath = `${finalPath}.tmp`;
    await writeFile(tmpPath, serializeMeta(meta));
    // Atomic on local filesystems — the bundle becomes "committed" the
    // instant rename returns.
    await rename(tmpPath, finalPath);
  }

  async getMeta(handle: BundleHandle): Promise<BackupMetaV1> {
    const backend = this.resolveBackend(handle);
    const buf = await readFile(join(backend.bundleDir, META_FILENAME));
    return parseMeta(buf);
  }

  async delete(handle: BundleHandle): Promise<void> {
    const backend = this.resolveBackend(handle);
    // Best-effort: drop meta.json first so concurrent readers can't see
    // a half-deleted bundle.
    try { await unlink(join(backend.bundleDir, META_FILENAME)); } catch { /* ignore */ }
    await rm(backend.bundleDir, { recursive: true, force: true });
  }
}
