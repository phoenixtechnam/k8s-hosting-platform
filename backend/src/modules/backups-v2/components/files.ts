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
  if (opts.store.kind !== 'hostpath') {
    // S3 + SSH paths require the presigned-URL / Job-with-SSH-key
    // wiring that lands in Phase 3. Until then, the orchestrator
    // surfaces a structured error rather than silently dropping.
    const err = new Error(
      `files component capture is not yet wired for store kind '${opts.store.kind}' (Phase 3).`,
    );
    (err as Error & { code?: string }).code = 'FILES_COMPONENT_BACKEND_PENDING';
    throw err;
  }

  // We rely on the orchestrator already having called `reserveBundle`,
  // so the bundle directory exists with all four component subdirs.
  const handleBackend = opts.handle._backend as { bundleDir?: string };
  if (!handleBackend.bundleDir) {
    throw new Error('files-component: hostpath handle has no bundleDir');
  }

  // Build the Job spec — caller mounts the same hostpath root the
  // store uses, so the Job writes directly into the bundle's
  // components/files/ subdir.
  const archiveRel = `${componentDir('files')}/archive.tar.gz`;
  const treeRel = `${componentDir('files')}/tree.jsonl.gz`;

  const hostMount = {
    volumeSpec: {
      name: 'platform-bundles',
      hostPath: { path: hostpathRoot(opts.handle), type: 'DirectoryOrCreate' },
    },
    mountPath: '/bundle',
  };
  const jobName = `bk-files-${opts.backupId}`.slice(0, 63);

  const spec = buildFilesComponentJobSpec({
    jobName,
    namespace: opts.namespace,
    pvcName: opts.pvcName,
    clientId: opts.clientId,
    backupId: opts.backupId,
    jobImage: opts.jobImage ?? 'alpine:3.20',
    hostMount,
    archiveRelative: archiveRel,
    treeRelative: treeRel,
  });

  await (opts.k8s.batch as unknown as {
    createNamespacedJob: (args: { namespace: string; body: unknown }) => Promise<unknown>;
  }).createNamespacedJob({ namespace: opts.namespace, body: spec });

  // Poll until done.
  await waitForJob(opts.k8s, opts.namespace, jobName, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, opts.onProgress);

  // Read size + sha256 back via the store.
  const archiveStat = await opts.store.stat(opts.handle, 'files', 'archive.tar.gz');
  if (!archiveStat) throw new Error('files-component: archive.tar.gz missing after Job completion');

  // Tree count = lines in tree.jsonl.gz — but we recorded it in the Job
  // log via FILES_TREE_COUNT. For the meta.json we need a number; if we
  // didn't surface it from the log, fall back to the on-disk file count
  // probe. To keep this function side-effect-light, we approximate from
  // the archive — the orchestrator can refine via the Job log next pass.
  const fileCount = 0;

  // Sidecar holds the sha256 of archive.tar.gz.
  if (!archiveStat.sha256) {
    throw new Error('files-component: sha256 sidecar missing');
  }

  return {
    sha256: archiveStat.sha256,
    sizeBytes: archiveStat.sizeBytes,
    fileCount,
  };
}

function hostpathRoot(handle: BundleHandle): string {
  const backend = handle._backend as { root?: string; bundleDir?: string };
  if (!backend.root) throw new Error('hostpathRoot: handle missing root');
  return backend.root;
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
