/**
 * `files` component capture (Phase 3 + 2026-05-07 streaming refactor).
 *
 * Pattern: HTTP-upload-from-tenant-Job-to-platform-api.
 *
 *   The capture Job runs in the *tenant* namespace because it must
 *   mount the tenant data PVC. The bundle's off-site target lives in
 *   the platform namespace (S3 / SSH config rows in `backup_configurations`).
 *   k8s does NOT support cross-namespace PVC sharing, so the Job
 *   cannot write directly into a PVC the platform-api manages.
 *
 *   Instead, the Job streams `tar | gzip | tee(sha256-via-fifo) |
 *   curl --upload-file -` straight to platform-api's internal upload
 *   endpoint (`/api/v1/internal/bundles/:id/components/:component/:artifact`).
 *   The archive NEVER lands on emptyDir — bytes flow PVC → tar → gzip
 *   → tee → curl → platform-api → S3 multipart in real time. Memory
 *   footprint stays ~tens of MiB regardless of PVC size; node disk
 *   stays clean. (Earlier revisions materialised the archive on a
 *   50 GiB emptyDir before upload; switching to streaming dropped the
 *   scratch volume to 1 GiB and removed the largest source of node
 *   disk pressure during a backup window.)
 *
 *   The internal-upload endpoint authenticates via a short-lived HMAC
 *   token issued by the orchestrator, bound to the (bundleId,
 *   component, artifact) tuple, and pipes the request body straight
 *   into BackupStore.writeComponent. No buffering on the platform-api
 *   side either.
 *
 *   Two HTTP uploads happen per files-component capture:
 *     1. archive.tar.gz   (large; streamed)
 *     2. tree.jsonl.gz    (tens of KB; per-file path/size/mode/mtime
 *        lines for the Phase-4 file-tree restore UI; small enough to
 *        stage on disk)
 *
 *   Each upload uses its own HMAC token. Tokens expire after 30 min
 *   so a stuck Job can't replay forever.
 *
 * Tradeoffs:
 *   + Works uniformly for S3 + SSH targets (the platform-api streams
 *     to whichever BackupStore is configured).
 *   + Keeps SSH key out of the tenant Job entirely.
 *   + No node-disk staging — backups of multi-GiB PVCs no longer
 *     pressure /var/lib/kubelet during the backup window.
 *   - Bytes traverse platform-api once. For large tenant PVCs this
 *     adds I/O on the backend pod. Acceptable for now; can optimise
 *     to a Job→S3-presigned-URL fast-path in a later phase.
 *   - Mid-stream upload failures cannot be retried without re-tar'ing
 *     the PVC. Bundle is tracked as a backup_jobs row → operator
 *     re-triggers the whole bundle; tar is idempotent against a PVC
 *     read-only mount.
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

/**
 * Outcome of `captureFilesComponent` when the PVC is missing.
 * The orchestrator translates this into `status='skipped'` on the
 * backup_components row instead of a partial bundle.
 */
export class FilesComponentSkippedError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'FilesComponentSkippedError';
  }
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 min for the largest PVCs
const UPLOAD_TOKEN_TTL_SEC = 30 * 60; // matches Job timeout
// K8s `activeDeadlineSeconds` is set to the orchestrator's poll
// timeout MINUS this buffer. That guarantees K8s flips the `Failed`
// condition first; the orchestrator's next poll iteration then
// reports a real reason ("DeadlineExceeded") instead of throwing a
// generic timeout error.
const JOB_DEADLINE_BUFFER_SEC = 60;

const ARCHIVE_FILENAME = 'archive.tar.gz';
const TREE_FILENAME = 'tree.jsonl.gz';

