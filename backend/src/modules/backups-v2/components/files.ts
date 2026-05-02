/**
 * `files` component capture.
 *
 * Per BACKUP_COMPONENT_MODEL.md:
 *   components/files/archive.tar.gz       — tar of the tenant PVC contents
 *   components/files/archive.tar.gz.sha256 — sha-256 sidecar
 *   components/files/tree.jsonl.gz        — per-file path/size/mode/mtime index
 *
 * The tree index powers the file-browser UI in the granular restore path
 * (Phase 4). One JSON-Lines record per path:
 *
 *   {"path":"/wp-config.php","size":5922,"mode":33188,"mtime":"2026-04-20T17:49:00Z"}
 *
 * The Job emits both the archive AND the tree in a single pass — `tar -tvf`
 * after the archive write is cheap and stays consistent with the snapshot
 * (no race against pod restarts modifying the PVC).
 *
 * Wiring rules:
 *   - For `hostpath` BackupStore the Job mounts the bundle dir directly
 *     and writes both artifacts in place.
 *   - For `s3` BackupStore the Job uploads via presigned PUT URLs.
 *   - For `ssh` BackupStore: out of scope (Phase 3, see ssh-backup-store.ts).
 *
 * The bundle handle's _backend tells the orchestrator which path to take.
 */

import type { K8sClients } from '../../k8s-provisioner/k8s-client.js';
import type { BackupStore, BundleHandle } from '../bundle-store.js';
import { componentDir } from '../meta.js';
import { tailJobLog } from '../../storage-lifecycle/job-log-tail.js';

export interface FilesComponentResult {
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly fileCount: number;
}

export interface CaptureFilesComponentOpts {
  readonly k8s: K8sClients;
  readonly namespace: string;
  readonly pvcName: string;
  readonly clientId: string;
  readonly backupId: string;
  readonly store: BackupStore;
  readonly handle: BundleHandle;
  /** Hostpath bundle directory the Job mounts. Required for hostpath store.
   *  The orchestrator passes the path it got back from `reserveBundle` so
   *  the components layer never needs to inspect `handle._backend`. */
  readonly bundleDir?: string;
  /** Hostpath root volume for the Job mount (e.g. /var/lib/platform/bundles).
   *  Required for hostpath store. */
  readonly hostpathRoot?: string;
  readonly jobImage?: string;
  readonly timeoutMs?: number;
  readonly onProgress?: (msg: string) => Promise<void> | void;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 min

/**
 * The Job script — emits archive + sha256 + tree.jsonl.gz in one pass.
 *
 * Implementation notes:
 *   - The tar pass produces the archive.
 *   - A `find` walk + `stat -c` produces the tree.jsonl. We don't reuse
 *     `tar -tvf` because parsing tar's output is fragile across busybox/
 *     GNU tar versions; `find` + `stat` is rock-solid.
 *   - mtimes are in RFC3339 to match meta.json's `capturedAt` style.
 */
function buildScript(opts: { archivePath: string; treePath: string; sha256SidecarPath: string }): string {
  const lines = [
    'set -e',
    `mkdir -p "$(dirname "${opts.archivePath}")"`,
    `mkdir -p "$(dirname "${opts.treePath}")"`,
    'cd /source',
    `tar cf - . 2>/tmp/tar.err | gzip -1 > "${opts.archivePath}"`,
    'TAR_RC=$?',
    `[ "$TAR_RC" = "0" ] || { echo "tar failed (rc=$TAR_RC):"; cat /tmp/tar.err; exit 1; }`,
    `sha256sum "${opts.archivePath}" | awk '{print $1}' > "${opts.sha256SidecarPath}"`,
    'echo "Building tree index…"',
    // Walk the source PVC, emit one JSONL record per file. We escape
    // the path with sed to keep JSON valid for the most common path
    // characters (backslash + double-quote).
    'find . -type f -printf \'%p\\t%s\\t%m\\t%T@\\n\' > /tmp/tree.tsv',
    'awk -F"\\t" \'{ ' +
      'gsub(/\\\\/, "\\\\\\\\", $1); ' +
      'gsub(/\\"/, "\\\\\\"", $1); ' +
      'cmd = "date -u -d @"$4" +%Y-%m-%dT%H:%M:%SZ"; ' +
      'cmd | getline mt; close(cmd); ' +
      'printf "{\\"path\\":\\"%s\\",\\"size\\":%s,\\"mode\\":%s,\\"mtime\\":\\"%s\\"}\\n", $1, $2, $3, mt; ' +
    '}\' /tmp/tree.tsv | gzip -1 > "' + opts.treePath + '"',
    `wc -l /tmp/tree.tsv | awk '{print "FILES_TREE_COUNT="$1}'`,
    `ls -l "${opts.archivePath}" "${opts.treePath}"`,
    `echo "FILES_DONE sha256=$(cat "${opts.sha256SidecarPath}")"`,
  ];
  return lines.join('\n');
}

/**
 * Build the K8s Job spec for the files-component capture.
 *
 * Pure function — exposed so unit tests can assert on the spec without
 * spinning up a kube client.
 */
export function buildFilesComponentJobSpec(input: {
  jobName: string;
  namespace: string;
  pvcName: string;
  clientId: string;
  backupId: string;
  jobImage: string;
  hostMount: { volumeSpec: Record<string, unknown>; mountPath: string };
  archiveRelative: string;
  treeRelative: string;
}): Record<string, unknown> {
  const archivePath = `${input.hostMount.mountPath}/${input.archiveRelative}`;
  const treePath = `${input.hostMount.mountPath}/${input.treeRelative}`;
  const sha256SidecarPath = `${archivePath}.sha256`;
  const script = buildScript({ archivePath, treePath, sha256SidecarPath });
  return {
    metadata: {
      name: input.jobName,
      namespace: input.namespace,
      labels: {
        'platform.io/component': 'backup-files',
        'platform.io/client-id': input.clientId,
        'platform.io/backup-id': input.backupId,
      },
    },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 600,
      template: {
        metadata: {
          labels: {
            'platform.io/component': 'backup-files',
            'platform.io/client-id': input.clientId,
            'platform.io/backup-id': input.backupId,
          },
        },
        spec: {
          restartPolicy: 'Never',
          priorityClassName: 'platform-tenant-overhead',
          containers: [{
            name: 'files',
            image: input.jobImage,
            imagePullPolicy: 'IfNotPresent',
            command: ['sh', '-c', script],
            resources: {
              requests: { cpu: '100m', memory: '128Mi' },
              limits: { cpu: '500m', memory: '512Mi' },
            },
            volumeMounts: [
              { name: 'source', mountPath: '/source', readOnly: true },
              { name: input.hostMount.volumeSpec.name as string, mountPath: input.hostMount.mountPath },
            ],
          }],
          volumes: [
            { name: 'source', persistentVolumeClaim: { claimName: input.pvcName, readOnly: true } },
            input.hostMount.volumeSpec,
          ],
        },
      },
    },
  };
}

