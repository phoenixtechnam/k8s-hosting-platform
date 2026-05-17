import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { SnapshotStore } from './snapshot-store.js';
import type { StreamingSnapshotStore } from './streaming-store.js';

/**
 * Snapshot a tenant PVC by launching a short-lived K8s Job that tars
 * the PVC contents to the configured SnapshotStore.
 *
 * Contract:
 *   - Caller has already quiesced the namespace (pods no longer hold the
 *     PVC's RWO lock). `snapshotTenantPVC` itself does NOT quiesce.
 *   - Returns when the Job completes — or throws if it failed / timed out.
 *   - The archive path in the store is `store.reservePath(tenantId, snapId)`.
 *     The archive is written from inside the Job via a second volume mount
 *     (legacy stores) OR streamed directly via rclone (Phase 4 stores).
 *   - Size + sha256 of the resulting archive are reported in the return.
 *
 * Phase 4 of the snapshot-storage overhaul: when the store implements
 * the `StreamingSnapshotStore` interface (`getStreamingJob` method),
 * the Job runs a pure `tar | gzip | tee >(sha256sum) | rclone rcat`
 * pipeline with NO local file on disk — memory ceiling ~256 MiB
 * regardless of PVC size.
 */

export interface SnapshotResult {
  readonly archivePath: string;
  readonly sizeBytes: number;
  readonly sha256: string | null;
}

const DEFAULT_JOB_IMAGE = 'busybox:1.36';
// Streaming Jobs may run for hours on large PVCs (500 GB / 50 Mbps =
// 4h floor for S3). 6h ceiling covers the typical worst case; longer
// snapshots should run via a dedicated cron + segmentation strategy
// outside this codepath.
const DEFAULT_JOB_TIMEOUT_MS = 6 * 60 * 60 * 1000;

function isStreamingStore(store: SnapshotStore): store is StreamingSnapshotStore {
  return typeof (store as Partial<StreamingSnapshotStore>).getStreamingJob === 'function';
}

