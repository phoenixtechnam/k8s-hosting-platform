import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { SnapshotStore } from './snapshot-store.js';

/**
 * Extract a tarball from the SnapshotStore into a freshly-created PVC.
 *
 * Contract:
 *   - Target PVC is already applied (new size, RWO, same name as before).
 *   - No workloads yet bound to it (orchestrator unquiesces only AFTER
 *     restore completes).
 *   - Job runs a single container that mounts the new PVC at /target
 *     and the snapshot store at /snapshots, then `tar xzf` streams the
 *     archive back into place.
 */

const DEFAULT_JOB_IMAGE = 'busybox:1.36';
const DEFAULT_JOB_TIMEOUT_MS = 30 * 60 * 1000;

export async function restoreTenantPVC(
  k8s: K8sClients,
  opts: {
    readonly namespace: string;
    readonly pvcName: string;
    readonly clientId: string;
    readonly snapshotId: string;
    readonly archivePath: string;
    readonly store: SnapshotStore;
    readonly jobImage?: string;
    readonly timeoutMs?: number;
    /** Live progress callback — see snapshot.ts for rationale. */
    readonly onProgress?: (msg: string) => Promise<void> | void;
  },
): Promise<void> {
  const mount = opts.store.mountTarget(opts.archivePath);
  const jobName = `restore-${opts.snapshotId}`.slice(0, 63);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;

  // S3 detection — use a presigned GET URL for the download instead
  // of mounting a hostPath that doesn't exist on this node.
  interface S3StoreLike { getDownloadUrl(p: string): Promise<string> }
  const s3 = (opts.store as unknown as S3StoreLike);
  const isS3 = typeof s3.getDownloadUrl === 'function';
  const s3DownloadUrl = isS3 ? await s3.getDownloadUrl(opts.archivePath) : null;
  const jobImage = opts.jobImage ?? (isS3 ? 'alpine:3.20' : DEFAULT_JOB_IMAGE);

  // Extract into /target. For S3 we curl the archive into the scratch
  // emptyDir first, then tar. For hostpath the mount already provides
  // the file at $ARCHIVE.
  const baseScript = [
    'set -e',
    ...(isS3 ? [
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
  const script = baseScript.join('\n');

  const jobBody = {
    metadata: { name: jobName, namespace: opts.namespace, labels: { 'platform.io/component': 'restore', 'platform.io/client-id': opts.clientId } },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 600,
      template: {
        metadata: { labels: { 'platform.io/component': 'restore' } },
        spec: {
          restartPolicy: 'Never',
          containers: [{
            name: 'tar',
            image: jobImage,
            imagePullPolicy: 'IfNotPresent',
            command: ['sh', '-c', script],
            env: [
              { name: 'ARCHIVE', value: `${mount.mountPath}/${mount.relativePath}` },
              ...(s3DownloadUrl ? [{ name: 'S3_DOWNLOAD_URL', value: s3DownloadUrl }] : []),
            ],
            resources: {
              requests: { cpu: '100m', memory: '128Mi' },
              limits: { cpu: '500m', memory: '512Mi' },
            },
            volumeMounts: [
              { name: 'target', mountPath: '/target' },
              // S3 mode: scratch emptyDir, must be writable so curl can
              // download. hostpath: shared store mounted RO.
              { name: mount.volumeSpec.name as string, mountPath: mount.mountPath, readOnly: !isS3 },
            ],
          }],
          volumes: [
            { name: 'target', persistentVolumeClaim: { claimName: opts.pvcName } },
            mount.volumeSpec,
          ],
        },
      },
    },
  };

  await (k8s.batch as unknown as {
    createNamespacedJob: (args: { namespace: string; body: unknown }) => Promise<unknown>;
  }).createNamespacedJob({ namespace: opts.namespace, body: jobBody });

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
      // Same reasoning as snapshotTenantPVC.
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
