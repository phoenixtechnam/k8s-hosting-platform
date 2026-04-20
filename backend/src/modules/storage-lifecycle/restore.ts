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
  },
): Promise<void> {
  const mount = opts.store.mountTarget(opts.archivePath);
  const jobName = `restore-${opts.snapshotId}`.slice(0, 63);
  const jobImage = opts.jobImage ?? DEFAULT_JOB_IMAGE;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;

  // Extract into /target. The tarball was written relative to /source
  // so its entries are `./applications/...`, `./databases/...`, etc.
  const script = [
    'set -e',
    '[ -f "$ARCHIVE" ] || { echo "archive not found: $ARCHIVE"; exit 1; }',
    'cd /target',
    // tar verbosity left off by default to keep logs small; enable via
    // VERBOSE=1 env if debugging. Using --numeric-owner preserves the
    // uid/gid mapping exactly as the source pods wrote (www-data, mysql,
    // postgres, ...), which matters because platform containers run as
    // those same uids and the orchestrator sets the target PVC perms
    // from init-dirs at next pod start.
    'tar xzf "$ARCHIVE" --numeric-owner 2>/tmp/tar.err',
    'TAR_RC=$?',
    '[ "$TAR_RC" = "0" ] || { echo "tar failed (rc=$TAR_RC):"; cat /tmp/tar.err; exit 1; }',
    'echo "RESTORE_DONE"',
  ].join('\n');

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
            ],
            resources: {
              requests: { cpu: '100m', memory: '128Mi' },
              limits: { cpu: '500m', memory: '512Mi' },
            },
            volumeMounts: [
              { name: 'target', mountPath: '/target' },
              { name: mount.volumeSpec.name as string, mountPath: mount.mountPath, readOnly: true },
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
    if (completed || (status.succeeded ?? 0) > 0) return;
    if (failed || (status.failed ?? 0) > 0) throw new Error(`restoreTenantPVC: Job ${jobName} failed`);
    if (Date.now() - start > timeoutMs) throw new Error(`restoreTenantPVC: Job ${jobName} timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}
