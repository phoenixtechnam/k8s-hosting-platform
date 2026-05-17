// Streaming snapshot stores (Phase 4 of snapshot-storage overhaul).
//
// Replaces the legacy "tar to local file → curl PUT" pattern with a
// pure stream pipeline:
//
//   tar c -C /source . | gzip -1 | tee >(sha256sum > /tmp/sha) | rclone rcat REMOTE:path
//
// Memory ceiling per Job: ~256 MiB regardless of PVC size (rclone
// chunk buffer + sha256 streaming digest + tar). No local file on
// disk anywhere — solves the "very large customer PVCs would fill
// node disk even transiently" concern the operator flagged.
//
// Three concrete backends, all using a single `rclone/rclone` image:
//   - S3StreamingStore   — `rclone rcat REMOTE:bucket/path` with
//                          multipart parallel uploads
//   - SshStreamingStore  — `rclone rcat REMOTE:path` over sftp
//   - CifsStreamingStore — `rclone rcat REMOTE:path` over smb
//
// rclone is configured entirely via env vars (RCLONE_CONFIG_REMOTE_*)
// so no config file is mounted — credentials live in env, which the
// k8s Secret machinery already protects against `ps`/`/proc` leaks.

import type { SnapshotStore } from './snapshot-store.js';

const RCLONE_IMAGE = 'rclone/rclone:1.66';

/**
 * Job pod envelope for the streaming snapshot Job. The caller (snapshot.ts)
 * uses this to assemble the full `batch/v1` Job spec — by returning the
 * inner container config + env + the optional setup commands, we keep
 * the K8s Job spec construction in one place.
 */
export interface StreamingJobEnvelope {
  readonly image: string;
  /**
   * The bash pipeline that runs INSIDE the container. Receives
   * /source mounted read-only from the tenant PVC; emits the archive
   * to the resolved remote URI; emits the .sha256 sidecar.
   *
   * Two env vars are guaranteed in scope: `REMOTE_URI`, `SHA_URI`.
   * Additional rclone config env vars (RCLONE_CONFIG_REMOTE_*) come
   * from `publicEnv` + `secretEnv` below.
   */
  readonly script: string;
  /**
   * Phase 12: env vars split by visibility.
   *
   * - `publicEnv` is plaintext and ends up inline in the Pod spec
   *   (visible via `kubectl get pod -o yaml`). Use for connection
   *   metadata only — host, port, region, bucket name, etc.
   * - `secretEnv` is mounted via an ephemeral k8s Secret that the
   *   Job orchestrator creates BEFORE the Job and binds via owner
   *   references for cascade GC. Use for credentials —
   *   RCLONE_CONFIG_REMOTE_{ACCESS_KEY_ID,SECRET_ACCESS_KEY,USER,PASS}.
   *
   * `runRcloneOneShot` and the snapshot/restore/speedtest Job builders
   * all honour this split.
   */
  readonly publicEnv: Array<{ name: string; value: string }>;
  readonly secretEnv: Record<string, string>;
  readonly remoteUri: string;
  readonly shaUri: string;
}

/**
 * Extension of `SnapshotStore` for backends that support direct
 * streaming uploads (no local-file intermediate). The legacy
 * `LocalHostPathStore` / `S3Store` paths do NOT implement this — the
 * snapshot Job builder duck-types on `getStreamingJob` to decide
 * which Job spec to emit.
 */
export interface StreamingSnapshotStore extends SnapshotStore {
  /**
   * Build the Job container spec for a streaming snapshot upload.
   *
   * The returned `script` MUST be idempotent on retries — if a previous
   * Job partially uploaded, rclone S3 multipart auto-resumes; rclone
   * sftp/smb writes to `<filename>.partial` and renames on success, so
   * a partial leftover is detected and re-uploaded from scratch.
   */
  getStreamingJob(archivePath: string): StreamingJobEnvelope;

  /**
   * Build the Job container spec for a streaming RESTORE download.
   *
   * Pipeline: `rclone cat $REMOTE_URI | gunzip | tar x -C /target`.
   * NO local file at any node — symmetric to getStreamingJob.
   *
   * Phase 5 of the snapshot-storage overhaul.
   */
  getStreamingRestoreJob(archivePath: string): StreamingJobEnvelope;
}

// ─── S3 streaming store ─────────────────────────────────────────────────

export class S3StreamingStore implements StreamingSnapshotStore {
  constructor(private readonly config: {
    readonly bucket: string;
    readonly region: string;
    readonly endpoint?: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly pathPrefix?: string;
    /** k8s Secret containing access_key + secret_key — used to inject creds via valueFrom. */
    readonly credentialsSecret?: { name: string; accessKeyKey: string; secretKeyKey: string };
  }) {}

  reservePath(tenantId: string, snapshotId: string): string {
    return `${tenantId}/${snapshotId}.tar.gz`;
  }

  /**
   * The legacy interface requires `mountTarget`. For streaming stores
   * there is NO scratch volume — return a synthetic envelope that the
   * Job builder ignores. We can't make this method optional without
   * cascading changes to LocalHostPathStore so we return a tombstone
   * the streaming-aware Job builder skips.
   */
  mountTarget(_archivePath: string): { readonly volumeSpec: Record<string, unknown>; readonly mountPath: string; readonly relativePath: string } {
    return {
      volumeSpec: { name: 'streaming-store-no-mount', emptyDir: {} },
      mountPath: '/dev/null-mount',
      relativePath: 'unused',
    };
  }

