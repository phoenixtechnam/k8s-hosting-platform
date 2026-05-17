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
   * from `envVars` below.
   */
  readonly script: string;
  readonly envVars: Array<{ name: string; value?: string; valueFrom?: { secretKeyRef: { name: string; key: string } } }>;
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
    const envVars: StreamingJobEnvelope['envVars'] = [
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
      // loops or stuck TCP. Code-review MEDIUM gap. 60s connect + 5min
      // single-request timeout gives faster failure than waiting for
      // the 6h activeDeadlineSeconds backstop.
      { name: 'RCLONE_CONTIMEOUT', value: '60s' },
      { name: 'RCLONE_TIMEOUT', value: '300s' },
    ];
    if (this.config.endpoint) {
      envVars.push({ name: 'RCLONE_CONFIG_REMOTE_ENDPOINT', value: this.config.endpoint });
      // Hetzner / minio / Backblaze need path-style addressing.
      envVars.push({ name: 'RCLONE_CONFIG_REMOTE_FORCE_PATH_STYLE', value: 'true' });
    }
    if (this.config.credentialsSecret) {
      envVars.push({
        name: 'RCLONE_CONFIG_REMOTE_ACCESS_KEY_ID',
        valueFrom: { secretKeyRef: { name: this.config.credentialsSecret.name, key: this.config.credentialsSecret.accessKeyKey } },
      });
      envVars.push({
        name: 'RCLONE_CONFIG_REMOTE_SECRET_ACCESS_KEY',
        valueFrom: { secretKeyRef: { name: this.config.credentialsSecret.name, key: this.config.credentialsSecret.secretKeyKey } },
      });
    } else {
      // KNOWN GAP (code-review HIGH #1, deferred to Phase 4.5/5):
      // plaintext credentials in the Job pod spec are visible in
      // `kubectl get pod -o yaml`. In our model the tenant namespace
      // doesn't grant pod-list to tenant users (only platform-admin SA
      // + admin users — who already have backup_configurations
      // decrypt access via PLATFORM_ENCRYPTION_KEY), so the leak
      // surface is admin-only. Audit-log capture is the remaining
      // concern. To close: wire `credentialsSecret` from a per-Job
      // ephemeral Secret created by snapshot.ts before Job submission
      // and deleted on Job completion.
      envVars.push({ name: 'RCLONE_CONFIG_REMOTE_ACCESS_KEY_ID', value: this.config.accessKeyId });
      envVars.push({ name: 'RCLONE_CONFIG_REMOTE_SECRET_ACCESS_KEY', value: this.config.secretAccessKey });
    }

    return { image: RCLONE_IMAGE, script: buildStreamingScript(), envVars, remoteUri, shaUri };
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
      envVars: upload.envVars,
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
    const envVars: StreamingJobEnvelope['envVars'] = [
      { name: 'RCLONE_CONFIG_REMOTE_TYPE', value: 'sftp' },
      { name: 'RCLONE_CONFIG_REMOTE_HOST', value: this.config.host },
      { name: 'RCLONE_CONFIG_REMOTE_PORT', value: String(this.config.port) },
      { name: 'RCLONE_CONFIG_REMOTE_USER', value: this.config.user },
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
    return { image: RCLONE_IMAGE, script: buildStreamingScript(), envVars, remoteUri, shaUri };
  }

  getStreamingRestoreJob(archivePath: string): StreamingJobEnvelope {
    const upload = this.getStreamingJob(archivePath);
    return {
      image: RCLONE_IMAGE,
      script: buildStreamingRestoreScript(),
      envVars: upload.envVars,
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
    const envVars: StreamingJobEnvelope['envVars'] = [
      { name: 'RCLONE_CONFIG_REMOTE_TYPE', value: 'smb' },
      { name: 'RCLONE_CONFIG_REMOTE_HOST', value: this.config.host },
      // rclone smb wants the share via the bucket-style accessor in the
      // remote URI (REMOTE:share/path), but its config is set via the
      // host alone — share goes in the path. We pre-prepend it here.
      { name: 'RCLONE_LOW_LEVEL_RETRIES', value: '3' },
      { name: 'RCLONE_USE_JSON_LOG', value: 'true' },
      { name: 'RCLONE_STATS', value: '15s' },
      { name: 'RCLONE_STATS_ONE_LINE', value: 'true' },
    ];
    if (this.config.domain) {
      envVars.push({ name: 'RCLONE_CONFIG_REMOTE_DOMAIN', value: this.config.domain });
    }
    if (this.config.credentialsSecret) {
      envVars.push({
        name: 'RCLONE_CONFIG_REMOTE_USER',
        valueFrom: { secretKeyRef: { name: this.config.credentialsSecret.name, key: this.config.credentialsSecret.userKey } },
      });
      envVars.push({
        name: 'RCLONE_CONFIG_REMOTE_PASS',
        valueFrom: { secretKeyRef: { name: this.config.credentialsSecret.name, key: this.config.credentialsSecret.passwordKey } },
      });
    } else {
      envVars.push({ name: 'RCLONE_CONFIG_REMOTE_USER', value: this.config.user });
      // rclone's RCLONE_CONFIG_REMOTE_PASS requires the password in
      // rclone-obscured form (NOT plaintext) — `config.password` MUST
      // already be obscured by the caller (`resolveSnapshotStoreForClass`
      // runs `rcloneObscure()` on the decrypted plaintext). Passing
      // plaintext here makes rclone mis-decode the value as garbage
      // and the SMB auth fails with cryptic errors.
      envVars.push({ name: 'RCLONE_CONFIG_REMOTE_PASS', value: this.config.password });
    }
    // SMB port — rclone defaults to 445 but operator may override.
    if (this.config.port && this.config.port !== 445) {
      envVars.push({ name: 'RCLONE_CONFIG_REMOTE_PORT', value: String(this.config.port) });
    }
    // SMB path: REMOTE: prefix maps to REMOTE_HOST. Share is the first
    // path component. We pre-pend the share in the URI.
    const finalRemote = remoteUri.replace('REMOTE:', `REMOTE:${this.config.share}/`);
    const finalSha = shaUri.replace('REMOTE:', `REMOTE:${this.config.share}/`);
    return { image: RCLONE_IMAGE, script: buildStreamingScript(), envVars, remoteUri: finalRemote, shaUri: finalSha };
  }

  getStreamingRestoreJob(archivePath: string): StreamingJobEnvelope {
    const upload = this.getStreamingJob(archivePath);
    return {
      image: RCLONE_IMAGE,
      script: buildStreamingRestoreScript(),
      envVars: upload.envVars,
      remoteUri: upload.remoteUri,
      shaUri: upload.shaUri,
    };
  }

  async stat(_archivePath: string): Promise<{ sizeBytes: number } | null> {
    throw new Error('CifsStreamingStore.stat — read path not yet implemented (Phase 5)');
  }
  async delete(_archivePath: string): Promise<boolean> {
    throw new Error('CifsStreamingStore.delete — read path not yet implemented (Phase 5)');
  }
  async readSidecar(_archivePath: string, _suffix: string): Promise<string | null> {
    throw new Error('CifsStreamingStore.readSidecar — read path not yet implemented (Phase 5)');
  }
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
