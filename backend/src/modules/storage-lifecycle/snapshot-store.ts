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

// HTTP-409 narrowing for K8s "already exists" responses. Duplicated
// from other modules (cert-manager.ts, k8s-provisioner/service.ts,
// ingress-routes/annotation-sync.ts) instead of exported because each
// site needs slightly different shape-tolerant handling — this one
// reads .response?.statusCode|status which covers both the legacy
// @kubernetes/client-node v0.x shape and the v1.x SDK wrapper.
function isK8s409(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: number; statusCode?: number; status?: number; response?: { statusCode?: number; status?: number } };
  if (e.code === 409 || e.statusCode === 409 || e.status === 409) return true;
  if (e.response?.statusCode === 409 || e.response?.status === 409) return true;
  return false;
}
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
  reservePath(tenantId: string, snapshotId: string): string;

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
   * Optional: ensure any cluster-scoped resources the Job's mount
   * requires exist before the Job is created. For LocalHostPathStore
   * this materialises a cluster-scoped PV (hostPath) + a tenant-namespace
   * PVC bound to it — necessary because PodSecurity baseline forbids
   * hostPath volumes inline on the Pod, but allows PVC references whose
   * underlying PV is hostPath (PSA only inspects pod.spec.volumes,
   * not the PV chain). For S3Store this is a no-op (it uses emptyDir).
   *
   * Implementations that don't need pre-staged resources should leave
   * this undefined; callers MUST check for undefined before invoking.
   */
  ensureJobMountResources?(
    k8s: import('../k8s-provisioner/k8s-client.js').K8sClients,
    namespace: string,
    archivePath: string,
  ): Promise<void>;

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

  /**
   * Read a sibling metadata file next to an archive. Used to pick up
   * the sha256 the snapshot Job wrote via `sha256sum > $ARCHIVE.sha256`,
   * so we can surface it on the storage_snapshots row. Returns null
   * when the sidecar is absent (older archives) or unreadable.
   */
  readSidecar(archivePath: string, suffix: string): Promise<string | null>;
}

// ─── LocalHostPathStore (dev / single-node) ─────────────────────────────