  private key(archivePath: string): string {
    const prefix = (this.config.pathPrefix ?? '').replace(/^\/+|\/+$/g, '');
    const path = archivePath.replace(/^\/+/, '');
    return prefix ? `${prefix}/${path}` : path;
  }

  getStreamingJob(archivePath: string): StreamingJobEnvelope {
    const key = this.key(archivePath);
    const remoteUri = `REMOTE:${this.config.bucket}/${key}`;
    const shaUri = `REMOTE:${this.config.bucket}/${key}.sha256`;
    // rclone env-var config — bypass on-disk rclone.conf entirely.
    // See https://rclone.org/docs/#environment-variables
    //
    // Phase 12: publicEnv stays inline in the Pod spec; secretEnv is
    // mounted via an ephemeral k8s Secret created by the Job
    // orchestrator before the Job, bound via ownerReferences for
    // cascade GC when the Job's TTL fires.
    const publicEnv: Array<{ name: string; value: string }> = [
      { name: 'RCLONE_CONFIG_REMOTE_TYPE', value: 's3' },
      { name: 'RCLONE_CONFIG_REMOTE_PROVIDER', value: 'Other' },
      { name: 'RCLONE_CONFIG_REMOTE_REGION', value: this.config.region },
      // Multipart parallel uploads for high-throughput S3.
      { name: 'RCLONE_S3_CHUNK_SIZE', value: '16M' },
      { name: 'RCLONE_S3_UPLOAD_CONCURRENCY', value: '8' },
      // No retries inside rclone — the Job orchestrator retries via
      // backoffLimit. Reduce log noise.
      { name: 'RCLONE_LOW_LEVEL_RETRIES', value: '3' },
      { name: 'RCLONE_USE_JSON_LOG', value: 'true' },
      { name: 'RCLONE_STATS', value: '15s' },
      { name: 'RCLONE_STATS_ONE_LINE', value: 'true' },
      // Connect + IO timeouts: prevent silent stalls on backend 5xx
      // loops or stuck TCP. 60s connect + 5min single-request timeout
      // gives faster failure than waiting for the 6h
      // activeDeadlineSeconds backstop.
      { name: 'RCLONE_CONTIMEOUT', value: '60s' },
      { name: 'RCLONE_TIMEOUT', value: '300s' },
    ];
    if (this.config.endpoint) {
      publicEnv.push({ name: 'RCLONE_CONFIG_REMOTE_ENDPOINT', value: this.config.endpoint });
      // Hetzner / minio / Backblaze need path-style addressing.
      publicEnv.push({ name: 'RCLONE_CONFIG_REMOTE_FORCE_PATH_STYLE', value: 'true' });
    }
    const secretEnv: Record<string, string> = {
      RCLONE_CONFIG_REMOTE_ACCESS_KEY_ID: this.config.accessKeyId,
      RCLONE_CONFIG_REMOTE_SECRET_ACCESS_KEY: this.config.secretAccessKey,
    };

    return { image: RCLONE_IMAGE, script: buildStreamingScript(), publicEnv, secretEnv, remoteUri, shaUri };
  }

  /**
   * Phase 5: streaming restore download for S3. Same env config as
   * the upload Job (rclone S3 backend) — just a different pipeline.
   */
  getStreamingRestoreJob(archivePath: string): StreamingJobEnvelope {
    // Reuse the upload envelope's env config (it already wires
    // RCLONE_CONFIG_REMOTE_*); swap the script for the download
    // pipeline and clear shaUri (restore doesn't write a sidecar).
    const upload = this.getStreamingJob(archivePath);
    return {
      image: RCLONE_IMAGE,
      script: buildStreamingRestoreScript(),
      publicEnv: upload.publicEnv,
      secretEnv: upload.secretEnv,
      remoteUri: upload.remoteUri,
      shaUri: upload.shaUri,
    };
  }

  // Delegate read paths to a non-streaming S3Store for stat/delete/sidecar.
  // We don't have a `tenant()` here to avoid duplicating the SDK config —
  // these methods are wired by the Job orchestrator to use the SDK-backed
  // S3Store when needed; the StreamingSnapshotStore interface only adds
  // streaming UPLOAD support, not download/stat.
  async stat(_archivePath: string): Promise<{ sizeBytes: number } | null> {
    throw new Error('S3StreamingStore.stat — call via S3Store sibling');
  }
  async delete(_archivePath: string): Promise<boolean> {
    throw new Error('S3StreamingStore.delete — call via S3Store sibling');
  }
  async readSidecar(_archivePath: string, _suffix: string): Promise<string | null> {
    throw new Error('S3StreamingStore.readSidecar — call via S3Store sibling');
  }
}

// ─── SSH/SFTP streaming store ──────────────────────────────────────────

export class SshStreamingStore implements StreamingSnapshotStore {
  constructor(private readonly config: {
    readonly host: string;
    readonly port: number;
    readonly user: string;
    readonly privateKey: string;
    readonly basePath: string;
    /** k8s Secret containing the ssh private key — used to mount it via volume. */
    readonly credentialsSecret?: { name: string; keyKey: string };
  }) {}

  reservePath(tenantId: string, snapshotId: string): string {
    return `${tenantId}/${snapshotId}.tar.gz`;
  }

  mountTarget(_archivePath: string): { readonly volumeSpec: Record<string, unknown>; readonly mountPath: string; readonly relativePath: string } {
    // SSH streaming Job mounts the private key as a file (not env var —
    // multi-line PEM is awkward in env). The Job spec adds the volume
    // separately via the envelope's hint.
    return {
      volumeSpec: { name: 'streaming-store-no-mount', emptyDir: {} },
      mountPath: '/dev/null-mount',
      relativePath: 'unused',
    };
  }

