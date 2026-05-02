/**
 * `files` component capture (Phase 3).
 *
 * Pattern: HTTP-upload-from-tenant-Job-to-platform-api.
 *
 *   The capture Job runs in the *tenant* namespace because it must
 *   mount the tenant data PVC. The bundle's off-site target lives in
 *   the platform namespace (S3 / SSH config rows in `backup_configurations`).
 *   k8s does NOT support cross-namespace PVC sharing, so the Job
 *   cannot write directly into a PVC the platform-api manages.
 *
 *   Instead, the Job tars + gzips the PVC contents and POSTs the
 *   stream over HTTP to a new internal endpoint on platform-api
 *   (`/api/v1/internal/bundles/:id/components/:component/:artifact`).
 *   The endpoint authenticates via a short-lived HMAC token issued by
 *   the orchestrator, bound to the (bundleId, component, artifact)
 *   tuple, and streams the request body straight into
 *   BackupStore.writeComponent. No buffering on the platform-api side.
 *
 *   Two HTTP uploads happen per files-component capture:
 *     1. archive.tar.gz   (large)
 *     2. tree.jsonl.gz    (tens of KB; per-file path/size/mode/mtime
 *        lines, used by Phase-4 file-tree restore UI)
 *
 *   Each upload uses its own HMAC token. Tokens expire after 30 min
 *   so a stuck Job can't replay forever.
 *
 * Tradeoffs:
 *   + Works uniformly for S3 + SSH targets (the platform-api streams
 *     to whichever BackupStore is configured).
 *   + Keeps SSH key out of the tenant Job entirely.
 *   - Bytes traverse platform-api once. For large tenant PVCs this
 *     adds I/O on the backend pod. Acceptable for now; can optimise
 *     to a Job→S3-presigned-URL fast-path in a later phase.
 */

import type { K8sClients } from '../../k8s-provisioner/k8s-client.js';
import type { BackupStore, BundleHandle } from '../bundle-store.js';
import { componentDir } from '../meta.js';
import { tailJobLog } from '../../storage-lifecycle/job-log-tail.js';
import { signUploadToken } from '../upload-token.js';

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
  /** Internal cluster URL of platform-api (e.g. http://platform-api.platform.svc:3000). */
  readonly platformApiUrl: string;
  /** HMAC key used to sign the upload token. Same OIDC_ENCRYPTION_KEY. */
  readonly secretsKeyHex: string;
  readonly jobImage?: string;
  readonly timeoutMs?: number;
  readonly onProgress?: (msg: string) => Promise<void> | void;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 min for the largest PVCs
const UPLOAD_TOKEN_TTL_SEC = 30 * 60; // matches Job timeout

const ARCHIVE_FILENAME = 'archive.tar.gz';
const TREE_FILENAME = 'tree.jsonl.gz';

function buildScript(opts: { uploadBase: string; archiveToken: string; treeToken: string }): string {
  // The Job script:
  //   1. tar+gzip /source → /tmp/archive.tar.gz, computing sha256 alongside
  //   2. find /source → /tmp/tree.tsv, awk into JSONL, gzip → /tmp/tree.jsonl.gz
  //   3. curl PUT both files with HMAC tokens. The internal endpoint
  //      validates the token + streams the body to BackupStore.
  //   4. echo FILES_DONE + FILES_TREE_COUNT for the orchestrator to parse
  //
  // alpine image — busybox tar + curl + sha256sum + awk all available.
  return [
    'set -e',
    'cd /source',
    'echo "Tarballing tenant PVC..."',
    'tar cf - . 2>/tmp/tar.err | gzip -1 > /tmp/archive.tar.gz',
    'TAR_RC=$?',
    '[ "$TAR_RC" = "0" ] || { echo "tar failed (rc=$TAR_RC):"; cat /tmp/tar.err; exit 1; }',
    'sha256sum /tmp/archive.tar.gz | awk \'{print $1}\' > /tmp/archive.sha256',
    'echo "Building tree index..."',
    'find . -type f -printf \'%p\\t%s\\t%m\\t%T@\\n\' > /tmp/tree.tsv',
    'awk -F"\\t" \'{ ' +
      'gsub(/\\\\/, "\\\\\\\\", $1); ' +
      'gsub(/\\"/, "\\\\\\"", $1); ' +
      'cmd = "date -u -d @"$4" +%Y-%m-%dT%H:%M:%SZ"; ' +
      'cmd | getline mt; close(cmd); ' +
      'printf "{\\"path\\":\\"%s\\",\\"size\\":%s,\\"mode\\":%s,\\"mtime\\":\\"%s\\"}\\n", $1, $2, $3, mt; ' +
    '}\' /tmp/tree.tsv | gzip -1 > /tmp/tree.jsonl.gz',
    'TREE_COUNT=$(wc -l < /tmp/tree.tsv)',
    'echo "FILES_TREE_COUNT=$TREE_COUNT"',
    // Ensure curl is present. alpine:3.20 ships without curl; install
    // on demand. If apk fails (network partition to the Alpine CDN),
    // surface a clear error rather than the confusing "curl: not
    // found" we'd otherwise emit.
    'command -v curl >/dev/null 2>&1 || apk add --no-cache curl >/dev/null 2>&1 || { echo "ERROR: curl unavailable and apk install failed"; exit 1; }',
    'echo "Uploading archive.tar.gz..."',
    // --upload-file streams from disk; --data-binary @file would
    // read the whole archive into memory and OOM the 512Mi Job pod
    // on any non-trivial PVC. Phase-3 review HIGH catch.
    `curl --fail-with-body -sS --upload-file /tmp/archive.tar.gz \\\n      -H "Content-Type: application/gzip" \\\n      "${opts.uploadBase}/${ARCHIVE_FILENAME}?token=${opts.archiveToken}"`,
    'echo "Uploading tree.jsonl.gz..."',
    `curl --fail-with-body -sS --upload-file /tmp/tree.jsonl.gz \\\n      -H "Content-Type: application/gzip" \\\n      "${opts.uploadBase}/${TREE_FILENAME}?token=${opts.treeToken}"`,
    'echo "FILES_DONE sha256=$(cat /tmp/archive.sha256) size=$(stat -c%s /tmp/archive.tar.gz)"',
  ].join('\n');
}

