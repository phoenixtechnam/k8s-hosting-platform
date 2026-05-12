/**
 * `files` component capture (Phase 1 tenant-backup-v2 / ADR-036).
 *
 * Pipeline (single tenant-namespace Job):
 *
 *   ( tar cf - . 2>/tmp/tar.err; echo $? > /tmp/tar.exit )
 *     | curl --upload-file -
 *         "https://platform-api/.../components/files/restic-stream
 *             ?token=<hmac>&filename=archive.tar"
 *
 * Platform-api receives the body, pipes it straight into
 * `restic backup --stdin --stdin-filename archive.tar` against the
 * per-tenant repo (`<store>/restic-files/<clientId>/`). Snapshot id is
 * parsed from restic's --json summary line and returned to the Job
 * via the response. Tags carry the full multi-region metadata
 * (region, tenant-id, tenant-slug, bundle-version, platform-version).
 *
 * Pre-capture DB dump:
 *   The orchestrator runs preCaptureDatabaseDumps BEFORE this
 *   component spawns the Job. The hook iterates the tenant's
 *   `databases` deployments, calls db-manager.exportDatabaseToPvc per
 *   database — running mysqldump / pg_dump INSIDE the live tenant DB
 *   pod. Dump files land at `/exports/predump-<name>-<iso>.sql` on the
 *   tenant PVC. The `tar cf - .` here then snapshots them alongside
 *   the raw on-disk files. NO DB CLIENTS in this Job's image.
 *
 * Why no gzip:
 *   restic dedups on uncompressed blocks. Pre-compressing the tar
 *   defeats the dedup. Network bandwidth cost is recovered after the
 *   first snapshot — incremental snapshots only ship deltas.
 *
 * Why no tree.jsonl.gz sidecar:
 *   `restic ls <snapshot-id>` is the canonical browse primitive.
 *   The pre-Phase-1.5 tree index sidecar is dropped.
 *
 * Tar exit-code side-channel (preserved from Phase 4):
 *   If tar dies mid-stream, curl sees clean EOF and restic stores a
 *   truncated tarball with a real snapshot id. set -o pipefail does
 *   NOT catch this because every downstream process exits 0.
 *   ( tar cf - . ; echo $? > /tmp/tar.exit ) | curl ...
 *   then assert "$(cat /tmp/tar.exit)" = "0" before declaring success.
 *   Busybox-ash-safe (PIPESTATUS is bash-only).
 */

import type { K8sClients } from '../../k8s-provisioner/k8s-client.js';
import { tailJobLog } from '../../storage-lifecycle/job-log-tail.js';
import { signUploadToken } from '../upload-token.js';
import { STRATEGIC_MERGE_PATCH } from '../../../shared/k8s-patch.js';

export interface FilesComponentResult {
  /** Restic snapshot id (full 64-char) returned by the platform-api endpoint. */
  readonly snapshotId: string;
  /** Bytes processed by restic for this snapshot. */
  readonly sizeBytes: number;
  /** File count processed by restic. NOT a tenant-PVC file count —
   *  restic counts logical entries inside the streamed tar. */
  readonly fileCount: number;
  /**
   * @deprecated Compatibility shim during Phase 1. The pre-restic path
   * recorded a sha256 of the tar.gz on backup_components. Restic content-
   * addresses internally and the snapshot id is the new identity. This
   * field is the snapshot id stringified so the orchestrator's existing
   * `markComponentDone({ sha256 })` call keeps compiling. Phase 1 piece
   * #6 (orchestrator wiring) drops the column reference and bumps the
   * meta.json schema to v3 with `{ kind: 'restic-snapshot', ... }`.
   */
  readonly sha256: string;
}