function buildScript(opts: { uploadBase: string; archiveToken: string; treeToken: string }): string {
  // The Job script (fully streaming, 2026-05-07):
  //   1. tar | gzip | tee(sha256-via-fifo) | curl --upload-file -
  //      The archive NEVER lands on emptyDir — bytes flow PVC → tar →
  //      gzip → tee → curl → platform-api → S3 multipart in real time.
  //      Memory footprint stays ~tens of MiB regardless of PVC size.
  //   2. find /source → /tmp/tree.tsv → awk → JSONL → gzip → tree.jsonl.gz
  //      (small, <100KB for typical PVCs; staying on disk is fine).
  //   3. curl PUT tree.jsonl.gz.
  //   4. echo FILES_DONE + FILES_TREE_COUNT for the orchestrator.
  //
  // Why a fifo rather than `tee >(sha256sum)` process-substitution:
  //   alpine's `sh` is busybox ash, NOT bash. Process substitution is
  //   a bash-only feature; busybox ash chokes on `>(...)`. mkfifo +
  //   backgrounded sha256sum < fifo achieves the same fan-out without
  //   bash. `set -o pipefail` is supported by busybox 1.30+ (alpine
  //   3.20 ships 1.36).
  //
  // alpine image — busybox tar + curl + sha256sum + awk + mkfifo + wait
  // all available; we only `apk add` GNU findutils (busybox find lacks
  // -printf) + curl (sometimes missing in minimal images).
  return [
    'set -e',
    'set -o pipefail',
    'command -v curl >/dev/null 2>&1 || apk add --no-cache curl >/dev/null 2>&1 || { echo "ERROR: curl install failed"; exit 1; }',
    'apk add --no-cache findutils >/dev/null 2>&1 || { echo "ERROR: findutils install failed"; exit 1; }',
    'cd /source',
    'echo "Streaming archive to platform-api..."',
    // Streaming pipeline: tar → gzip → tee(fifo) → curl --upload-file -
    //
    // CORRECTNESS NOTE — tar exit code via side-channel:
    //   If tar dies mid-stream (e.g. a file vanishes during read),
    //   gzip/tee/curl all see clean EOF and exit 0. `set -o pipefail`
    //   then sees no failure. The truncated archive (validly
    //   gzipped, just incomplete) lands in S3 with HTTP 200 and the
    //   bundle is recorded as successful — silent corruption.
    //
    //   The fix is to capture tar's exit code into a side-file from
    //   inside a subshell, then assert on it after the pipeline.
    //   This is busybox-ash-safe (PIPESTATUS is bash-only).
    'mkfifo /tmp/hash.fifo',
    '( sha256sum < /tmp/hash.fifo | awk \'{print $1}\' > /tmp/archive.sha256 ) &',
    'HASH_PID=$!',
    `( tar cf - . 2>/tmp/tar.err; echo $? > /tmp/tar.exit ) | gzip -1 | tee /tmp/hash.fifo | curl --fail-with-body -sS --upload-file - -H "Content-Type: application/gzip" "${opts.uploadBase}/${ARCHIVE_FILENAME}?token=${opts.archiveToken}"`,
    'wait $HASH_PID',
    'TAR_EXIT=$(cat /tmp/tar.exit 2>/dev/null || echo "missing")',
    '[ "$TAR_EXIT" = "0" ] || { echo "ERROR: tar exited $TAR_EXIT; tar.err:"; cat /tmp/tar.err 2>/dev/null || true; exit 1; }',
    '[ -s /tmp/archive.sha256 ] || { echo "ERROR: sha256 capture failed"; exit 1; }',
    'rm -f /tmp/hash.fifo /tmp/tar.exit',
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
    'echo "Uploading tree.jsonl.gz..."',
    `curl --fail-with-body -sS --upload-file /tmp/tree.jsonl.gz \\\n      -H "Content-Type: application/gzip" \\\n      "${opts.uploadBase}/${TREE_FILENAME}?token=${opts.treeToken}"`,
    // size is dropped from the FILES_DONE line — store.stat is the
    // authoritative source (we re-stat S3 right after the Job exits).
    'echo "FILES_DONE sha256=$(cat /tmp/archive.sha256)"',
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
  /** Optional node-pin: when the tenant data PVC is RWO and currently
   *  attached to a tenant pod on this node, kubelet can bind-mount the
   *  same volume locally without a Multi-Attach error. Without it the
   *  Job often lands on a different node and hangs forever in
   *  ContainerCreating. */
  pinToNode?: string | null;
  /** Hard wall-clock deadline. K8s force-kills past this with reason
   *  `DeadlineExceeded`, so the orchestrator's poll sees a terminal
   *  Failed condition instead of looping until its own timeout. */
  activeDeadlineSeconds?: number;
}): Record<string, unknown> {
  const script = buildScript({
    uploadBase: input.uploadBase,
    archiveToken: input.archiveToken,
    treeToken: input.treeToken,
  });
  const podSpec: Record<string, unknown> = {
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
        // emptyDir for tar/tree intermediate files. Sized generously —
        // a Phase-3 follow-up will tie this to the client's
        // plan.max_backup_size_bytes.
        { name: 'scratch', mountPath: '/tmp' },
      ],
    }],
    volumes: [
      { name: 'source', persistentVolumeClaim: { claimName: input.pvcName, readOnly: true } },
      // Scratch is now tiny (tree index + sha256 file, < 100 KiB) since
      // the archive streams straight to the platform-api. Keeping a
      // small sizeLimit catches accidental disk-staging regressions.
      { name: 'scratch', emptyDir: { sizeLimit: '1Gi' } },
    ],
  };
  if (input.pinToNode) {
    podSpec.nodeName = input.pinToNode;
  }
  const jobSpec: Record<string, unknown> = {
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
      spec: podSpec,
    },
  };
  if (input.activeDeadlineSeconds && input.activeDeadlineSeconds > 0) {
    jobSpec.activeDeadlineSeconds = input.activeDeadlineSeconds;
  }
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
    spec: jobSpec,
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

  // Pre-flight: the PVC must exist. Without this check, a freshly
  // created client whose provisioning Job hasn't yet created the data
  // PVC produces a Job that hangs forever in `Pending` waiting for the
  // claim. FilesComponentSkippedError lets the orchestrator record
  // status='skipped' instead of marking the bundle partial.
  const pvcExists = await checkPvcExists(opts.k8s, opts.namespace, opts.pvcName);
  if (!pvcExists) {
    throw new FilesComponentSkippedError(
      `tenant data PVC '${opts.pvcName}' does not exist in namespace '${opts.namespace}' yet`,
    );
  }

  // Pin the Job to whatever node currently has the tenant's RWO PVC
  // attached (if any). Longhorn refuses Multi-Attach: a backup Job
  // scheduled to a different node sits forever in `ContainerCreating`
  // with `FailedAttachVolume`. Caught E2E 2026-05-07 (32-min hang).
  const pinToNode = await findNodeAttachingPvc(opts.k8s, opts.namespace, opts.pvcName);

  const uploadBase = `${opts.platformApiUrl.replace(/\/$/, '')}/api/v1/internal/bundles/${opts.backupId}/components/files`;
  const jobName = `bk-files-${opts.backupId}`.slice(0, 63);
  const orchestratorTimeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
    pinToNode,
    activeDeadlineSeconds: Math.max(60, Math.ceil(orchestratorTimeoutMs / 1000) - JOB_DEADLINE_BUFFER_SEC),
  });

  await (opts.k8s.batch as unknown as {
    createNamespacedJob: (args: { namespace: string; body: unknown }) => Promise<unknown>;
  }).createNamespacedJob({ namespace: opts.namespace, body: spec });

  await waitForJob(opts.k8s, opts.namespace, jobName, orchestratorTimeoutMs, opts.onProgress);

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