export async function snapshotTenantPVC(
  k8s: K8sClients,
  opts: {
    readonly namespace: string;
    readonly pvcName: string;
    readonly tenantId: string;
    readonly snapshotId: string;
    readonly store: SnapshotStore;
    readonly jobImage?: string;
    readonly timeoutMs?: number;
    /** Optional callback fired every poll cycle (~3s) with the latest
     *  log line from the snapshot Job pod. Used to surface live
     *  tar/curl progress into storage_operations.progressMessage so
     *  the UI shows real movement instead of a stuck percentage. */
    readonly onProgress?: (msg: string) => Promise<void> | void;
  },
): Promise<SnapshotResult> {
  const archivePath = opts.store.reservePath(opts.tenantId, opts.snapshotId);
  const jobName = `snap-${opts.snapshotId}`.slice(0, 63);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;

  // Phase 4 of the snapshot-storage overhaul: streaming stores skip
  // the legacy "tar to local scratch → upload" pattern entirely.
  // `getStreamingJob` returns the rclone pipeline + env config; the
  // Job spec below mounts ONLY the source PVC (read-only) — no
  // scratch volume, no presigned URLs, no local file.
  const streaming = isStreamingStore(opts.store);
  const streamEnvelope = streaming ? opts.store.getStreamingJob(archivePath) : null;
  const mount = streaming ? null : opts.store.mountTarget(archivePath);

  // Legacy S3 fallback (kept for back-compat with the non-streaming
  // S3Store path used by tenant-bundles and any custom integrations
  // that haven't migrated yet). Duck-type on getUploadUrls.
  interface S3StoreLike { getUploadUrls(p: string): Promise<{ archiveUrl: string; sha256Url: string }> }
  const s3 = (opts.store as unknown as S3StoreLike);
  const isLegacyS3 = !streaming && typeof s3.getUploadUrls === 'function';
  let s3Urls: { archiveUrl: string; sha256Url: string } | null = null;
  if (isLegacyS3) {
    s3Urls = await s3.getUploadUrls(archivePath);
  }
  // Default Job image: rclone for streaming, alpine for legacy S3,
  // busybox for legacy hostpath. Operator override via opts.jobImage.
  const jobImage = opts.jobImage
    ?? (streamEnvelope ? streamEnvelope.image
        : isLegacyS3 ? 'alpine:3.20'
        : DEFAULT_JOB_IMAGE);

  // Three pipeline variants:
  //   1. Streaming (Phase 4) — tar | gzip | tee | rclone rcat, no scratch
  //   2. Legacy S3        — tar to scratch, then curl PUT to presigned URL
  //   3. Legacy hostpath  — tar to scratch directly (mount is the dest)
  //
  // Variant 1 is selected when the store implements StreamingSnapshotStore.

  const script = streamEnvelope
    ? streamEnvelope.script
    : (() => {
      const baseScript = [
        'set -e',
        'mkdir -p "$(dirname "$ARCHIVE")"',
        'cd /source',
        'tar cf - . 2>/tmp/tar.err | gzip -1 > "$ARCHIVE"',
        'TAR_RC=$?',
        '[ "$TAR_RC" = "0" ] || { echo "tar failed (rc=$TAR_RC):"; cat /tmp/tar.err; exit 1; }',
        'sha256sum "$ARCHIVE" | awk \'{print $1}\' > "$ARCHIVE.sha256"',
        'ls -l "$ARCHIVE"',
        'echo "SNAPSHOT_DONE sha256=$(cat "$ARCHIVE.sha256")"',
      ];
      const s3Upload = isLegacyS3 ? [
        'apk add --no-cache curl >/dev/null',
        'echo "Uploading archive to S3 via presigned URL..."',
        'curl --fail-with-body -X PUT -H "Content-Type: application/gzip" --data-binary @"$ARCHIVE" "$S3_ARCHIVE_URL"',
        'echo "Uploading sha256 sidecar..."',
        'curl --fail-with-body -X PUT -H "Content-Type: text/plain" --data-binary @"$ARCHIVE.sha256" "$S3_SHA256_URL"',
        'echo "S3 upload complete"',
      ] : [];
      return [...baseScript, ...s3Upload].join('\n');
    })();

  // Container env: streaming pipelines get REMOTE_URI/SHA_URI + rclone
  // config env vars; legacy pipelines get ARCHIVE + optional S3 URLs.
  const containerEnv = streamEnvelope
    ? [
        { name: 'REMOTE_URI', value: streamEnvelope.remoteUri },
        { name: 'SHA_URI', value: streamEnvelope.shaUri },
        ...streamEnvelope.envVars,
      ]
    : [
        { name: 'ARCHIVE', value: `${mount!.mountPath}/${mount!.relativePath}` },
        ...(s3Urls ? [
          { name: 'S3_ARCHIVE_URL', value: s3Urls.archiveUrl },
          { name: 'S3_SHA256_URL', value: s3Urls.sha256Url },
        ] : []),
      ];

  // Volume mounts: streaming gets ONLY /source (read-only); legacy adds
  // the scratch/hostpath mount.
  const containerVolumeMounts = streamEnvelope
    ? [{ name: 'source', mountPath: '/source', readOnly: true }]
    : [
        { name: 'source', mountPath: '/source', readOnly: true },
        { name: mount!.volumeSpec.name as string, mountPath: mount!.mountPath },
      ];
  const podVolumes = streamEnvelope
    ? [{ name: 'source', persistentVolumeClaim: { claimName: opts.pvcName, readOnly: true } }]
    : [
        { name: 'source', persistentVolumeClaim: { claimName: opts.pvcName, readOnly: true } },
        mount!.volumeSpec,
      ];

  // Container command: both streaming and legacy use POSIX `sh`. The
  // rclone/rclone image is alpine-based (no bash); the streaming
  // pipeline uses a named pipe instead of bash process substitution.
  const command = ['sh', '-c', script];

  // Resource limits: streaming caps memory at 256 Mi (rclone multipart
  // buffer + tar + gzip + sha256sum). Legacy stays at 512 Mi.
  const resources = streamEnvelope
    ? {
        requests: { cpu: '100m', memory: '128Mi' },
        limits: { cpu: '500m', memory: '256Mi' },
      }
    : {
        requests: { cpu: '100m', memory: '128Mi' },
        limits: { cpu: '500m', memory: '512Mi' },
      };

  const jobBody = {
    metadata: { name: jobName, namespace: opts.namespace, labels: { 'platform.io/component': 'snapshot', 'platform.io/tenant-id': opts.tenantId, 'platform.io/pipeline': streamEnvelope ? 'streaming-rclone' : 'legacy' } },
    spec: {
      backoffLimit: 0, // don't retry on failure — fail fast, orchestrator decides
      // Streaming Jobs may run for hours; bump the auto-cleanup TTL so
      // the operator can inspect the pod log post-mortem on a failure.
      ttlSecondsAfterFinished: streamEnvelope ? 3600 : 600,
      // Phase 4: cap Job runtime at 6h ceiling. Legacy stays at 30 min
      // (the previous default) since it requires the scratch volume to
      // fit the archive — large PVCs would OOM the scratch anyway.
      activeDeadlineSeconds: streamEnvelope ? Math.floor(timeoutMs / 1000) : 1800,
      template: {
        metadata: { labels: { 'platform.io/component': 'snapshot', 'platform.io/tenant-id': opts.tenantId, 'platform.io/pipeline': streamEnvelope ? 'streaming-rclone' : 'legacy' } },
        spec: {
          restartPolicy: 'Never',
          // Snapshot Jobs MUST run in the tenant namespace because they
          // mount the tenant PVC. Tag with the overhead priority class
          // so they don't count against the tenant's ResourceQuota.
          priorityClassName: 'platform-tenant-overhead',
          containers: [{
            name: streamEnvelope ? 'rclone' : 'tar',
            image: jobImage,
            imagePullPolicy: 'IfNotPresent',
            command,
            env: containerEnv,
            resources,
            volumeMounts: containerVolumeMounts,
          }],
          volumes: podVolumes,
        },
      },
    },
  };

  await (k8s.batch as unknown as {
    createNamespacedJob: (args: { namespace: string; body: unknown }) => Promise<unknown>;
  }).createNamespacedJob({ namespace: opts.namespace, body: jobBody });

  // Poll Job status until complete or timeout.
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const job = await (k8s.batch as unknown as {
      readNamespacedJob: (args: { name: string; namespace: string }) => Promise<{
        status?: {
          conditions?: Array<{ type: string; status: string }>;
          succeeded?: number;
          failed?: number;
        };
      }>;
    }).readNamespacedJob({ name: jobName, namespace: opts.namespace });

    const status = job.status ?? {};
    const completed = (status.conditions ?? []).find((c) => c.type === 'Complete' && c.status === 'True');
    const failed = (status.conditions ?? []).find((c) => c.type === 'Failed' && c.status === 'True');
    if (completed || (status.succeeded ?? 0) > 0) break;
    if (failed || (status.failed ?? 0) > 0) {
      throw new Error(`snapshotTenantPVC: Job ${jobName} failed`);
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`snapshotTenantPVC: Job ${jobName} timed out after ${timeoutMs}ms`);
    }
    if (opts.onProgress) {
      const { tailJobLog } = await import('./job-log-tail.js');
      const tail = await tailJobLog(k8s, opts.namespace, jobName);
      if (tail) await opts.onProgress(`snapshot: ${tail}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

  // Delete the Job (and its pod) explicitly. Even though the Job's
  // ttlSecondsAfterFinished would GC it in 10 min, a subsequent
  // resize/archive step wants to delete the source PVC immediately
  // and the pvc-protection finalizer blocks PVC delete while any pod
  // (even Completed) holds a mount. Propagation=Background so we
  // don't wait for the pod to be terminated — the PVC delete's
  // waitForPvcGone poll absorbs the short delay.
  try {
    await (k8s.batch as unknown as {
      deleteNamespacedJob: (args: { name: string; namespace: string; propagationPolicy?: string }) => Promise<unknown>;
    }).deleteNamespacedJob({ name: jobName, namespace: opts.namespace, propagationPolicy: 'Background' });
  } catch { /* best-effort — if it already GC'd, that's fine */ }

  // Stat the resulting archive. Two pods share the hostPath mount but
  // the consumer side's dentry cache can lag behind the writer for a
  // few seconds after the Job completes — retry briefly before giving
  // up. This is not a correctness issue; the file does exist.
  let statResult: { sizeBytes: number } | null = null;
  for (let attempt = 0; attempt < 15; attempt++) {
    statResult = await opts.store.stat(archivePath);
    if (statResult && statResult.sizeBytes > 0) break;
    console.warn(`[snapshot] stat attempt ${attempt + 1}/15 for ${archivePath}: ${statResult ? `size=${statResult.sizeBytes}` : 'missing'}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!statResult) {
    throw new Error(`snapshotTenantPVC: archive missing after Job completed: ${archivePath}`);
  }

  // Pick up the sha256 the Job wrote to a `.sha256` sidecar. Best-effort:
  // on older hostpath stores the sidecar may be missing, in which case
  // we persist null (still a valid snapshot, just not content-addressable).
  let sha256: string | null = null;
  try {
    const raw = await opts.store.readSidecar(archivePath, '.sha256');
    if (raw) {
      // `sha256sum` emits "<hex>  <filename>\n"; extract just the hex.
      sha256 = raw.split(/\s+/)[0] || null;
    }
  } catch (err) {
    console.warn(`[snapshot] sidecar read failed for ${archivePath}: ${(err as Error).message}`);
  }

  return {
    archivePath,
    sizeBytes: statResult.sizeBytes,
    sha256,
  };
}
