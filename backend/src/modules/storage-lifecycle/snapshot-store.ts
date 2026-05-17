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
 *
 * Phase 3 of the snapshot-storage overhaul: when `opts.snapshotClass` is
 * passed, the factory consults `backup_target_assignments` to pick the
 * per-class primary target instead of the legacy "single active config"
 * fallback. The per-class path also returns the resolved `targetId` so
 * the snapshot row can record it for forensics.
 *
 * Backwards compatibility: existing callers that don't pass
 * `snapshotClass` continue to use the legacy fallback chain (settings →
 * active backup config → hostpath default). This lets us migrate
 * subsystems one at a time without breaking anything mid-flight.
 */
export interface ResolveSnapshotStoreOptions {
  /**
   * When set, the resolver uses the per-class assignment table and
   * throws ApiError('NO_SNAPSHOT_TARGET') if the class is unassigned.
   * When omitted, the legacy single-active-target fallback applies.
   */
  readonly snapshotClass?: import('@k8s-hosting/api-contracts').SnapshotClass;
}

export interface ResolvedSnapshotStoreBundle {
  /** Concrete store ready for use by the snapshot/restore orchestrators. */
  readonly store: SnapshotStore;
  /** Set when resolved via per-class assignment; null on legacy fallback paths. */
  readonly targetId: string | null;
}