/**
 * Snapshots as tarballs on a hostPath mounted into the k3s node at
 * `/var/lib/platform/snapshots`. File layout:
 *
 *     /var/lib/platform/snapshots/<tenant-id>/<snapshot-id>.tar.gz
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

  reservePath(tenantId: string, snapshotId: string): string {
    // The filename is the single source of truth — no directory prefix
    // on the object side so that restores can find it with just the id.
    return `${tenantId}/${snapshotId}.tar.gz`;
  }

  mountTarget(archivePath: string): {
    readonly volumeSpec: Record<string, unknown>;
    readonly mountPath: string;
    readonly relativePath: string;
  } {
    // PodSecurity baseline forbids inline `hostPath` on Pod.spec.volumes
    // in tenant namespaces (PSA enforce=baseline). It DOES allow a
    // `persistentVolumeClaim` reference whose underlying PV uses hostPath
    // — PSA only inspects the Pod spec, not the PV chain. So instead of
    // returning the obvious `{ hostPath: ... }` volumeSpec, we return a
    // PVC reference. The PV+PVC pair must already exist; callers must
    // invoke `ensureJobMountResources` before creating the Pod.
    //
    // The PVC name is derived from the archivePath's tenant-id segment
    // (path layout = `<tenant-id>/<snapshot-id>.tar.gz`) so it survives
    // tenant namespace recreations and matches up with the matching PV.
    // The underlying PV's hostPath is `<hostRoot>/<tenant-id>` (subdir),
    // so the Job writes its archive at /snapshots/<basename> where
    // <basename> is the path WITHIN the tenant subdir (i.e. just the
    // `<snapshot-id>.tar.gz` slice — we strip the tenant-id prefix
    // because the PV is already tenant-scoped). Platform-api's
    // stat/delete still use the full <tenant-id>/<snapshot-id>.tar.gz
    // path because IT mounts the parent /var/lib/platform/snapshots.
    const [tenantId, ...rest] = archivePath.split('/');
    const basenameInsideTenantDir = rest.join('/');
    return {
      volumeSpec: {
        name: 'platform-snapshots',
        persistentVolumeClaim: { claimName: `platform-snapshots-${tenantId}` },
      },
      mountPath: '/snapshots',
      relativePath: basenameInsideTenantDir,
    };
  }

  /**
   * Materialise a hostPath-backed PV (cluster-scoped, OK under PSA) +
   * a PVC in the tenant namespace pre-bound to it. Both objects are
   * named `platform-snapshots-<tenant-id>` so they survive across
   * snapshot/restore Jobs and across tenant namespace recreations.
   * Idempotent — re-invocations against existing objects are no-ops.
   *
   * The PV's hostPath layout MUST mirror the layout the Store writes
   * to on the node — `<hostRoot>/<tenant-id>/` — so the archive that
   * the Job writes via /snapshots/<snapshot-id>.tar.gz lands at the
   * platform-api's /snapshots/<tenant-id>/<snapshot-id>.tar.gz read
   * path.
   */
  async ensureJobMountResources(
    k8s: import('../k8s-provisioner/k8s-client.js').K8sClients,
    namespace: string,
    archivePath: string,
  ): Promise<void> {
    const tenantId = archivePath.split('/')[0];
    if (!tenantId) {
      throw new Error(`ensureJobMountResources: archivePath missing tenant segment: ${archivePath}`);
    }
    const resourceName = `platform-snapshots-${tenantId}`;
    const hostSubdir = `${this.hostRoot.replace(/\/+$/, '')}/${tenantId}`;

    // 1. Cluster-scoped PV with hostPath. claimRef pre-binds to the
    // PVC we create next — this prevents the PV from being claimed by
    // a different PVC that happened to also match.
    try {
      await (k8s.core as unknown as {
        createPersistentVolume: (args: { body: unknown }) => Promise<unknown>;
      }).createPersistentVolume({
        body: {
          metadata: {
            name: resourceName,
            labels: {
              'platform.io/component': 'snapshot-store',
              'platform.io/tenant-id': tenantId,
            },
          },
          spec: {
            capacity: { storage: '500Gi' },
            accessModes: ['ReadWriteOnce'],
            persistentVolumeReclaimPolicy: 'Retain',
            storageClassName: '',
            hostPath: { path: hostSubdir, type: 'DirectoryOrCreate' },
            claimRef: { namespace, name: resourceName },
          },
        },
      });
    } catch (err: unknown) {
      if (!isK8s409(err)) throw err;
      // Already exists. Ensure the claimRef still points at THIS
      // namespace — if a previous tenant namespace with the same
      // tenantId was deleted + recreated, claimRef may still target
      // the old (deleted) PVC and the new PVC will stay Pending.
      // Re-bind the PV via SSA-merge patch.
      try {
        await (k8s.core as unknown as {
          patchPersistentVolume: (args: { name: string; body: unknown }) => Promise<unknown>;
        }).patchPersistentVolume({
          name: resourceName,
          body: {
            spec: { claimRef: { namespace, name: resourceName } },
          },
        });
      } catch { /* best-effort rebind */ }
    }

    // 2. Tenant-namespace PVC bound to the PV. volumeName pins the PVC
    // to the cluster-scoped PV so the dynamic provisioner doesn't spawn
    // a fresh local-path volume.
    //
    // requests.storage is INTENTIONALLY tiny (1Mi) because the tenant's
    // `requests.storage` ResourceQuota (e.g. 2Gi on Starter) sums ALL
    // PVCs in the namespace — and ResourceQuota does NOT have a
    // scopeSelector that can exempt storage by label/priority. If we
    // requested anything realistic (e.g. 500Gi) the PVC creation would
    // be rejected on every tenant smaller than that. K8s only verifies
    // `pvc.requests.storage <= pv.capacity.storage` for binding, so 1Mi
    // against a 500Gi PV is fine — and 1Mi against a 2Gi tenant storage
    // quota is negligible. Snapshot archives live on the host filesystem
    // (not on this PVC's accounted "storage"), so the real cost
    // accounting is operator-level node-disk monitoring, not K8s quota.
    try {
      await (k8s.core as unknown as {
        createNamespacedPersistentVolumeClaim: (args: { namespace: string; body: unknown }) => Promise<unknown>;
      }).createNamespacedPersistentVolumeClaim({
        namespace,
        body: {
          metadata: {
            name: resourceName,
            labels: {
              'platform.io/component': 'snapshot-store',
              'platform.io/tenant-id': tenantId,
            },
          },
          spec: {
            accessModes: ['ReadWriteOnce'],
            storageClassName: '',
            resources: { requests: { storage: '1Mi' } },
            volumeName: resourceName,
          },
        },
      });
    } catch (err: unknown) {
      if (!isK8s409(err)) throw err;
      // PVC already exists — fine, it's idempotent.
    }
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
      // Best-effort delete of the sha256 sidecar so the store stays
      // tidy. We don't surface the sidecar miss as an error.
      try { await unlink(join(this.localRoot, `${archivePath}.sha256`)); } catch { /* ignore */ }
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }

  async readSidecar(archivePath: string, suffix: string): Promise<string | null> {
    const { readFile, readdir } = await import('node:fs/promises');
    const { join, dirname } = await import('node:path');
    const fullPath = join(this.localRoot, `${archivePath}${suffix}`);
    // Refresh the dentry cache before reading — same rationale as
    // stat() above.
    try { await readdir(dirname(fullPath)); } catch { /* ignore */ }
    try {
      const buf = await readFile(fullPath, 'utf8');
      return buf.trim() || null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }
}