/**
 * Returns the name of the node currently mounting the given RWO PVC,
 * or null if no pod is using it. Used to pin the backup Job so kubelet
 * can bind-mount the same volume locally instead of triggering a
 * Multi-Attach error on a different node.
 *
 * Cheap best-effort lookup: if the API call fails for any reason we
 * fall back to letting the scheduler choose (better to attempt than
 * to abort the bundle).
 */
async function findNodeAttachingPvc(
  k8s: K8sClients,
  namespace: string,
  pvcName: string,
): Promise<string | null> {
  try {
    const res = await k8s.core.listNamespacedPod({ namespace });
    for (const pod of res.items ?? []) {
      const phase = pod.status?.phase;
      if (phase !== 'Running' && phase !== 'Pending') continue;
      const usesPvc = (pod.spec?.volumes ?? []).some(
        (v) => v.persistentVolumeClaim?.claimName === pvcName,
      );
      if (!usesPvc) continue;
      const node = pod.spec?.nodeName;
      // Defence: K8s node names are RFC1123 DNS labels but treat as
      // untrusted input — a malformed value here would land in a
      // Job spec that the apiserver may reject (or worse, silently
      // accept in some edge cases). Restrict to the documented shape.
      if (typeof node === 'string' && /^[a-z0-9.\-]+$/i.test(node) && node.length <= 253) {
        return node;
      }
    }
    return null;
  } catch {
    // Best-effort probe: an apiserver blip here just means the Job
    // is scheduled without a node pin. The original Multi-Attach hang
    // would still reproduce in that case but the activeDeadlineSeconds
    // guard now bounds it to at most ~30 min.
    return null;
  }
}

/**
 * Lightweight existence check for the tenant data PVC. Returns false
 * (not throws) when the PVC is missing so the caller can decide
 * whether to skip the component. Any other API error propagates.
 */
async function checkPvcExists(
  k8s: K8sClients,
  namespace: string,
  pvcName: string,
): Promise<boolean> {
  try {
    await k8s.core.readNamespacedPersistentVolumeClaim({ name: pvcName, namespace });
    return true;
  } catch (err) {
    const httpErr = err as { code?: number; statusCode?: number };
    const code = httpErr.code ?? httpErr.statusCode;
    if (code === 404) return false;
    throw err;
  }
}