export async function resolveSnapshotStore(
  db: import('../../db/index.js').Database,
  envConfig: {
    readonly STORAGE_SNAPSHOT_BACKEND?: string;
    readonly STORAGE_SNAPSHOT_HOST_ROOT?: string;
    readonly STORAGE_SNAPSHOT_LOCAL_ROOT?: string;
  },
  opts: ResolveSnapshotStoreOptions = {},
): Promise<SnapshotStore> {
  // Phase 3: per-class path takes precedence when class is provided.
  if (opts.snapshotClass) {
    const bundle = await resolveSnapshotStoreForClass(db, envConfig, opts.snapshotClass);
    return bundle.store;
  }

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

/**
 * Phase 3 per-class store factory. Wraps the strict-primary target
 * resolver + the existing per-storage-type credential plumbing.
 *
 * Returns both the store and the resolved targetId so snapshot row
 * inserts can stamp `storage_snapshots.target_id` for forensics.
 *
 * PLATFORM_ENCRYPTION_KEY is required — a zero-key fallback would
 * silently decrypt real ciphertext as garbage. Throws if missing.
 */
export async function resolveSnapshotStoreForClass(
  db: import('../../db/index.js').Database,
  envConfig: {
    readonly STORAGE_SNAPSHOT_HOST_ROOT?: string;
    readonly STORAGE_SNAPSHOT_LOCAL_ROOT?: string;
  },
  snapshotClass: import('@k8s-hosting/api-contracts').SnapshotClass,
): Promise<ResolvedSnapshotStoreBundle> {
  const { resolveTargetFor } = await import('./target-resolver.js');
  const { getRawBackupConfig } = await import('../backup-config/service.js');
  const { decrypt } = await import('../oidc/crypto.js');
  const { ApiError } = await import('../../shared/errors.js');

  const resolved = await resolveTargetFor(db, snapshotClass);
  const key = process.env.PLATFORM_ENCRYPTION_KEY;
  if (!key) {
    throw new ApiError(
      'CONFIGURATION_ERROR',
      'PLATFORM_ENCRYPTION_KEY is not set — cannot decrypt target credentials',
      500,
    );
  }
  const cfg = await getRawBackupConfig(db, resolved.targetId);

  // Phase 4: prefer streaming stores (rclone-based, no local file)
  // for every supported backend. Falls back to non-streaming reads via
  // a paired S3Store sibling for stat/delete/sidecar — Phase 5 will
  // unify the read path under rclone too.
  const { S3StreamingStore, SshStreamingStore, CifsStreamingStore } = await import('./streaming-store.js');

  if (cfg.storageType === 's3') {
    if (!cfg.s3Bucket || !cfg.s3Region || !cfg.s3AccessKeyEncrypted || !cfg.s3SecretKeyEncrypted) {
      // Operator-fixable misconfiguration → 400, not 500. The target
      // was saved without the required fields (or had them cleared);
      // the operator completes them in the admin UI to recover.
      throw new ApiError(
        'TARGET_INCOMPLETE',
        `S3 target ${cfg.name} is missing bucket/region/credentials`,
        400,
      );
    }
    let accessKey: string;
    let secretKey: string;
    try {
      accessKey = decrypt(cfg.s3AccessKeyEncrypted, key);
      secretKey = decrypt(cfg.s3SecretKeyEncrypted, key);
    } catch (err) {
      throw new ApiError(
        'TARGET_CREDENTIAL_DECRYPT_FAILED',
        `Credential decrypt failed for target ${cfg.name} (key rotated?): ${(err as Error).message}`,
        500,
      );
    }
    const pathPrefix = cfg.s3Prefix
      ? `${cfg.s3Prefix.replace(/\/+$/, '')}/snapshots/${snapshotClass}`
      : `snapshots/${snapshotClass}`;
    // The S3StreamingStore drives the upload Job; the legacy S3Store
    // drives stat/delete/sidecar reads. Both point at the same bucket
    // + prefix, so a snapshot uploaded via the streaming Job is
    // visible via the SDK-backed reads. The composite implements
    // both `SnapshotStore` and `StreamingSnapshotStore` by delegating.
    const sdkStore = new S3Store({
      bucket: cfg.s3Bucket,
      region: cfg.s3Region,
      endpoint: cfg.s3Endpoint ?? undefined,
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
      pathPrefix,
    });
    const streamStore = new S3StreamingStore({
      bucket: cfg.s3Bucket,
      region: cfg.s3Region,
      endpoint: cfg.s3Endpoint ?? undefined,
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
      pathPrefix,
    });
    return {
      store: composeStreamingStore(sdkStore, streamStore),
      targetId: resolved.targetId,
    };
  }

  if (cfg.storageType === 'ssh') {
    // Phase 4 of the snapshot-storage overhaul: SSH/SFTP targets are
    // gated at the resolver until Phase 5 lands the full streaming
    // read+write story (restore, stat, delete, sidecar). The
    // SshStreamingStore code path exists but its read methods throw
    // "not yet implemented" — surfacing them today would break the
    // post-snapshot stat() + future restore path.
    //
    // Code-review HIGH (TOFU host-key checking disabled) is also
    // mitigated by this gate — no SSH target ever gets used until
    // Phase 5 wires `RCLONE_CONFIG_REMOTE_KNOWN_HOSTS_FILE` via a
    // `knownHostsSecret` operator-provided file.
    //
    // Reference the unused import so TypeScript noUnusedLocals stays
    // happy until Phase 5 wires SshStreamingStore for real.
    void SshStreamingStore;
    throw new ApiError(
      'TARGET_KIND_UNSUPPORTED',
      `SSH targets are not yet supported for snapshot class '${snapshotClass}'. ` +
      `Use an S3-compatible target (minio, AWS S3, Hetzner Object Storage). ` +
      `SSH streaming + read paths land in Phase 5.`,
      400,
    );
  }

  // Phase 9: CIFS/SMB streaming target. rclone smb backend; password
  // re-obscured server-side here so RCLONE_CONFIG_REMOTE_PASS gets the
  // wire format rclone expects (NOT plaintext). The CifsStreamingStore
  // upload path runs in the same Job-spec branch as S3.
  if (cfg.storageType === 'cifs') {
    if (!cfg.cifsHost || !cfg.cifsShare || !cfg.cifsUser || !cfg.cifsPasswordEncrypted) {
      throw new ApiError(
        'TARGET_INCOMPLETE',
        `CIFS target ${cfg.name} is missing host/share/user/password`,
        400,
      );
    }
    let plainPassword: string;
    try {
      plainPassword = decrypt(cfg.cifsPasswordEncrypted, key);
    } catch (err) {
      throw new ApiError(
        'TARGET_CREDENTIAL_DECRYPT_FAILED',
        `CIFS password decrypt failed for target ${cfg.name} (key rotated?): ${(err as Error).message}`,
        500,
      );
    }
    const { rcloneObscure } = await import('./rclone-obscure.js');
    const obscuredPassword = rcloneObscure(plainPassword);
    const basePath = cfg.cifsPath
      ? `${cfg.cifsPath.replace(/\/+$/, '')}/snapshots/${snapshotClass}`
      : `snapshots/${snapshotClass}`;
    const cifsStream = new CifsStreamingStore({
      host: cfg.cifsHost,
      port: cfg.cifsPort ?? 445,
      share: cfg.cifsShare,
      user: cfg.cifsUser,
      password: obscuredPassword,
      domain: cfg.cifsDomain ?? undefined,
      basePath,
    });
    return {
      store: cifsStream,
      targetId: resolved.targetId,
    };
  }

  throw new ApiError(
    'TARGET_KIND_UNKNOWN',
    `Target ${cfg.name} has unsupported storage type: ${cfg.storageType}. ` +
    `Supported types: s3, cifs.`,
    400,
  );
}

/**
 * Compose an SDK-backed read store with a streaming-upload store so
 * one object satisfies both `SnapshotStore` (used by stat/delete/
 * sidecar reads) and `StreamingSnapshotStore` (used by the snapshot
 * Job spec builder). The composite has no behaviour of its own — it
 * delegates each method to the appropriate sibling.
 */
/**
 * Phase 5 of the snapshot-storage overhaul: restore lookup by stamped
 * target_id. Used by restore.ts to resolve the SAME target the
 * original snapshot was uploaded to, regardless of how class
 * assignments have since changed.
 *
 * Returns a streaming-capable store when the target is S3 — restore
 * runs `rclone cat $REMOTE | gunzip | tar x -C /target` with no local
 * file. Returns `null` if the target row was deleted (storage_snapshots.
 * target_id ON DELETE SET NULL); the caller should fall back to the
 * legacy resolveSnapshotStore for pre-Phase-3 rows.
 *
 * snapshotClass is needed to reconstruct the path prefix
 * (`snapshots/{snapshotClass}/`) since the row's archive_path is just
 * `<tenantId>/<snapshotId>.tar.gz` — the prefix lives in the store
 * configuration, not the path itself.
 */
export async function resolveSnapshotStoreByTargetId(
  db: import('../../db/index.js').Database,
  targetId: string,
  snapshotClass: import('@k8s-hosting/api-contracts').SnapshotClass,
): Promise<SnapshotStore | null> {
  const { getRawBackupConfig } = await import('../backup-config/service.js');
  const { decrypt } = await import('../oidc/crypto.js');
  const { ApiError } = await import('../../shared/errors.js');
  const { S3StreamingStore } = await import('./streaming-store.js');

  const key = process.env.PLATFORM_ENCRYPTION_KEY;
  if (!key) {
    throw new ApiError(
      'CONFIGURATION_ERROR',
      'PLATFORM_ENCRYPTION_KEY is not set — cannot decrypt target credentials',
      500,
    );
  }

  let cfg;
  try {
    cfg = await getRawBackupConfig(db, targetId);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      // The target row was deleted (storage_snapshots.target_id is
      // ON DELETE SET NULL, but the snapshot may have a stale reference
      // captured before the cascade). Surface clearly so restore returns
      // a TARGET_REMOVED error rather than a bare 404.
      return null;
    }
    throw err;
  }

  if (cfg.storageType === 's3') {
    if (!cfg.s3Bucket || !cfg.s3Region || !cfg.s3AccessKeyEncrypted || !cfg.s3SecretKeyEncrypted) {
      throw new ApiError(
        'TARGET_INCOMPLETE',
        `S3 target ${cfg.name} is missing bucket/region/credentials`,
        400,
      );
    }
    const accessKey = decrypt(cfg.s3AccessKeyEncrypted, key);
    const secretKey = decrypt(cfg.s3SecretKeyEncrypted, key);
    const pathPrefix = cfg.s3Prefix
      ? `${cfg.s3Prefix.replace(/\/+$/, '')}/snapshots/${snapshotClass}`
      : `snapshots/${snapshotClass}`;
    const sdkStore = new S3Store({
      bucket: cfg.s3Bucket,
      region: cfg.s3Region,
      endpoint: cfg.s3Endpoint ?? undefined,
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
      pathPrefix,
    });
    const streamStore = new S3StreamingStore({
      bucket: cfg.s3Bucket,
      region: cfg.s3Region,
      endpoint: cfg.s3Endpoint ?? undefined,
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
      pathPrefix,
    });
    return composeStreamingStore(sdkStore, streamStore);
  }

  // SSH/CIFS restore via stamped target_id is gated until Phase 5/6
  // unblocks them in resolveSnapshotStoreForClass.
  throw new ApiError(
    'TARGET_KIND_UNSUPPORTED',
    `Restore from ${cfg.storageType} target is not yet supported`,
    400,
  );
}

function composeStreamingStore(
  sdkStore: SnapshotStore,
  streamStore: import('./streaming-store.js').StreamingSnapshotStore,
): SnapshotStore & import('./streaming-store.js').StreamingSnapshotStore {
  return {
    reservePath: (tenantId, snapshotId) => streamStore.reservePath(tenantId, snapshotId),
    mountTarget: (archivePath) => streamStore.mountTarget(archivePath),
    stat: (archivePath) => sdkStore.stat(archivePath),
    delete: (archivePath) => sdkStore.delete(archivePath),
    readSidecar: (archivePath, suffix) => sdkStore.readSidecar(archivePath, suffix),
    getStreamingJob: (archivePath) => streamStore.getStreamingJob(archivePath),
    getStreamingRestoreJob: (archivePath) => streamStore.getStreamingRestoreJob(archivePath),
  };
}
