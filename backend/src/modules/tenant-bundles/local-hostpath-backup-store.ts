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
import type {
  BackupStore,
  BundleHandle,
  ArtifactRef,
  ArtifactStat,
  WriteComponentOptions,
} from './bundle-store.js';
import { META_FILENAME, componentDir, parseMeta, serializeMeta } from './meta.js';

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

  private readonly normalizedRoot: string;

  /**
   * Test-only store. Production paths use S3 / SSH; backups never
   * sit on cluster disk (see ADR-032 amendment 2026-05-02). Unit
   * tests pass an `mkdtemp(...)` path so the same code exercises
   * the BackupStore contract without needing a real bucket or
   * remote host.
   */
  constructor(private readonly root: string) {
    this.normalizedRoot = resolve(root);
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