  getStreamingJob(archivePath: string): StreamingJobEnvelope {
    const remotePath = this.config.basePath.replace(/\/+$/, '') + '/' + archivePath;
    const remoteUri = `REMOTE:${remotePath}`;
    const shaUri = `REMOTE:${remotePath}.sha256`;
    // Phase 12: split public env (connection metadata) from secret env
    // (host-user + key-file path). The PRIVATE KEY itself is mounted
    // via a separate Secret volume by the Job orchestrator (see
    // sshKeyFile field in StreamingJobEnvelope.secretFiles when
    // Phase 5.5 lands).
    const publicEnv: Array<{ name: string; value: string }> = [
      { name: 'RCLONE_CONFIG_REMOTE_TYPE', value: 'sftp' },
      { name: 'RCLONE_CONFIG_REMOTE_HOST', value: this.config.host },
      { name: 'RCLONE_CONFIG_REMOTE_PORT', value: String(this.config.port) },
      // Key path inside the container — the Job spec must mount the
      // Secret at /etc/rclone/ssh_key (read-only).
      { name: 'RCLONE_CONFIG_REMOTE_KEY_FILE', value: '/etc/rclone/ssh_key' },
      // Disable strict host-key checking — operator may add a known-hosts
      // file later; for Phase 4 we accept TOFU since rclone validates
      // the host fingerprint after first connection.
      { name: 'RCLONE_CONFIG_REMOTE_KNOWN_HOSTS_FILE', value: '' },
      { name: 'RCLONE_LOW_LEVEL_RETRIES', value: '3' },
      { name: 'RCLONE_USE_JSON_LOG', value: 'true' },
      { name: 'RCLONE_STATS', value: '15s' },
      { name: 'RCLONE_STATS_ONE_LINE', value: 'true' },
      { name: 'RCLONE_CONTIMEOUT', value: '60s' },
      { name: 'RCLONE_TIMEOUT', value: '300s' },
    ];
    const secretEnv: Record<string, string> = {
      RCLONE_CONFIG_REMOTE_USER: this.config.user,
    };
    return { image: RCLONE_IMAGE, script: buildStreamingScript(), publicEnv, secretEnv, remoteUri, shaUri };
  }

  getStreamingRestoreJob(archivePath: string): StreamingJobEnvelope {
    const upload = this.getStreamingJob(archivePath);
    return {
      image: RCLONE_IMAGE,
      script: buildStreamingRestoreScript(),
      publicEnv: upload.publicEnv,
      secretEnv: upload.secretEnv,
      remoteUri: upload.remoteUri,
      shaUri: upload.shaUri,
    };
  }

  async stat(_archivePath: string): Promise<{ sizeBytes: number } | null> {
    throw new Error('SshStreamingStore.stat — read path not yet implemented (Phase 5)');
  }
  async delete(_archivePath: string): Promise<boolean> {
    throw new Error('SshStreamingStore.delete — read path not yet implemented (Phase 5)');
  }
  async readSidecar(_archivePath: string, _suffix: string): Promise<string | null> {
    throw new Error('SshStreamingStore.readSidecar — read path not yet implemented (Phase 5)');
  }
}

// ─── CIFS/SMB streaming store ──────────────────────────────────────────

export class CifsStreamingStore implements StreamingSnapshotStore {
  constructor(private readonly config: {
    readonly host: string;
    readonly port?: number;
    readonly share: string;
    readonly user: string;
    /**
     * IMPORTANT: the password MUST be in rclone-obscured form (NOT
     * plaintext). Use `rcloneObscure(plaintext)` from
     * ./rclone-obscure.ts BEFORE constructing this store —
     * resolveSnapshotStoreForClass does this in the CIFS branch.
     */
    readonly password: string;
    readonly domain?: string;
    readonly basePath?: string;
    readonly credentialsSecret?: { name: string; userKey: string; passwordKey: string };
  }) {}

  reservePath(tenantId: string, snapshotId: string): string {
    return `${tenantId}/${snapshotId}.tar.gz`;
  }

  mountTarget(_archivePath: string): { readonly volumeSpec: Record<string, unknown>; readonly mountPath: string; readonly relativePath: string } {
    return {
      volumeSpec: { name: 'streaming-store-no-mount', emptyDir: {} },
      mountPath: '/dev/null-mount',
      relativePath: 'unused',
    };
  }