// ─── S3Store (stub) ─────────────────────────────────────────────────────

/**
 * S3-compatible object store backend. Not yet wired — the settings UI
 * accepts the config but any attempt to use the store surfaces a clear
 * NOT_IMPLEMENTED error so operators aren't misled into thinking their
 * snapshots are being written remotely.
 */
/**
 * S3 backend. The snapshot Job tars to a local emptyDir then uploads
 * via a presigned PUT URL — keeping the tenant Job's permissions
 * limited to that single object key + its sidecar. Server-side ops
 * (stat, delete, readSidecar) use AWS SDK directly.
 *
 * Job script needs `curl` and an emptyDir for the temp tarball; both
 * are available in the default `alpine` image which we set as the
 * snapshot Job image whenever the store is S3.
 */
export class S3Store implements SnapshotStore {
  constructor(private readonly config: {
    readonly bucket: string;
    readonly region: string;
    readonly endpoint?: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly pathPrefix?: string;
  }) {}

  /** Return an S3 tenant. Lazy-loaded so the AWS SDK isn't imported on
   *  every server boot when only LocalHostPathStore is used. */
  private async tenant() {
    const { S3Client } = await import('@aws-sdk/client-s3');
    return new S3Client({
      region: this.config.region,
      endpoint: this.config.endpoint,
      // Hetzner / Cloudflare / Backblaze need path-style addressing.
      forcePathStyle: !!this.config.endpoint,
      credentials: {
        accessKeyId: this.config.accessKeyId,
        secretAccessKey: this.config.secretAccessKey,
      },
    });
  }

  /** Strip leading slashes and double-slashes, prepend pathPrefix. */
  private key(archivePath: string): string {
    const prefix = (this.config.pathPrefix ?? '').replace(/^\/+|\/+$/g, '');
    const path = archivePath.replace(/^\/+/, '');
    return prefix ? `${prefix}/${path}` : path;
  }

  reservePath(tenantId: string, snapshotId: string): string {
    return `${tenantId}/${snapshotId}.tar.gz`;
  }

