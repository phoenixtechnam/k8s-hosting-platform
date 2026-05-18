import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { SnapshotStore } from './snapshot-store.js';
import type { StreamingSnapshotStore } from './streaming-store.js';

/**
 * Extract a tarball from the SnapshotStore into a freshly-created PVC.
 *
 * Contract:
 *   - Target PVC is already applied (new size, RWO, same name as before).
 *   - No workloads yet bound to it (orchestrator unquiesces only AFTER
 *     restore completes).
 *   - Job runs a single container that mounts the new PVC at /target.
 *     Streaming branch (Phase 5): `rclone cat | gunzip | tar x` — no
 *     local file. Legacy branch: `curl PUT to scratch → tar xzf`.
 */

const DEFAULT_JOB_IMAGE = 'busybox:1.36';
// Streaming restore can run for hours on large archives (500 GB / 50 Mbps
// download = 4h floor). 6h ceiling matches the snapshot Job.
const DEFAULT_JOB_TIMEOUT_MS = 6 * 60 * 60 * 1000;

function isStreamingStore(store: SnapshotStore): store is StreamingSnapshotStore {
  return typeof (store as Partial<StreamingSnapshotStore>).getStreamingRestoreJob === 'function';
}

export async function restoreTenantPVC(
  k8s: K8sClients,
  opts: {
    readonly namespace: string;
    readonly pvcName: string;
    readonly tenantId: string;
    readonly snapshotId: string;
    readonly archivePath: string;
    readonly store: SnapshotStore;
    readonly jobImage?: string;
    readonly timeoutMs?: number;
    /** Live progress callback — see snapshot.ts for rationale. */
    readonly onProgress?: (msg: string) => Promise<void> | void;
  },
): Promise<void> {
  const jobName = `restore-${opts.snapshotId}`.slice(0, 63);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;

  // Phase 5: streaming stores skip the legacy "curl PUT to scratch →
  // tar xzf" pattern entirely. `getStreamingRestoreJob` returns the
  // rclone | gunzip | tar pipeline + env config; the Job spec mounts
  // ONLY the target PVC (read-write).
  const streaming = isStreamingStore(opts.store);
  const streamEnvelope = streaming ? opts.store.getStreamingRestoreJob(opts.archivePath) : null;
  const mount = streaming ? null : opts.store.mountTarget(opts.archivePath);

  // Legacy S3 fallback (kept for pre-Phase-3 snapshot rows with
  // target_id = NULL — they were uploaded via the old emptyDir pattern
  // and resolve to a non-streaming S3Store). Duck-type on getDownloadUrl.
  interface S3StoreLike { getDownloadUrl(p: string): Promise<string> }
  const s3 = (opts.store as unknown as S3StoreLike);
  const isLegacyS3 = !streaming && typeof s3.getDownloadUrl === 'function';
  const s3DownloadUrl = isLegacyS3 ? await s3.getDownloadUrl(opts.archivePath) : null;

  const jobImage = opts.jobImage
    ?? (streamEnvelope ? streamEnvelope.image
        : isLegacyS3 ? 'alpine:3.20'
        : DEFAULT_JOB_IMAGE);

  // Three pipeline variants — same shape as snapshot.ts:
  //   1. Streaming (Phase 5) — rclone cat | gunzip | tar x, no scratch
  //   2. Legacy S3        — curl GET to scratch, then tar xzf
  //   3. Legacy hostpath  — tar xzf directly from mount
  const script = streamEnvelope
    ? streamEnvelope.script
    : (() => {
      const baseScript = [
        'set -e',
        ...(isLegacyS3 ? [
          'apk add --no-cache curl >/dev/null',
          'mkdir -p "$(dirname "$ARCHIVE")"',
          'echo "Downloading archive from S3 via presigned URL..."',
          'curl --fail-with-body -o "$ARCHIVE" "$S3_DOWNLOAD_URL"',
        ] : []),
        '[ -f "$ARCHIVE" ] || { echo "archive not found: $ARCHIVE"; exit 1; }',
        'cd /target',
        'tar xzf "$ARCHIVE" --numeric-owner 2>/tmp/tar.err',
        'TAR_RC=$?',
        '[ "$TAR_RC" = "0" ] || { echo "tar failed (rc=$TAR_RC):"; cat /tmp/tar.err; exit 1; }',
        'echo "RESTORE_DONE"',
      ];
      return baseScript.join('\n');
    })();

  // Phase 12: streaming branch — public env inline, credentials via
  // ephemeral Secret. Legacy branch unchanged.
  const containerEnv = streamEnvelope
    ? [
        { name: 'REMOTE_URI', value: streamEnvelope.remoteUri },
        ...streamEnvelope.publicEnv,
      ]
    : [
        { name: 'ARCHIVE', value: `${mount!.mountPath}/${mount!.relativePath}` },
        ...(s3DownloadUrl ? [{ name: 'S3_DOWNLOAD_URL', value: s3DownloadUrl }] : []),
      ];

  const containerVolumeMounts = streamEnvelope
    ? [{ name: 'target', mountPath: '/target' }]
    : [
        { name: 'target', mountPath: '/target' },
        // S3 mode: scratch emptyDir, must be writable so curl can
        // download. hostpath: shared store mounted RO.
        { name: mount!.volumeSpec.name as string, mountPath: mount!.mountPath, readOnly: !isLegacyS3 },
      ];

  const podVolumes = streamEnvelope
    ? [{ name: 'target', persistentVolumeClaim: { claimName: opts.pvcName } }]
    : [
        { name: 'target', persistentVolumeClaim: { claimName: opts.pvcName } },
        mount!.volumeSpec,
      ];

  // POSIX `sh` for both branches (rclone image is alpine, legacy is busybox/alpine).
  const command = ['sh', '-c', script];

  // Streaming restore: same 384 Mi ceiling as snapshot — rclone cat
  // multipart reader + RCLONE_BUFFER_SIZE 64 MB + gunzip + tar
  // working set ≈ 240 MB + Go overhead. 256 Mi was too tight under
  // S3 latency stalls; 384 Mi gives real headroom.
  const resources = streamEnvelope
    ? {
        requests: { cpu: '100m', memory: '128Mi' },
        limits: { cpu: '500m', memory: '384Mi' },
      }
    : {
        requests: { cpu: '100m', memory: '128Mi' },
        limits: { cpu: '500m', memory: '512Mi' },
      };

  // Phase 12 + 12.5: ephemeral env Secret + optional file Secret for
  // streaming restore Jobs (SSH PEM key).
  const {
    createEphemeralCredentialsSecret,
    attachOwnerToSecret,
    deleteSecretBestEffort,
    buildEnvFromSecret,
    credSecretNameFor,
    credFilesSecretNameFor,
    buildSecretFileMount,
  } = await import('./streaming-store.js');
  const credSecretName = streamEnvelope ? credSecretNameFor(jobName) : null;
  const filesSecretName = streamEnvelope ? credFilesSecretNameFor(jobName) : null;
  const hasSecretEnv = streamEnvelope && Object.keys(streamEnvelope.secretEnv).length > 0;
  const hasSecretFiles = streamEnvelope
    && !!streamEnvelope.secretFiles
    && Object.keys(streamEnvelope.secretFiles).length > 0;
  if (streamEnvelope && hasSecretEnv && credSecretName) {
    await createEphemeralCredentialsSecret(
      k8s as unknown as Parameters<typeof createEphemeralCredentialsSecret>[0],
      opts.namespace,
      credSecretName,
      streamEnvelope.secretEnv,
    );
  }
  if (streamEnvelope && hasSecretFiles && filesSecretName) {
    await createEphemeralCredentialsSecret(
      k8s as unknown as Parameters<typeof createEphemeralCredentialsSecret>[0],
      opts.namespace,
      filesSecretName,
      streamEnvelope.secretFiles!,
    );
  }
  const fileMount = (hasSecretFiles && filesSecretName)
    ? buildSecretFileMount(filesSecretName, streamEnvelope!.secretFiles!)
    : null;
  const containerVolumeMountsAll = fileMount
    ? [...containerVolumeMounts, fileMount.volumeMount]
    : containerVolumeMounts;
  const podVolumesAll = fileMount
    ? [...podVolumes, fileMount.volume]
    : podVolumes;

  const jobBody = {
    metadata: { name: jobName, namespace: opts.namespace, labels: { 'platform.io/component': 'restore', 'platform.io/tenant-id': opts.tenantId, 'platform.io/pipeline': streamEnvelope ? 'streaming-rclone' : 'legacy' } },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: streamEnvelope ? 3600 : 600,
      activeDeadlineSeconds: streamEnvelope ? Math.floor(timeoutMs / 1000) : 1800,
      template: {
        metadata: { labels: { 'platform.io/component': 'restore', 'platform.io/tenant-id': opts.tenantId, 'platform.io/pipeline': streamEnvelope ? 'streaming-rclone' : 'legacy' } },
        spec: {
          restartPolicy: 'Never',
          // Restore Jobs MUST run in the tenant namespace because they
          // mount the tenant PVC. Tag with the overhead priority class
          // so they don't count against the tenant's ResourceQuota.
          priorityClassName: 'platform-tenant-overhead',
          containers: [{
            name: streamEnvelope ? 'rclone' : 'tar',
            image: jobImage,
            imagePullPolicy: 'IfNotPresent',
            command,
            env: containerEnv,
            envFrom: (streamEnvelope && hasSecretEnv && credSecretName)
              ? buildEnvFromSecret(credSecretName)
              : undefined,
            resources,
            volumeMounts: containerVolumeMountsAll,
          }],
          volumes: podVolumesAll,
        },
      },
    },
  };

  let createdJobResp: unknown;
  try {
    createdJobResp = await (k8s.batch as unknown as {
      createNamespacedJob: (args: { namespace: string; body: unknown }) => Promise<unknown>;
    }).createNamespacedJob({ namespace: opts.namespace, body: jobBody });
  } catch (err) {
    if (credSecretName && hasSecretEnv) {
      await deleteSecretBestEffort(
        k8s as unknown as Parameters<typeof deleteSecretBestEffort>[0],
        opts.namespace,
        credSecretName,
      );
    }
    if (filesSecretName && hasSecretFiles) {
      await deleteSecretBestEffort(
        k8s as unknown as Parameters<typeof deleteSecretBestEffort>[0],
        opts.namespace,
        filesSecretName,
      );
    }
    throw err;
  }
  // Bind Secret(s) to the Job for cascade GC.
  const jobUid = ((createdJobResp as { body?: { metadata?: { uid?: string } } }).body?.metadata?.uid
    ?? (createdJobResp as { metadata?: { uid?: string } }).metadata?.uid);
  if (jobUid) {
    const owner = { name: jobName, uid: jobUid };
    if (credSecretName && hasSecretEnv) {
      await attachOwnerToSecret(
        k8s as unknown as Parameters<typeof attachOwnerToSecret>[0],
        opts.namespace,
        credSecretName,
        owner,
      ).catch(() => { /* cron picks up */ });
    }
    if (filesSecretName && hasSecretFiles) {
      await attachOwnerToSecret(
        k8s as unknown as Parameters<typeof attachOwnerToSecret>[0],
        opts.namespace,
        filesSecretName,
        owner,
      ).catch(() => { /* cron picks up */ });
    }
  }

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
    if (completed || (status.succeeded ?? 0) > 0) {
      // Delete the Job + its pod so nothing holds the PVC's RWO lock
      // by the time the orchestrator starts workloads back up.
      try {
        await (k8s.batch as unknown as {
          deleteNamespacedJob: (args: { name: string; namespace: string; propagationPolicy?: string }) => Promise<unknown>;
        }).deleteNamespacedJob({ name: jobName, namespace: opts.namespace, propagationPolicy: 'Background' });
      } catch { /* best-effort */ }
      return;
    }
    if (failed || (status.failed ?? 0) > 0) throw new Error(`restoreTenantPVC: Job ${jobName} failed`);
    if (Date.now() - start > timeoutMs) throw new Error(`restoreTenantPVC: Job ${jobName} timed out after ${timeoutMs}ms`);
    if (opts.onProgress) {
      const { tailJobLog } = await import('./job-log-tail.js');
      const tail = await tailJobLog(k8s, opts.namespace, jobName);
      if (tail) await opts.onProgress(`restore: ${tail}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}