export interface CaptureFilesComponentOpts {
  readonly k8s: K8sClients;
  readonly namespace: string;
  readonly pvcName: string;
  readonly clientId: string;
  readonly backupId: string;
  readonly platformApiUrl: string;
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

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const UPLOAD_TOKEN_TTL_SEC = 30 * 60;
const JOB_DEADLINE_BUFFER_SEC = 60;

// Canonical artifact name bound into the HMAC token. Mirrors the value
// in internal-upload-route.ts:RESTIC_STREAM_ARTIFACT.
const RESTIC_STREAM_ARTIFACT = 'restic-stream';
const STDIN_FILENAME = 'archive.tar';

function buildScript(opts: { uploadUrlNoToken: string; bundleId: string }): string {
  // Job script:
  //   1. tar cf - .  (uncompressed — restic dedups raw blocks)
  //      Run in a subshell so the exit code lands in /tmp/tar.exit.
  //   2. curl --upload-file -  to platform-api restic-stream endpoint.
  //      HTTP status code goes to a SEPARATE file (not the response
  //      body) so we never depend on `\n` being interpreted by curl
  //      across busybox/full-curl variants (reviewer #2).
  //   3. Assert tar exit was 0 — guards against silent truncation
  //      where tar dies mid-stream and restic stores a partial tar.
  //   4. Parse snapshot id + size + file count via grep -o + sed
  //      (POSIX, busybox-safe; reviewer #1).
  //   5. Echo "FILES_DONE bundleId=<id> snapshot=<id> sizeBytes=<n>
  //      fileCount=<n>" so the orchestrator can attribute and the
  //      bundleId match defends against stale Job-log re-use
  //      (reviewer #3).
  //
  // We do NOT depend on the new tenant-backup-tools image yet (that
  // lands in piece #5). alpine:3.20 has busybox tar + curl; only
  // apk-add curl if missing. Drop the apt-get fallback per
  // reviewer #4 — current image is alpine, fallback path was dead
  // and confusing.
  return [
    'set -e',
    'set -o pipefail',
    'command -v curl >/dev/null 2>&1 || apk add --no-cache curl >/dev/null 2>&1 || { echo "ERROR: curl not available"; exit 1; }',
    'cd /source',
    'echo "Streaming tar to platform-api restic-stream..."',
    // Reviewer #5 (Phase 1.5+): the HMAC token is mounted from a
    // per-Job Secret at /var/run/upload-token/token rather than
    // embedded in the Job spec body. The token never lands in
    // etcd's `command` field; an attacker with `get jobs` RBAC in
    // the tenant ns sees the URL skeleton but not the secret.
    'TOKEN=$(cat /var/run/upload-token/token)',
    '[ -n "$TOKEN" ] || { echo "ERROR: upload token missing"; exit 1; }',
    `( tar cf - . 2>/tmp/tar.err; echo $? > /tmp/tar.exit ) | curl --fail-with-body -sS -o /tmp/restic-resp.json -w "%{http_code}" --upload-file - -H "Content-Type: application/x-tar" "${opts.uploadUrlNoToken}&token=$TOKEN" > /tmp/http_status`,
    'TAR_EXIT=$(cat /tmp/tar.exit 2>/dev/null || echo "missing")',
    '[ "$TAR_EXIT" = "0" ] || { echo "ERROR: tar exited $TAR_EXIT; tar.err:"; cat /tmp/tar.err 2>/dev/null || true; exit 1; }',
    'HTTP=$(tr -d "\\r\\n " < /tmp/http_status)',
    '[ "$HTTP" = "200" ] || { echo "ERROR: platform-api returned HTTP \\"$HTTP\\""; cat /tmp/restic-resp.json 2>/dev/null || true; exit 1; }',
    // Parse via grep -o + sed: order-independent, whitespace-tolerant,
    // and immune to embedded commas in upstream array values (which
    // would have broken an awk RS=, split — reviewer #1).
    'SNAP=$(grep -o \'"snapshotId":"[0-9a-f]\\{64\\}"\' /tmp/restic-resp.json | sed \'s/.*":"//;s/"$//\')',
    '[ -n "$SNAP" ] || { echo "ERROR: no snapshotId in response"; cat /tmp/restic-resp.json; exit 1; }',
    'SIZE=$(grep -o \'"sizeBytes":[0-9]\\+\' /tmp/restic-resp.json | sed \'s/.*://\')',
    'COUNT=$(grep -o \'"fileCount":[0-9]\\+\' /tmp/restic-resp.json | sed \'s/.*://\')',
    `echo "FILES_DONE bundleId=${opts.bundleId} snapshot=$SNAP sizeBytes=\${SIZE:-0} fileCount=\${COUNT:-0}"`,
    'rm -f /tmp/tar.exit /tmp/http_status /tmp/restic-resp.json /tmp/tar.err',
  ].join('\n');
}

/**
 * Build the K8s Job spec for the files-component capture. Pure
 * function — exposed for unit-testing the spec without a kube client.
 *
 * SECURITY NOTE (reviewer #5): the HMAC upload token is interpolated
 * into the shell script and stored in `spec.template.spec.containers[0].command`,
 * which lands in etcd and is readable by anyone with `get jobs` RBAC
 * in the tenant namespace. The token is short-lived (30 min, see
 * UPLOAD_TOKEN_TTL_SEC) and tightly scoped to (bundleId, component,
 * RESTIC_STREAM_ARTIFACT). With ttlSecondsAfterFinished=600 the Job
 * persists for 10 min after completion — within the token's validity
 * window.
 *
 * Phase 1 piece #5 (image rebase to tenant-backup-tools on debian:trixie-slim)
 * will move the token into a per-Job Secret mounted at
 * /var/run/upload-token and reference it via $(cat) in the script —
 * removing the token from the Job spec body entirely.
 */
export function buildFilesComponentJobSpec(input: {
  jobName: string;
  namespace: string;
  pvcName: string;
  clientId: string;
  backupId: string;
  jobImage: string;
  /** Upload URL WITHOUT the &token=... query param. The script
   *  appends `&token=$TOKEN` after reading the token from the
   *  per-Job Secret mounted at /var/run/upload-token/token. */
  uploadUrlNoToken: string;
  /** Name of the per-Job Secret in the same namespace that holds the
   *  HMAC upload token under data.token. The orchestrator creates it
   *  before launching this Job and sets ownerReferences pointing at
   *  the Job so it auto-cleans on Job GC. */
  uploadTokenSecretName: string;
  pinToNode?: string | null;
  activeDeadlineSeconds?: number;
}): Record<string, unknown> {
  const script = buildScript({ uploadUrlNoToken: input.uploadUrlNoToken, bundleId: input.backupId });
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
        // Phase 1 piece #10 perf: 1500m lets tar+curl saturate a Hetzner
        // Storage Box / Object Storage bandwidth slot without the kernel
        // throttling the streaming pipeline. Memory limit unchanged —
        // the streaming pipeline keeps RSS bounded regardless of CPU.
        limits: { cpu: '1500m', memory: '512Mi' },
      },
      volumeMounts: [
        { name: 'source', mountPath: '/source', readOnly: true },
        // Scratch is now tiny — only side-channel files (tar.exit,
        // http_status, restic-resp.json, tar.err). 256Mi is generous.
        { name: 'scratch', mountPath: '/tmp' },
        {
          name: 'upload-token',
          mountPath: '/var/run/upload-token',
          readOnly: true,
        },
      ],
    }],
    volumes: [
      { name: 'source', persistentVolumeClaim: { claimName: input.pvcName, readOnly: true } },
      { name: 'scratch', emptyDir: { sizeLimit: '256Mi' } },
      {
        name: 'upload-token',
        secret: {
          secretName: input.uploadTokenSecretName,
          // tmpfs-backed; defaultMode 0400 — only root in the
          // container can read.
          defaultMode: 0o400,
          items: [{ key: 'token', path: 'token' }],
        },
      },
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
 * Capture the `files` component into the per-tenant restic repo on
 * the platform-api side. Returns the restic snapshot id parsed from
 * the Job log line `FILES_DONE snapshot=<id>`.
 *
 * Pre-condition: orchestrator has already run preCaptureDatabaseDumps
 * for this client's database deployments (so dumps are on the PVC and
 * will be included in the tar stream).
 */