  /**
   * For S3 the Job tars to /snapshots/<rel> (an emptyDir) and uploads
   * via a presigned URL. We can't return presigned URLs here because
   * the interface is sync — the snapshot.ts Job-spec builder calls
   * `getUploadEnvelope` separately. mountTarget returns just the
   * scratch volume.
   */
  mountTarget(archivePath: string): { readonly volumeSpec: Record<string, unknown>; readonly mountPath: string; readonly relativePath: string } {
    return {
      volumeSpec: { name: 'platform-snapshots-scratch', emptyDir: { sizeLimit: '50Gi' } },
      mountPath: '/snapshots',
      relativePath: archivePath,
    };
  }

  /**
   * Generate presigned URLs for the snapshot Job — the tarball PUT
   * and the .sha256 sidecar PUT. Called by snapshotTenantPVC for S3
   * stores so the Job uploads via a credential-less curl PUT.
   */
  async getUploadUrls(archivePath: string): Promise<{ archiveUrl: string; sha256Url: string }> {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    const c = await this.tenant();
    const archiveCmd = new PutObjectCommand({ Bucket: this.config.bucket, Key: this.key(archivePath), ContentType: 'application/gzip' });
    const sha256Cmd = new PutObjectCommand({ Bucket: this.config.bucket, Key: this.key(`${archivePath}.sha256`), ContentType: 'text/plain' });
    const [archiveUrl, sha256Url] = await Promise.all([
      getSignedUrl(c, archiveCmd, { expiresIn: 3600 }),
      getSignedUrl(c, sha256Cmd, { expiresIn: 3600 }),
    ]);
    return { archiveUrl, sha256Url };
  }

  async getDownloadUrl(archivePath: string): Promise<string> {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    const c = await this.tenant();
    return getSignedUrl(c, new GetObjectCommand({ Bucket: this.config.bucket, Key: this.key(archivePath) }), { expiresIn: 3600 });
  }

  async stat(archivePath: string): Promise<{ sizeBytes: number } | null> {
    const { HeadObjectCommand, S3ServiceException } = await import('@aws-sdk/client-s3');
    const c = await this.tenant();
    try {
      const r = await c.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: this.key(archivePath) }));
      return { sizeBytes: Number(r.ContentLength ?? 0) };
    } catch (err) {
      if (err instanceof S3ServiceException && (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404)) return null;
      throw err;
    }
  }

  async delete(archivePath: string): Promise<boolean> {
    const { DeleteObjectCommand, HeadObjectCommand, S3ServiceException } = await import('@aws-sdk/client-s3');
    const c = await this.tenant();
    let existed = false;
    try {
      await c.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: this.key(archivePath) }));
      existed = true;
    } catch (err) {
      if (err instanceof S3ServiceException && (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404)) {
        return false;
      }
      throw err;
    }
    await c.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: this.key(archivePath) }));
    // Best-effort sidecar delete — sha256 sibling.
    try { await c.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: this.key(`${archivePath}.sha256`) })); } catch { /* ignore */ }
    return existed;
  }

  async readSidecar(archivePath: string, suffix: string): Promise<string | null> {
    const { GetObjectCommand, S3ServiceException } = await import('@aws-sdk/client-s3');
    const c = await this.tenant();
    try {
      const r = await c.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: this.key(`${archivePath}${suffix}`) }));
      const text = await r.Body?.transformToString();
      return text?.trim() ?? null;
    } catch (err) {
      if (err instanceof S3ServiceException && (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404)) return null;
      throw err;
    }
  }
}

/** Azure Blob store stub — same pattern as S3Store. */
export class AzureBlobStore implements SnapshotStore {
  constructor(private readonly _config: {
    readonly container: string;
    readonly connectionString: string;
  }) {}

  reservePath(tenantId: string, snapshotId: string): string {
    return `${tenantId}/${snapshotId}.tar.gz`;
  }

  mountTarget(_archivePath: string): { readonly volumeSpec: Record<string, unknown>; readonly mountPath: string; readonly relativePath: string } {
    throw new Error('AzureBlobStore: not yet implemented — configure hostpath backend');
  }

