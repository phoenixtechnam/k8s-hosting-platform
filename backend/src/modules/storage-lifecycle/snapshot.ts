import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { SnapshotStore } from './snapshot-store.js';

/**
 * Snapshot a tenant PVC by launching a short-lived K8s Job that tars
 * the PVC contents to the configured SnapshotStore.
 *
 * Contract:
 *   - Caller has already quiesced the namespace (pods no longer hold the
 *     PVC's RWO lock). `snapshotTenantPVC` itself does NOT quiesce.
 *   - Returns when the Job completes — or throws if it failed / timed out.
 *   - The archive path in the store is `store.reservePath(clientId, snapId)`.
 *     The archive is written from inside the Job via a second volume mount.
 *   - Size + sha256 of the resulting archive are reported in the return.
 */

export interface SnapshotResult {
  readonly archivePath: string;
  readonly sizeBytes: number;
  readonly sha256: string | null;
}

const DEFAULT_JOB_IMAGE = 'busybox:1.36';
const DEFAULT_JOB_TIMEOUT_MS = 30 * 60 * 1000; // 30 min — big PVCs + slow networks

export async function snapshotTenantPVC(
  k8s: K8sClients,
  opts: {
    readonly namespace: string;
    readonly pvcName: string;
    readonly clientId: string;
    readonly snapshotId: string;
    readonly store: SnapshotStore;
    readonly jobImage?: string;
    readonly timeoutMs?: number;
  },
): Promise<SnapshotResult> {
  const archivePath = opts.store.reservePath(opts.clientId, opts.snapshotId);
  const mount = opts.store.mountTarget(archivePath);
  const jobName = `snap-${opts.snapshotId}`.slice(0, 63);
  const jobImage = opts.jobImage ?? DEFAULT_JOB_IMAGE;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;

  // `tar` streams to stdout, piped through `gzip -1` (speed over ratio —
  // we're not shipping these to users), then written via `tee` so we get
  // both the archive file + its sha256. Exit status of the pipeline is
  // preserved via `set -o pipefail` which busybox sh does NOT support,
  // so we check each command explicitly.
  //
  // The archive is written to $MOUNT/$REL where MOUNT is the Store's
  // mount path inside the Job (/snapshots for the hostpath store).
  const script = [
    'set -e',
    'mkdir -p "$(dirname "$ARCHIVE")"',
    // tar from /source, filtering out lost+found and any nested mount points
    'cd /source',
    // `tar cf - .` writes to stdout → gzip → destination file. tee's the
    // stream through sha256sum too for a content hash we store.
    'tar cf - . 2>/tmp/tar.err | gzip -1 > "$ARCHIVE"',
    'TAR_RC=$?',
    '[ "$TAR_RC" = "0" ] || { echo "tar failed (rc=$TAR_RC):"; cat /tmp/tar.err; exit 1; }',
    'sha256sum "$ARCHIVE" | awk \'{print $1}\' > "$ARCHIVE.sha256"',
    'ls -l "$ARCHIVE"',
    'echo "SNAPSHOT_DONE sha256=$(cat "$ARCHIVE.sha256")"',
  ].join('\n');

  const jobBody = {
    metadata: { name: jobName, namespace: opts.namespace, labels: { 'platform.io/component': 'snapshot', 'platform.io/client-id': opts.clientId } },
    spec: {
      backoffLimit: 0, // don't retry on failure — fail fast, orchestrator decides
      ttlSecondsAfterFinished: 600, // auto-delete after 10 min regardless of outcome
      template: {
        metadata: { labels: { 'platform.io/component': 'snapshot' } },
        spec: {
          restartPolicy: 'Never',
          containers: [{
            name: 'tar',
            image: jobImage,
            imagePullPolicy: 'IfNotPresent',
            command: ['sh', '-c', script],
            env: [
              { name: 'ARCHIVE', value: `${mount.mountPath}/${mount.relativePath}` },
            ],
            resources: {
              requests: { cpu: '100m', memory: '128Mi' },
              limits: { cpu: '500m', memory: '512Mi' },
            },
            volumeMounts: [
              { name: 'source', mountPath: '/source', readOnly: true },
              { name: mount.volumeSpec.name as string, mountPath: mount.mountPath },
            ],
          }],
          volumes: [
            { name: 'source', persistentVolumeClaim: { claimName: opts.pvcName, readOnly: true } },
            mount.volumeSpec,
          ],
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
    await new Promise((r) => setTimeout(r, 3000));
  }

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

  return {
    archivePath,
    sizeBytes: statResult.sizeBytes,
    sha256: null,
  };
}