/**
 * Build the K8s Job spec for the files-component capture.
 *
 * Pure function — exposed so unit tests can assert on the spec
 * without spinning up a kube client.
 */
export function buildFilesComponentJobSpec(input: {
  jobName: string;
  namespace: string;
  pvcName: string;
  clientId: string;
  backupId: string;
  jobImage: string;
  uploadBase: string;
  archiveToken: string;
  treeToken: string;
}): Record<string, unknown> {
  const script = buildScript({
    uploadBase: input.uploadBase,
    archiveToken: input.archiveToken,
    treeToken: input.treeToken,
  });
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
              // emptyDir for tar/tree intermediate files. Sized
              // generously — a Phase-3 follow-up will tie this to
              // the client's plan.max_backup_size_bytes.
              { name: 'scratch', mountPath: '/tmp' },
            ],
          }],
          volumes: [
            { name: 'source', persistentVolumeClaim: { claimName: input.pvcName, readOnly: true } },
            { name: 'scratch', emptyDir: { sizeLimit: '50Gi' } },
          ],
        },
      },
    },
  };
}

/**
 * Capture the `files` component.
 *
 * Generates two HMAC tokens (archive + tree), spawns the tar+gzip+
 * upload Job, polls until completion. After Job returns we stat the
 * artifact through the BackupStore (which is what actually received
 * the bytes) to get authoritative size + sha256.
 */
export async function captureFilesComponent(
  opts: CaptureFilesComponentOpts,
): Promise<FilesComponentResult> {
  const archiveToken = signUploadToken(
    { bundleId: opts.backupId, component: 'files', artifactName: ARCHIVE_FILENAME, ttlSeconds: UPLOAD_TOKEN_TTL_SEC },
    opts.secretsKeyHex,
  );
  const treeToken = signUploadToken(
    { bundleId: opts.backupId, component: 'files', artifactName: TREE_FILENAME, ttlSeconds: UPLOAD_TOKEN_TTL_SEC },
    opts.secretsKeyHex,
  );

  const uploadBase = `${opts.platformApiUrl.replace(/\/$/, '')}/api/v1/internal/bundles/${opts.backupId}/components/files`;
  const jobName = `bk-files-${opts.backupId}`.slice(0, 63);
  const spec = buildFilesComponentJobSpec({
    jobName,
    namespace: opts.namespace,
    pvcName: opts.pvcName,
    clientId: opts.clientId,
    backupId: opts.backupId,
    jobImage: opts.jobImage ?? 'alpine:3.20',
    uploadBase,
    archiveToken,
    treeToken,
  });

  await (opts.k8s.batch as unknown as {
    createNamespacedJob: (args: { namespace: string; body: unknown }) => Promise<unknown>;
  }).createNamespacedJob({ namespace: opts.namespace, body: spec });

  await waitForJob(opts.k8s, opts.namespace, jobName, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, opts.onProgress);

  // Stat the archive via the store — this is the authoritative size.
  // sha256 came from the upload sidecar but the store doesn't know
  // about it; the Job emitted it in its log line which we parse below.
  const archiveStat = await opts.store.stat(opts.handle, 'files', ARCHIVE_FILENAME);
  if (!archiveStat) {
    throw new Error(`files-component: archive missing on remote target after Job completion (jobName=${jobName})`);
  }

  const log = await readEndOfJobLog(opts.k8s, opts.namespace, jobName);
  const sha = parseFilesDoneSha(log) ?? '';
  const fileCount = parseTreeCount(log);

  if (!sha) {
    throw new Error(`files-component: could not parse sha256 from Job log (jobName=${jobName})`);
  }

  return {
    sha256: sha,
    sizeBytes: archiveStat.sizeBytes,
    fileCount,
  };
}

async function readEndOfJobLog(k8s: K8sClients, namespace: string, jobName: string): Promise<string> {
  try {
    const last = await tailJobLog(k8s, namespace, jobName, { tailLines: 30, maxLineLength: 5000 });
    return last ?? '';
  } catch {
    return '';
  }
}

function parseFilesDoneSha(log: string): string | null {
  const m = log.match(/FILES_DONE sha256=([0-9a-f]{64})/);
  return m ? m[1]! : null;
}

function parseTreeCount(log: string): number {
  const m = log.match(/FILES_TREE_COUNT=(\d+)/);
  return m ? Number(m[1]) : 0;
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