  getStreamingJob(archivePath: string): StreamingJobEnvelope {
    const prefix = this.config.basePath ? `${this.config.basePath.replace(/\/+$/, '')}/` : '';
    const remotePath = `${prefix}${archivePath}`;
    const remoteUri = `REMOTE:${remotePath}`;
    const shaUri = `REMOTE:${remotePath}.sha256`;
    // Phase 12: split into public + secret env. Credentials (user +
    // obscured password) go via ephemeral k8s Secret.
    const publicEnv: Array<{ name: string; value: string }> = [
      { name: 'RCLONE_CONFIG_REMOTE_TYPE', value: 'smb' },
      { name: 'RCLONE_CONFIG_REMOTE_HOST', value: this.config.host },
      { name: 'RCLONE_LOW_LEVEL_RETRIES', value: '3' },
      { name: 'RCLONE_USE_JSON_LOG', value: 'true' },
      { name: 'RCLONE_STATS', value: '15s' },
      { name: 'RCLONE_STATS_ONE_LINE', value: 'true' },
      { name: 'RCLONE_CONTIMEOUT', value: '60s' },
      { name: 'RCLONE_TIMEOUT', value: '300s' },
    ];
    if (this.config.domain) {
      publicEnv.push({ name: 'RCLONE_CONFIG_REMOTE_DOMAIN', value: this.config.domain });
    }
    if (this.config.port && this.config.port !== 445) {
      publicEnv.push({ name: 'RCLONE_CONFIG_REMOTE_PORT', value: String(this.config.port) });
    }
    // rclone's RCLONE_CONFIG_REMOTE_PASS requires the password in
    // rclone-obscured form (NOT plaintext) — `config.password` MUST
    // already be obscured by the caller (`resolveSnapshotStoreForClass`
    // runs `rcloneObscure()` on the decrypted plaintext).
    const secretEnv: Record<string, string> = {
      RCLONE_CONFIG_REMOTE_USER: this.config.user,
      RCLONE_CONFIG_REMOTE_PASS: this.config.password,
    };
    // SMB path: REMOTE: prefix maps to REMOTE_HOST. Share is the first
    // path component. We pre-pend the share in the URI.
    const finalRemote = remoteUri.replace('REMOTE:', `REMOTE:${this.config.share}/`);
    const finalSha = shaUri.replace('REMOTE:', `REMOTE:${this.config.share}/`);
    return { image: RCLONE_IMAGE, script: buildStreamingScript(), publicEnv, secretEnv, remoteUri: finalRemote, shaUri: finalSha };
  }

  getStreamingRestoreJob(archivePath: string): StreamingJobEnvelope {
    const upload = this.getStreamingJob(archivePath);
    return {
      image: RCLONE_IMAGE,
      script: buildStreamingRestoreScript(),
      publicEnv: upload.publicEnv,
      secretEnv: upload.secretEnv,
      remoteUri: upload.remoteUri,
      shaUri: upload.shaUri,
    };
  }

  // ─── CIFS read paths (Phase 11) ────────────────────────────────────
  //
  // SMB has no SDK in Node-land that we can use directly, so stat /
  // delete / readSidecar each spawn a short-lived rclone Job in the
  // platform namespace. ~5-8s per call (Job startup + rclone), but
  // these run from cron (expireSnapshots, every 6h) and from operator
  // actions (manual delete) — never on the hot path.
  //
  // The fallback "throw not implemented" lets unit tests that don't
  // pass k8s context still construct a store; in production
  // resolveSnapshotStoreForClass attaches a k8s context via setter.

  /** Set by resolveSnapshotStoreForClass at construction time. Lazy
   *  because the store constructor signature must stay synchronous and
   *  not require importing K8sClients. */
  private k8sCtx: { k8s: unknown; namespace: string } | null = null;
  setK8sContext(ctx: { k8s: unknown; namespace: string }): void {
    this.k8sCtx = ctx;
  }

  private buildRemoteUri(archivePath: string): string {
    const prefix = this.config.basePath ? `${this.config.basePath.replace(/\/+$/, '')}/` : '';
    return `REMOTE:${this.config.share}/${prefix}${archivePath}`;
  }

  /**
   * Plain-env vars (NOT secret) needed by every CIFS rclone invocation.
   * The credentials env (USER + PASS) is in `buildSecretEnv` — kept
   * separate so Phase 12's Secret-mounting refactor only needs to
   * change credential delivery, not the public config.
   */
  private buildPublicEnv(): Array<{ name: string; value: string }> {
    const env: Array<{ name: string; value: string }> = [
      { name: 'RCLONE_CONFIG_REMOTE_TYPE', value: 'smb' },
      { name: 'RCLONE_CONFIG_REMOTE_HOST', value: this.config.host },
      { name: 'RCLONE_LOW_LEVEL_RETRIES', value: '3' },
      { name: 'RCLONE_CONTIMEOUT', value: '60s' },
      { name: 'RCLONE_TIMEOUT', value: '300s' },
    ];
    if (this.config.port && this.config.port !== 445) {
      env.push({ name: 'RCLONE_CONFIG_REMOTE_PORT', value: String(this.config.port) });
    }
    if (this.config.domain) {
      env.push({ name: 'RCLONE_CONFIG_REMOTE_DOMAIN', value: this.config.domain });
    }
    return env;
  }

  private buildSecretEnv(): Array<{ name: string; value: string }> {
    return [
      { name: 'RCLONE_CONFIG_REMOTE_USER', value: this.config.user },
      { name: 'RCLONE_CONFIG_REMOTE_PASS', value: this.config.password },
    ];
  }

  async stat(archivePath: string): Promise<{ sizeBytes: number } | null> {
    if (!this.k8sCtx) {
      throw new Error('CifsStreamingStore.stat — no k8s context attached (call setK8sContext)');
    }
    const remoteUri = this.buildRemoteUri(archivePath);
    const result = await runRcloneOneShot(this.k8sCtx, {
      name: `cifs-stat-${shortId(archivePath)}`,
      publicEnv: this.buildPublicEnv(),
      secretEnv: this.buildSecretEnv(),
      // `rclone size --json` prints `{"count":N,"bytes":N}` to stdout.
      // For a missing file rclone exits non-zero — we treat that as null.
      args: ['size', '--json', remoteUri],
      timeoutMs: 60_000,
    });
    if (result.exitCode !== 0) {
      // Most likely "object not found" — treat as missing for the
      // expireSnapshots cron's idempotency.
      return null;
    }
    const m = result.stdout.match(/"bytes":\s*(\d+)/);
    if (!m) return null;
    return { sizeBytes: Number(m[1]) };
  }