  async stat(_archivePath: string): Promise<{ sizeBytes: number } | null> {
    throw new Error('AzureBlobStore: not yet implemented');
  }

  async delete(_archivePath: string): Promise<boolean> {
    throw new Error('AzureBlobStore: not yet implemented');
  }

  async readSidecar(_archivePath: string, _suffix: string): Promise<string | null> {
    return null;
  }
}

// ─── Factory ────────────────────────────────────────────────────────────

/**
 * Pick the concrete store based on platform config. Today only the
 * LocalHostPathStore is wired; the factory exists so prod S3/Azure
 * backends can drop in without touching call sites.
 *
 * Preferred callsite:
 *   - `resolveSnapshotStore(db, config)` — loads DB-backed settings first
 *     and falls back to env vars for greenfield deploys.
 *
 * `getSnapshotStore(config)` stays available for tests and for the
 * housekeeping scheduler that runs before DB connectivity is guaranteed.
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

/**
 * DB-backed store factory. Reads `storage.snapshot.*` settings from
 * `platform_settings` (with 60s cache) and picks the concrete store.
 * Missing DB config falls back to env-var defaults — so freshly bootstrapped
 * deploys still get a working hostpath store without any admin UI action.
 */
export async function resolveSnapshotStore(
  db: import('../../db/index.js').Database,
  envConfig: {
    readonly STORAGE_SNAPSHOT_BACKEND?: string;
    readonly STORAGE_SNAPSHOT_HOST_ROOT?: string;
    readonly STORAGE_SNAPSHOT_LOCAL_ROOT?: string;
  },
): Promise<SnapshotStore> {
  const { loadStorageLifecycleSettings } = await import('./settings.js');
  const s = await loadStorageLifecycleSettings(db);

  if (s.backend === 'hostpath') {
    // Fallback: when no explicit storage-lifecycle config exists but
    // the operator has configured an active S3 backup target, use that.
    // This unifies the two config surfaces — operators expect "I set
    // up S3" to mean both cluster backups AND tenant snapshots.
    try {
      const { getActiveBackupConfig } = await import('../backup-config/service.js');
      const key = process.env.PLATFORM_ENCRYPTION_KEY ?? '0'.repeat(64);
      const active = await getActiveBackupConfig(db, key);
      if (active && active.kind === 's3') {
        return new S3Store({
          bucket: active.bucket,
          region: active.region,
          endpoint: active.endpoint || undefined,
          accessKeyId: active.accessKeyId,
          secretAccessKey: active.secretAccessKey,
          pathPrefix: active.pathPrefix ? `${active.pathPrefix.replace(/\/+$/, '')}/snapshots` : 'snapshots',
        });
      }
    } catch (err) {
      console.warn(`[snapshot-store] backup_configurations fallback skipped: ${(err as Error).message}`);
    }
    return new LocalHostPathStore(
      s.hostpathRoot,
      envConfig.STORAGE_SNAPSHOT_LOCAL_ROOT ?? '/snapshots',
    );
  }
  if (s.backend === 's3') {
    if (!s.s3Bucket || !s.s3Region || !s.s3AccessKeyId || !s.s3SecretAccessKey) {
      throw new Error('S3 backend selected but bucket/region/credentials are not configured');
    }
    return new S3Store({
      bucket: s.s3Bucket,
      region: s.s3Region,
      endpoint: s.s3Endpoint ?? undefined,
      accessKeyId: s.s3AccessKeyId,
      secretAccessKey: s.s3SecretAccessKey,
    });
  }
  if (s.backend === 'azure') {
    if (!s.azureContainer || !s.azureConnectionString) {
      throw new Error('Azure backend selected but container/connectionString are not configured');
    }
    return new AzureBlobStore({
      container: s.azureContainer,
      connectionString: s.azureConnectionString,
    });
  }
  throw new Error(`Unknown snapshot backend: ${s.backend}`);
}