export async function captureFilesComponent(
  opts: CaptureFilesComponentOpts,
): Promise<FilesComponentResult> {
  const archiveToken = signUploadToken(
    {
      bundleId: opts.backupId,
      component: 'files',
      artifactName: RESTIC_STREAM_ARTIFACT,
      ttlSeconds: UPLOAD_TOKEN_TTL_SEC,
    },
    opts.secretsKeyHex,
  );

  const pvcExists = await checkPvcExists(opts.k8s, opts.namespace, opts.pvcName);
  if (!pvcExists) {
    throw new FilesComponentSkippedError(
      `tenant data PVC '${opts.pvcName}' does not exist in namespace '${opts.namespace}' yet`,
    );
  }

  const pinToNode = await findNodeAttachingPvc(opts.k8s, opts.namespace, opts.pvcName);

  const apiBase = opts.platformApiUrl.replace(/\/$/, '');
  const uploadUrlNoToken =
    `${apiBase}/api/v1/internal/bundles/${opts.backupId}` +
    `/components/files/restic-stream` +
    `?filename=${encodeURIComponent(STDIN_FILENAME)}`;

  const jobName = `bk-files-${opts.backupId}`.slice(0, 63);
  const tokenSecretName = `bk-files-token-${opts.backupId}`.slice(0, 63);
  const orchestratorTimeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Create the per-Job token Secret BEFORE the Job. ownerReferences
  // wiring happens in step 2 after the Job is created (we need its
  // UID). This ordering matches kubelet's expectation that referenced
  // Secrets exist before the pod schedules.
  await createTokenSecret(opts.k8s, opts.namespace, tokenSecretName, archiveToken);

  const spec = buildFilesComponentJobSpec({
    jobName,
    namespace: opts.namespace,
    pvcName: opts.pvcName,
    clientId: opts.clientId,
    backupId: opts.backupId,
    jobImage: opts.jobImage ?? 'alpine:3.20',
    uploadUrlNoToken,
    uploadTokenSecretName: tokenSecretName,
    pinToNode,
    activeDeadlineSeconds: Math.max(60, Math.ceil(orchestratorTimeoutMs / 1000) - JOB_DEADLINE_BUFFER_SEC),
  });

  const createdJob = await (opts.k8s.batch as unknown as {
    createNamespacedJob: (args: { namespace: string; body: unknown }) => Promise<{ metadata?: { uid?: string } }>;
  }).createNamespacedJob({ namespace: opts.namespace, body: spec });

  // Wire the Secret to the Job via ownerReferences so kube-controller
  // GCs it when the Job's ttlSecondsAfterFinished elapses. Best-effort
  // — if this fails, the Secret will live on as orphaned data; the
  // tenant ns has no cred-bearing Secret in the spec itself, just an
  // HMAC token that expires in 30 min anyway.
  const jobUid = createdJob.metadata?.uid;
  if (jobUid) {
    await wireSecretOwnerRef(opts.k8s, opts.namespace, tokenSecretName, jobName, jobUid).catch(
      (err: unknown) => {
        // Log only — token Secret without ownerRef merely lingers.
        // Caller's logger will pick this up via stderr if running
        // locally; in production the orchestrator writes a warning.
        // eslint-disable-next-line no-console
        console.warn(
          `[files-component] could not wire ownerRef on token Secret '${tokenSecretName}': ${(err as Error).message}`,
        );
      },
    );
  }

  await waitForJob(opts.k8s, opts.namespace, jobName, orchestratorTimeoutMs, opts.onProgress);

  const log = await readEndOfJobLog(opts.k8s, opts.namespace, jobName);
  const parsed = parseFilesDone(log, opts.backupId);
  if (!parsed) {
    throw new Error(
      `files-component: could not parse FILES_DONE bundleId=${opts.backupId} snapshot=… from Job log (jobName=${jobName})`,
    );
  }
  return {
    snapshotId: parsed.snapshotId,
    sizeBytes: parsed.sizeBytes,
    fileCount: parsed.fileCount,
    sha256: parsed.snapshotId, // see FilesComponentResult.sha256 deprecation note
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

/**
 * Parse the canonical FILES_DONE line from the Job log:
 *
 *   FILES_DONE bundleId=<id> snapshot=<64-hex-id> sizeBytes=<n> fileCount=<n>
 *
 * - bundleId match is asserted to defend against stale Job-log re-use:
 *   if a prior Job pod with the same deterministic name (`bk-files-<bundleId>`)
 *   left a successful line, we must NOT pick it up for a different bundle.
 *   In current code paths the bundleId in args matches the line, so this
 *   is belt-and-braces.
 * - snapshot id is restricted to exactly 64 hex chars (full restic id)
 *   so any truncation produces a parse failure rather than silent
 *   storage of a partial id.
 *
 * Exported for unit-testing without spinning up a Job.
 */
export function parseFilesDone(
  log: string,
  expectedBundleId: string,
): { snapshotId: string; sizeBytes: number; fileCount: number } | null {
  // Find the LAST occurrence so a prior aborted run's partial line
  // can't shadow the current run's success line.
  const lines = log.split('\n').reverse();
  for (const line of lines) {
    const m = line.match(
      /FILES_DONE bundleId=(\S+) snapshot=([0-9a-f]{64}) sizeBytes=(\d+) fileCount=(\d+)/,
    );
    if (!m) continue;
    if (m[1] !== expectedBundleId) {
      // bundleId mismatch — keep scanning for a real match in earlier
      // lines. (Most likely scenario: a stale Job log from before the
      // namespace was recycled. The current run hasn't echoed yet.)
      continue;
    }
    return {
      snapshotId: m[2]!,
      sizeBytes: Number.parseInt(m[3]!, 10),
      fileCount: Number.parseInt(m[4]!, 10),
    };
  }
  return null;
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
      if (typeof node === 'string' && /^[a-z0-9.\-]+$/i.test(node) && node.length <= 253) {
        return node;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Create a per-Job token Secret. data.token holds the HMAC upload
 * token base64-encoded by the kube API. Mode 0400 enforced via the
 * pod's volume mount (defaultMode in buildFilesComponentJobSpec).
 *
 * Idempotent on AlreadyExists (replays during transient Job-create
 * retries are safe).
 */
async function createTokenSecret(
  k8s: K8sClients,
  namespace: string,
  name: string,
  token: string,
): Promise<void> {
  const body = {
    metadata: {
      name,
      namespace,
      labels: {
        'platform.io/component': 'backup-files',
        'platform.io/managed-by': 'tenant-bundles',
      },
    },
    type: 'Opaque',
    // The kube API base64-encodes data values; we pass the raw token
    // and let the SDK marshal. Some SDK builds expect data already
    // base64'd — we use stringData which is always plain.
    stringData: { token },
  };
  try {
    // backup-coverage: excluded:transient-job-token
    await (k8s.core as unknown as {
      createNamespacedSecret: (args: { namespace: string; body: unknown }) => Promise<unknown>;
    }).createNamespacedSecret({ namespace, body });
  } catch (err) {
    const httpErr = err as { code?: number; statusCode?: number };
    const code = httpErr.code ?? httpErr.statusCode;
    if (code === 409) return; // AlreadyExists — idempotent retry.
    throw err;
  }
}

/**
 * After the Job is created, set ownerReferences on the token Secret
 * so kube-controller-manager GCs it when the Job is GC'd via
 * ttlSecondsAfterFinished. Strategic patch.
 */
async function wireSecretOwnerRef(
  k8s: K8sClients,
  namespace: string,
  secretName: string,
  jobName: string,
  jobUid: string,
): Promise<void> {
  const body = {
    metadata: {
      ownerReferences: [{
        apiVersion: 'batch/v1',
        kind: 'Job',
        name: jobName,
        uid: jobUid,
        controller: true,
        blockOwnerDeletion: false,
      }],
    },
  };
  // Use the project-wide STRATEGIC_MERGE_PATCH middleware shim — the
  // ci-k8s-patch-check audit enforces this pattern across all
  // patchNamespaced* call sites (kubernetes-client v1.4 defaults to
  // json-patch+json which the apiserver rejects for merge objects).
  await (k8s.core as unknown as {
    patchNamespacedSecret: (
      args: { name: string; namespace: string; body: unknown },
      override: typeof STRATEGIC_MERGE_PATCH,
    ) => Promise<unknown>;
  }).patchNamespacedSecret(
    { name: secretName, namespace, body },
    STRATEGIC_MERGE_PATCH,
  );
}

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