  async delete(archivePath: string): Promise<boolean> {
    if (!this.k8sCtx) {
      throw new Error('CifsStreamingStore.delete — no k8s context attached');
    }
    const remoteUri = this.buildRemoteUri(archivePath);
    const result = await runRcloneOneShot(this.k8sCtx, {
      name: `cifs-del-${shortId(archivePath)}`,
      publicEnv: this.buildPublicEnv(),
      secretEnv: this.buildSecretEnv(),
      // `deletefile` exits 0 on success, non-zero if missing. Wrap so
      // a missing file is a no-op (matches LocalHostPathStore + S3Store
      // semantics).
      args: ['deletefile', remoteUri],
      timeoutMs: 60_000,
    });
    const existed = result.exitCode === 0;
    // Best-effort sidecar delete — same Job ttl, never block on this.
    try {
      await runRcloneOneShot(this.k8sCtx, {
        name: `cifs-del-sc-${shortId(archivePath)}`,
        publicEnv: this.buildPublicEnv(),
        secretEnv: this.buildSecretEnv(),
        args: ['deletefile', `${remoteUri}.sha256`],
        timeoutMs: 60_000,
      });
    } catch { /* ignore */ }
    return existed;
  }

  async readSidecar(archivePath: string, suffix: string): Promise<string | null> {
    if (!this.k8sCtx) {
      throw new Error('CifsStreamingStore.readSidecar — no k8s context attached');
    }
    const remoteUri = this.buildRemoteUri(archivePath) + suffix;
    const result = await runRcloneOneShot(this.k8sCtx, {
      name: `cifs-cat-${shortId(archivePath + suffix)}`,
      publicEnv: this.buildPublicEnv(),
      secretEnv: this.buildSecretEnv(),
      args: ['cat', remoteUri],
      timeoutMs: 60_000,
    });
    if (result.exitCode !== 0) return null;
    const trimmed = result.stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
}

// ─── One-shot rclone Job helper (Phase 11) ──────────────────────────────
//
// Used by CifsStreamingStore for stat/delete/readSidecar. Could also be
// used by Phase 11.5 SSH read paths and any other rclone-driven micro-op.
//
// Creates a Job → polls → reads pod log → cleans up Job (TTL handles
// it eventually, but explicit delete on success/timeout speeds the
// next call). Returns stdout + stderr + exitCode.
//
// Phase 12 will refactor this to mount credentials via an ephemeral
// k8s Secret (envFrom + ownerReferences cascade GC) instead of inline
// env values.

interface RcloneOneShotOpts {
  readonly name: string;
  readonly publicEnv: Array<{ name: string; value: string }>;
  readonly secretEnv: Array<{ name: string; value: string }>;
  readonly args: string[];
  readonly timeoutMs?: number;
}

interface RcloneOneShotResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

async function runRcloneOneShot(
  k8sCtx: { k8s: unknown; namespace: string },
  opts: RcloneOneShotOpts,
): Promise<RcloneOneShotResult> {
  // Cast the lazy-typed k8s context once at entry — the caller (the
  // resolver) knows the real K8sClients shape; we keep it opaque here
  // so streaming-store.ts doesn't import k8s-provisioner.
  const k8s = k8sCtx.k8s as {
    batch: {
      createNamespacedJob: (args: { namespace: string; body: unknown }) => Promise<{ metadata?: { uid?: string } } | { body?: { metadata?: { uid?: string } } } | unknown>;
      readNamespacedJob: (args: { name: string; namespace: string }) => Promise<{
        status?: { conditions?: Array<{ type: string; status: string }>; succeeded?: number; failed?: number };
        metadata?: { uid?: string };
      }>;
      deleteNamespacedJob: (args: { name: string; namespace: string; propagationPolicy?: string }) => Promise<unknown>;
    };
    core: {
      createNamespacedSecret: (args: { namespace: string; body: unknown }) => Promise<unknown>;
      patchNamespacedSecret?: (args: { name: string; namespace: string; body: unknown; headers?: Record<string, string> }) => Promise<unknown>;
      deleteNamespacedSecret?: (args: { name: string; namespace: string }) => Promise<unknown>;
      listNamespacedPod: (args: { namespace: string; labelSelector?: string }) => Promise<{
        items: Array<{ metadata?: { name?: string } }>;
      }>;
      readNamespacedPodLog: (args: { name: string; namespace: string; tailLines?: number }) => Promise<string>;
    };
  };

  const jobName = opts.name.slice(0, 63);
  const timeoutMs = opts.timeoutMs ?? 120_000;

  // Phase 12: split secretEnv into a per-Job Secret + envFrom binding.
  // Create the Secret FIRST so the Job's envFrom resolves at startup.
  const secretName = credSecretNameFor(jobName);
  const secretData: Record<string, string> = {};
  for (const e of opts.secretEnv) {
    secretData[e.name] = e.value;
  }
  let secretCreated = false;
  if (Object.keys(secretData).length > 0) {
    await createEphemeralCredentialsSecret(k8s, k8sCtx.namespace, secretName, secretData);
    secretCreated = true;
  }

  const jobBody = {
    metadata: {
      name: jobName,
      namespace: k8sCtx.namespace,
      labels: { 'platform.io/component': 'rclone-oneshot' },
    },
    spec: {
      backoffLimit: 0,
      // Auto-cleanup after 5 min so the platform namespace doesn't
      // accumulate completed Jobs from a high-frequency expire cron.
      // The owned Secret cascades with the Job's GC.
      ttlSecondsAfterFinished: 300,
      activeDeadlineSeconds: Math.floor(timeoutMs / 1000),
      template: {
        metadata: { labels: { 'platform.io/component': 'rclone-oneshot' } },
        spec: {
          restartPolicy: 'Never',
          containers: [{
            name: 'rclone',
            image: RCLONE_IMAGE,
            imagePullPolicy: 'IfNotPresent',
            command: ['rclone', ...opts.args],
            // RCLONE_LOG_LEVEL=ERROR silences NOTICE lines (e.g. the
            // "Config file not found - using defaults" notice that
            // would otherwise pollute the pod log and bleed into
            // readSidecar's return value — the caller stores .stdout
            // directly as the sha256 sidecar contents.
            env: [...opts.publicEnv, { name: 'RCLONE_LOG_LEVEL', value: 'ERROR' }],
            envFrom: secretCreated ? buildEnvFromSecret(secretName) : undefined,
            resources: {
              requests: { cpu: '50m', memory: '64Mi' },
              limits: { cpu: '500m', memory: '256Mi' },
            },
          }],
        },
      },
    },
  };

  let createdJob: { metadata?: { uid?: string } } | undefined;
  try {
    const resp = await k8s.batch.createNamespacedJob({ namespace: k8sCtx.namespace, body: jobBody });
    createdJob = (resp as { body?: { metadata?: { uid?: string } } }).body ?? (resp as { metadata?: { uid?: string } });
  } catch (err) {
    // Clean up the orphan Secret on Job-create failure — TTL cascade
    // can't fire because no owning Job exists yet.
    if (secretCreated) {
      await deleteSecretBestEffort(k8s, k8sCtx.namespace, secretName);
    }
    throw err;
  }

  // Bind the Secret to the Job via ownerReferences so GC cascades.
  // Best-effort: orphan-cleanup cron is the safety net.
  if (secretCreated && createdJob?.metadata?.uid) {
    await attachOwnerToSecret(k8s, k8sCtx.namespace, secretName, {
      name: jobName,
      uid: createdJob.metadata.uid,
    }).catch(() => { /* cron will pick it up */ });
  }

  // Poll until terminal.
  const start = Date.now();
  let succeeded = false;
  let failed = false;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const job = await k8s.batch.readNamespacedJob({ name: jobName, namespace: k8sCtx.namespace });
    const conds = job.status?.conditions ?? [];
    if (conds.find((c) => c.type === 'Complete' && c.status === 'True') || (job.status?.succeeded ?? 0) > 0) {
      succeeded = true;
      break;
    }
    if (conds.find((c) => c.type === 'Failed' && c.status === 'True') || (job.status?.failed ?? 0) > 0) {
      failed = true;
      break;
    }
    if (Date.now() - start > timeoutMs) {
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  // Read pod log — the Job may have produced output before terminating.
  let stdout = '';
  try {
    const pods = await k8s.core.listNamespacedPod({
      namespace: k8sCtx.namespace,
      labelSelector: `job-name=${jobName}`,
    });
    const pod = pods.items?.[0]?.metadata?.name;
    if (pod) {
      stdout = await k8s.core.readNamespacedPodLog({
        name: pod,
        namespace: k8sCtx.namespace,
        tailLines: 200,
      });
    }
  } catch { /* best-effort */ }

  // Best-effort Job delete — TTL would handle it but we want the
  // namespace tidy for the next call.
  try {
    await k8s.batch.deleteNamespacedJob({
      name: jobName,
      namespace: k8sCtx.namespace,
      propagationPolicy: 'Background',
    });
  } catch { /* ignore */ }

  return {
    stdout,
    stderr: '',
    exitCode: succeeded ? 0 : (failed ? 1 : 124 /* timeout */),
  };
}

// Short, k8s-name-safe slug derived from an archive path. Used to make
// per-call Job names unique enough to avoid 60-second-window collisions
// across concurrent stat/delete invocations.
function shortId(s: string): string {
  // Lower-case alphanumerics only; replace everything else with '-'.
  const slug = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const ts = Date.now().toString(36);
  return `${slug.slice(0, 30)}-${ts}`;
}

// ─── Streaming pipeline script ──────────────────────────────────────────

/**
 * POSIX-sh pipeline that runs inside every streaming snapshot Job
 * container. Single source of truth — all three concrete stores share
 * this script so a fix lands once.
 *
 * Pipeline (pipefail-protected, busybox-sh compatible):
 *   1. Background `sha256sum < /tmp/tar-pipe` reads from a named pipe
 *   2. tar -c the source PVC (read-only mount at /source)
 *   3. gzip -1 for low-CPU compression
 *   4. tee splits the byte stream — one copy to the pipe, one to rclone
 *   5. rclone rcat $REMOTE_URI streams to remote, no local file
 *   6. wait for sha256sum, then upload sidecar
 *
 * Named-pipe approach (NOT bash process substitution `>(...)`) because
 * the `rclone/rclone` image is alpine-based and ships only `sh`/busybox,
 * not bash. busybox `sh` DOES support `set -o pipefail`, so tar errors
 * still abort the pipeline before rclone uploads garbage.
 *
 * Memory footprint: tar (5 MB) + gzip (1 MB) + sha256sum (4 MB) +
 * rclone S3 multipart buffer (16 MB chunk × 8 concurrent = ~130 MB).
 * Well within the 256 Mi container limit.
 */
function buildStreamingScript(): string {
  // NOTE: we DON'T use `set -e` here because we want explicit error
  // handling at each step (busybox sh + named-pipe + background process
  // interactions are subtle, and silent abort makes debugging hard).
  // We capture each command's RC and exit explicitly with a clear message.
  return [
    '#!/bin/sh',
    '# Phase 4 streaming snapshot pipeline (busybox-sh compatible).',
    'echo "[snapshot] starting tar | gzip | tee | sha256+rclone pipeline"',
    'echo "[snapshot] source size estimate:"',
    'du -sh /source 2>&1 | head -1 || true',
    'echo "[snapshot] remote URI: $REMOTE_URI"',
    '# Create a named pipe so the byte stream can fan-out to sha256 AND rclone.',
    'mkfifo /tmp/tar-pipe || { echo "[snapshot] mkfifo failed"; exit 1; }',
    'echo "[snapshot] starting background sha256sum reader"',
    'sha256sum < /tmp/tar-pipe | awk \'{print $1}\' > /tmp/sha &',
    'SHA_PID=$!',
    'echo "[snapshot] starting tar | gzip | tee | rclone foreground pipeline"',
    'set -o pipefail',
    '# busybox tar does NOT support GNU --warning= flag; keep tar args minimal.',
    'tar c -C /source . 2>/tmp/tar.err \\',
    '  | gzip -1 \\',
    '  | tee /tmp/tar-pipe \\',
    '  | rclone rcat "$REMOTE_URI" 2>/tmp/rclone.err',
    'PIPELINE_RC=$?',
    'set +o pipefail',
    'echo "[snapshot] foreground pipeline finished rc=$PIPELINE_RC, waiting for sha256sum"',
    'wait $SHA_PID',
    'SHA_RC=$?',
    'echo "[snapshot] sha256sum wait rc=$SHA_RC, /tmp/sha=$(cat /tmp/sha 2>/dev/null || echo MISSING)"',
    'if [ "$PIPELINE_RC" != "0" ]; then',
    '  echo "[snapshot] pipeline failed (rc=$PIPELINE_RC)"',
    '  echo "--- tar stderr ---"; cat /tmp/tar.err >&2 2>/dev/null || true',
    '  echo "--- rclone stderr ---"; cat /tmp/rclone.err >&2 2>/dev/null || true',
    '  exit 1',
    'fi',
    'if [ "$SHA_RC" != "0" ]; then',
    '  echo "[snapshot] sha256sum failed (rc=$SHA_RC)"',
    '  exit 1',
    'fi',
    'if [ ! -s /tmp/sha ]; then',
    '  echo "[snapshot] sha256 sidecar never materialised"',
    '  exit 1',
    'fi',
    'echo "[snapshot] archive uploaded, sha256=$(cat /tmp/sha)"',
    'echo "[snapshot] uploading sha256 sidecar to $SHA_URI"',
    'printf "%s" "$(cat /tmp/sha)" | rclone rcat "$SHA_URI" 2>/tmp/rclone-sha.err',
    'SIDECAR_RC=$?',
    'if [ "$SIDECAR_RC" != "0" ]; then',
    '  echo "[snapshot] sidecar upload failed (rc=$SIDECAR_RC)"',
    '  cat /tmp/rclone-sha.err >&2 2>/dev/null || true',
    '  exit 1',
    'fi',
    'echo "[snapshot] complete"',
  ].join('\n');
}

/**
 * Phase 5 streaming RESTORE pipeline (busybox-sh compatible).
 *
 * Pipeline:
 *   rclone cat $REMOTE_URI | gunzip | tar x -C /target
 *
 * No local file. The Job pod mounts the target PVC at /target
 * (read-write); rclone streams the remote archive to stdout; gunzip
 * decompresses; tar extracts in place.
 *
 * On failure: tar exits non-zero, pipefail aborts, /target may have
 * partial extraction (the caller's responsibility to wipe + retry).
 * The orchestrator quiesces before restore, so partial state is safe.
 */
function buildStreamingRestoreScript(): string {
  return [
    '#!/bin/sh',
    '# Phase 5 streaming restore pipeline (busybox-sh compatible).',
    'echo "[restore] starting rclone | gunzip | tar pipeline"',
    'echo "[restore] remote URI: $REMOTE_URI"',
    'echo "[restore] target dir: /target"',
    '# Destructive restore: wipe /target before extract. Snapshot semantics',
    '# require "make the PVC look exactly like it did at snapshot time",',
    '# which means files added AFTER the snapshot must vanish. Plain `tar x`',
    '# is additive — it overlays the archive onto whatever is there. The',
    '# `find -delete` pattern removes everything inside /target (incl. dotfiles)',
    '# without removing the mount point itself.',
    'echo "[restore] wiping /target before extract"',
    'find /target -mindepth 1 -delete 2>/tmp/wipe.err',
    'WIPE_RC=$?',
    'if [ "$WIPE_RC" != "0" ]; then',
    '  echo "[restore] wipe failed (rc=$WIPE_RC)"',
    '  cat /tmp/wipe.err >&2 2>/dev/null || true',
    '  exit 1',
    'fi',
    'set -o pipefail',
    'rclone cat "$REMOTE_URI" 2>/tmp/rclone.err \\',
    '  | gunzip \\',
    '  | tar x -C /target 2>/tmp/tar.err',
    'PIPELINE_RC=$?',
    'set +o pipefail',
    'if [ "$PIPELINE_RC" != "0" ]; then',
    '  echo "[restore] pipeline failed (rc=$PIPELINE_RC)"',
    '  echo "--- rclone stderr ---"; cat /tmp/rclone.err >&2 2>/dev/null || true',
    '  echo "--- tar stderr ---"; cat /tmp/tar.err >&2 2>/dev/null || true',
    '  exit 1',
    'fi',
    'echo "[restore] extracted to /target"',
    'ls -la /target 2>&1 | head -10 || true',
    'echo "[restore] complete"',
  ].join('\n');
}

// ─── Ephemeral per-Job Secret helpers (Phase 12) ─────────────────────
//
// The streaming snapshot / restore / speedtest Jobs all need rclone
// credentials in env form. To avoid leaking those credentials into
// `kubectl get pod -o yaml` (Phase 4 HIGH code-review finding), we
// mount them via an ephemeral k8s Secret bound by ownerReferences to
// the Job. When the Job's `ttlSecondsAfterFinished` fires, k8s
// cascades the GC to the Secret automatically.
//
// Flow:
//   1. createEphemeralCredentialsSecret(k8s, ns, name, data)
//   2. create Job with envFrom: [{ secretRef: { name } }]
//   3. (after Job creation returns) attachOwnerToSecret(k8s, ns, name, jobUid)
//   4. delete the Secret manually only on the failure path before owner
//      is attached — TTL cascade handles the happy path.
//
// Orphan cleanup: a cron walks Secrets older than 1h with the
// `platform.io/component=rclone-creds` label and no ownerReferences
// → deletes (covers the step-2-failed-before-step-3 edge case).

type K8sLike = {
  core: {
    createNamespacedSecret: (args: { namespace: string; body: unknown }) => Promise<unknown>;
    // The Kubernetes JS SDK's patchNamespacedSecret takes the body
    // object first, then an Options/middleware arg as second positional
    // — that's where the Content-Type is set. We import MERGE_PATCH
    // from shared/k8s-patch to pin it to RFC-7396 (which is what the
    // apiserver wants for an ownerReferences merge — JSON-patch op
    // arrays don't fit cleanly here).
    patchNamespacedSecret?: (args: { name: string; namespace: string; body: unknown }, options: unknown) => Promise<unknown>;
    deleteNamespacedSecret?: (args: { name: string; namespace: string }) => Promise<unknown>;
  };
};

const RCLONE_CREDS_LABEL = 'platform.io/component';
const RCLONE_CREDS_LABEL_VALUE = 'rclone-creds';

/**
 * Create an ephemeral Secret holding rclone credentials. Returns the
 * secret name on success. The Secret has NO ownerReference yet —
 * call `attachOwnerToSecret` AFTER the consuming Job is created so
 * we get its UID.
 */
export async function createEphemeralCredentialsSecret(
  k8s: K8sLike,
  namespace: string,
  secretName: string,
  data: Record<string, string>,
): Promise<string> {
  await k8s.core.createNamespacedSecret({
    namespace,
    body: {
      metadata: {
        name: secretName,
        namespace,
        labels: { [RCLONE_CREDS_LABEL]: RCLONE_CREDS_LABEL_VALUE },
      },
      type: 'Opaque',
      stringData: data,
    },
  });
  return secretName;
}

/**
 * Patch the Secret's `metadata.ownerReferences` so the cluster GC
 * cascades the delete when the Job's TTL fires. Best-effort — if this
 * fails (e.g. RBAC), the orphan-cleanup cron handles it within an hour.
 */
export async function attachOwnerToSecret(
  k8s: K8sLike,
  namespace: string,
  secretName: string,
  ownerJob: { name: string; uid: string },
): Promise<void> {
  if (!k8s.core.patchNamespacedSecret) {
    // SDK shape doesn't expose patch — operator-cleanup cron will GC.
    return;
  }
  const { MERGE_PATCH } = await import('../../shared/k8s-patch.js');
  const body = {
    metadata: {
      ownerReferences: [{
        apiVersion: 'batch/v1',
        kind: 'Job',
        name: ownerJob.name,
        uid: ownerJob.uid,
        // controller=false because the Job doesn't manage Secret state
        // beyond GC; blockOwnerDeletion=false so deleting the Job
        // doesn't block on Secret finalizers.
        controller: false,
        blockOwnerDeletion: false,
      }],
    },
  };
  await k8s.core.patchNamespacedSecret(
    { name: secretName, namespace, body },
    MERGE_PATCH,
  );
}

/**
 * Best-effort Secret delete. Used on the failure-mid-orchestration
 * path (Secret created but Job creation threw, so cascade GC won't
 * fire). The orphan cron is the safety net if this also fails.
 */
export async function deleteSecretBestEffort(
  k8s: K8sLike,
  namespace: string,
  secretName: string,
): Promise<void> {
  if (!k8s.core.deleteNamespacedSecret) return;
  try {
    await k8s.core.deleteNamespacedSecret({ name: secretName, namespace });
  } catch { /* ignore */ }
}

/**
 * Build the Job's `envFrom` block from a secret name. Pair with
 * publicEnv via `env` for the inline (non-sensitive) parts.
 */
export function buildEnvFromSecret(secretName: string): Array<{ secretRef: { name: string } }> {
  return [{ secretRef: { name: secretName } }];
}

/**
 * Deterministic Secret name derived from a Job name. Same length cap
 * as Job names (63 chars). Reusable across snapshot / restore /
 * speedtest / cifs-oneshot.
 */
export function credSecretNameFor(jobName: string): string {
  // Suffix is short + deterministic so a stuck Job's leftover Secret
  // can be matched and reused on the next attempt.
  const base = `${jobName}-creds`;
  return base.length <= 63 ? base : base.slice(0, 63);
}

export const RCLONE_CREDS_LABEL_SELECTOR = `${RCLONE_CREDS_LABEL}=${RCLONE_CREDS_LABEL_VALUE}`;
