/**
 * Abstract storage backend for tenant PVC snapshots.
 *
 * Dev uses a hostPath directory on the k3s node (LocalHostPathStore).
 * Production will swap in an S3/Azure-Blob implementation; callers
 * depend only on this interface so the rest of the storage-lifecycle
 * code is storage-backend-agnostic.
 *
 * `archivePath` is opaque to the caller — it's whatever the
 * implementation needs to find the object later (a filesystem path for
 * hostPath, an object key for S3, etc.). Callers pass it back to
 * `open()` / `delete()` unchanged.
 */
export interface SnapshotMetadata {
  readonly archivePath: string;
  readonly sizeBytes: number;
  readonly sha256: string | null;
}

export interface SnapshotStore {
  /**
   * Reserve a logical path for a new snapshot. The returned path gets
   * stored on `storage_snapshots.archive_path` immediately so that a
   * crash mid-upload leaves a traceable `status='creating'` row the
   * housekeeping cron can reap.
   *
   * Implementations must NOT create the object yet — the snapshot Job
   * writes to it. This call is a pure naming operation.
   */
  reservePath(clientId: string, snapshotId: string): string;

  /**
   * Absolute mount/path that a K8s Job should write its tarball to.
   * For hostPath this is the same as the storage root + archivePath;
   * for S3 it would be a presigned PUT URL or an in-pod tool wrapper.
   */
  mountTarget(archivePath: string): {
    readonly volumeSpec: Record<string, unknown>;
    readonly mountPath: string;
    readonly relativePath: string;
  };

  /**
   * Stat a completed snapshot. Returns null when the object is missing
   * (e.g. after a crash mid-upload). Used by the housekeeping cron to
   * reap orphan `storage_snapshots` rows.
   */
  stat(archivePath: string): Promise<{ sizeBytes: number } | null>;

  /**
   * Remove a snapshot. Idempotent — calling on a missing object is a
   * no-op, returns `false`. Returns `true` if the object existed and
   * was removed.
   */
  delete(archivePath: string): Promise<boolean>;
}

// ─── LocalHostPathStore (dev / single-node) ─────────────────────────────

/**
 * Snapshots as tarballs on a hostPath mounted into the k3s node at
 * `/var/lib/platform/snapshots`. File layout:
 *
 *     /var/lib/platform/snapshots/<client-id>/<snapshot-id>.tar.gz
 *
 * Two distinct paths at play:
 *   - `hostRoot` — path on the k3s node that backs the hostPath volume.
 *     Used in `mountTarget()` so snapshot/restore Jobs can mount the
 *     same directory in tenant namespaces.
 *   - `localRoot` — path inside the platform-api container where the
 *     host directory is also mounted (via the backend Deployment's
 *     volume spec). Used by `stat()` / `delete()` to read the archives
 *     the Jobs wrote.
 *
 * In dev both typically resolve through hostPath to the same directory
 * on the node, but the abstraction lets us drop in an S3 store where
 * `hostRoot` becomes a bucket URI and `localRoot` is irrelevant.
 *
 * Not suitable for multi-node production — future LonghornStore or
 * S3Store will share the same interface and swap in behind a factory.
 */
export class LocalHostPathStore implements SnapshotStore {
  constructor(private readonly hostRoot: string, private readonly localRoot: string = hostRoot) {}

  reservePath(clientId: string, snapshotId: string): string {
    // The filename is the single source of truth — no directory prefix
    // on the object side so that restores can find it with just the id.
    return `${clientId}/${snapshotId}.tar.gz`;
  }

  mountTarget(archivePath: string): {
    readonly volumeSpec: Record<string, unknown>;
    readonly mountPath: string;
    readonly relativePath: string;
  } {
    return {
      volumeSpec: {
        name: 'platform-snapshots',
        hostPath: { path: this.hostRoot, type: 'DirectoryOrCreate' },
      },
      mountPath: '/snapshots',
      relativePath: archivePath,
    };
  }

  async stat(archivePath: string): Promise<{ sizeBytes: number } | null> {
    const { stat, readdir } = await import('node:fs/promises');
    const { join, dirname } = await import('node:path');
    const fullPath = join(this.localRoot, archivePath);
    try {
      // hostPath mounts can have stale kernel dentry caches across
      // pods — the producer (snapshot Job) writes, but the consumer
      // (platform-api pod) may not see the new file until its dentry
      // cache is refreshed. An explicit readdir of the parent dir
      // forces the refresh, making stat see the just-written archive.
      try { await readdir(dirname(fullPath)); } catch { /* ignore */ }
      const s = await stat(fullPath);
      return { sizeBytes: s.size };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async delete(archivePath: string): Promise<boolean> {
    const { unlink } = await import('node:fs/promises');
    const { join } = await import('node:path');
    try {
      await unlink(join(this.localRoot, archivePath));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }
}

// ─── Factory ────────────────────────────────────────────────────────────

/**
 * Pick the concrete store based on platform config. Today only the
 * LocalHostPathStore is wired; the factory exists so prod S3/Azure
 * backends can drop in without touching call sites.
 */
export function getSnapshotStore(config: {
  readonly STORAGE_SNAPSHOT_BACKEND?: string;
  readonly STORAGE_SNAPSHOT_HOST_ROOT?: string;
  readonly STORAGE_SNAPSHOT_LOCAL_ROOT?: string;
}): SnapshotStore {
  const backend = config.STORAGE_SNAPSHOT_BACKEND ?? 'hostpath';
  if (backend === 'hostpath') {
    const hostRoot = config.STORAGE_SNAPSHOT_HOST_ROOT ?? '/var/lib/platform/snapshots';
    // Platform-api container mounts the same hostPath at /snapshots via
    // the backend Deployment. Tenant snapshot Jobs mount it at /snapshots
    // too. stat/delete operate on that in-container path.
    const localRoot = config.STORAGE_SNAPSHOT_LOCAL_ROOT ?? '/snapshots';
    return new LocalHostPathStore(hostRoot, localRoot);
  }
  throw new Error(`Unknown snapshot backend: ${backend}`);
}