/**
 * Capture the `files` component of a backup.
 *
 * **Hostpath store path** (the only path wired today; S3 + SSH are
 * orchestrator-side stubs that throw `FILES_COMPONENT_BACKEND_PENDING`).
 *
 * Spawns a single Job that writes archive.tar.gz + tree.jsonl.gz into the
 * bundle dir on the hostpath volume. Polls the Job until it completes,
 * then reads the size + sha256 back via the BackupStore interface.
 */
export async function captureFilesComponent(
  opts: CaptureFilesComponentOpts,
): Promise<FilesComponentResult> {
  // Phase 2 limitation: the bundle store now lives on a Longhorn RWX
  // PVC in the `platform` namespace, but the files-component Job
  // historically ran in the *tenant* namespace (so it can mount the
  // tenant data PVC). Cross-namespace PVC sharing isn't supported in
  // k8s, so the Job can't directly write into the platform-bundles
  // volume. Phase 3 will rework this to either:
  //   (a) stream the tar via HTTP from the Job back to platform-api
  //       (which writes to the PVC in-process via writeComponent), or
  //   (b) mount a second per-tenant RWX volume and have platform-api
  //       copy the artifact across after the Job finishes.
  // Until that lands, the orchestrator must call captureFilesComponent
  // only with components.files=false (the integration test honours
  // this; the admin UI for Phase 2 surfaces the toggle).
  const err = new Error(
    'files component capture is deferred to Phase 3 (cross-namespace PVC limitation). ' +
    'Set components.files=false on the bundle request.',
  );
  (err as Error & { code?: string }).code = 'FILES_COMPONENT_PHASE_3_PENDING';
  throw err;
}

async function readFileCountFromJobLog(k8s: K8sClients, namespace: string, jobName: string): Promise<number> {
  try {
    // Pull the last ~30 lines so we catch FILES_TREE_COUNT=N in the
    // Job's stdout regardless of how chatty awk was.
    const last = await tailJobLog(k8s, namespace, jobName, { tailLines: 30, maxLineLength: 5000 });
    if (!last) return 0;
    const m = last.match(/FILES_TREE_COUNT=(\d+)/);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

async function waitForJob(
  k8s: K8sClients,
  namespace: string,
  jobName: string,
  timeoutMs: number,
  onProgress?: (msg: string) => Promise<void> | void,
): Promise<void> {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const job = await (k8s.batch as unknown as {
      readNamespacedJob: (args: { name: string; namespace: string }) => Promise<{
        status?: {
          conditions?: Array<{ type: string; status: string; reason?: string; message?: string }>;
          succeeded?: number;
          failed?: number;
        };
      }>;
    }).readNamespacedJob({ name: jobName, namespace });

    const status = job.status ?? {};
    const completed = (status.conditions ?? []).find((c) => c.type === 'Complete' && c.status === 'True');
    const failed = (status.conditions ?? []).find((c) => c.type === 'Failed' && c.status === 'True');
    if (completed || (status.succeeded ?? 0) > 0) return;
    if (failed || (status.failed ?? 0) > 0) {
      const msg = failed?.message ?? 'Job failed';
      throw new Error(`files-component Job ${jobName} failed: ${msg}`);
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`files-component Job ${jobName} timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    if (onProgress) await onProgress('Capturing files…');
    await new Promise((res) => setTimeout(res, 3000));
  }
}
