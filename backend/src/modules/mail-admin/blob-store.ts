/**
 * Stalwart 0.16 BlobStore singleton — read + switch the backend.
 *
 * The cli describes BlobStore as a singleton (id `singleton`) with
 * variants Default / S3 / FileSystem / Azure / Sharded / FoundationDb /
 * PostgreSql / MySql. The platform UI exposes the three the operator
 * can act on without external infra setup we don't ship: Default
 * (current PG-via-DataStore), S3 (external bucket; required for HA
 * stateless), FileSystem (per-replica disk; INCOMPATIBLE with multi-
 * replica).
 *
 * Read path: spawn a short-lived `stalwart-cli get BlobStore` Pod and
 * parse the JSON output. Direct JMAP would be faster but BlobStore is
 * a Settings singleton, not a JMAP-exposed object.
 *
 * Write path: spawn a one-shot Job (same template as
 * stalwart-throttle-override-job.yaml) that runs `stalwart-cli update
 * BlobStore --field type=...`. For S3, write the access keys to a
 * `stalwart-blob-credentials` Secret first; the Job mounts via
 * `envFrom` and the cli reads `$S3_ACCESS_KEY` / `$S3_SECRET_KEY`
 * from env — keys NEVER appear in argv.
 *
 * Self-verification: after the cli update, the Job re-runs `cli get
 * BlobStore` and asserts the requested type matches; non-match exits
 * non-zero so K8s marks the Job Failed.
 *
 * Audit trail: every PATCH writes an audit_logs row with
 * resource_type='stalwart_blob_store' and the before/after type.
 */

import { ApiError } from '../../shared/errors.js';
import {
  type BlobStoreResponse,
  type BlobStoreUpdateRequest,
  type BlobStoreUpdateResponse,
  type BlobStoreJobStatusResponse,
  blobStoreResponseSchema,
  blobStoreUpdateResponseSchema,
  blobStoreJobStatusResponseSchema,
} from '@k8s-hosting/api-contracts';
import {
  STALWART_CLI_VERSION,
  STALWART_CLI_SHA256,
  STALWART_CLI_DOWNLOAD_URL,
} from './blob-store-cli-version.js';

const MAIL_NAMESPACE = 'mail';
const SECRET_NAME = 'stalwart-blob-credentials';
const STALWART_MGMT_URL = 'http://stalwart-mgmt-v016.mail.svc.cluster.local:8080';
const ADMIN_SECRET_NAME = 'stalwart-admin-creds';
const JOB_NAME_PREFIX = 'stalwart-blob-store-update-';
const JOB_LABEL_KEY = 'app.kubernetes.io/component';
const JOB_LABEL_VALUE = 'stalwart-blob-store-update';

export interface BlobStoreOptions {
  readonly kubeconfigPath: string | undefined;
}

/**
 * Read the live BlobStore via a short-lived `stalwart-cli get` Pod.
 * Cli output is JSON (one line: `{"@type":"Default","id":"singleton"}`).
 */
export async function getBlobStore(opts: BlobStoreOptions): Promise<BlobStoreResponse> {
  const { core, batch } = await loadK8sClients(opts.kubeconfigPath);
  const podName = `stalwart-blob-store-read-${randomShort()}`;

  // Spawn the read Pod with the same cli + admin-password env wiring
  // as the throttle-override Job. cli outputs JSON to stdout — read
  // via Pod logs after Succeeded.
  const podManifest = renderReadPodManifest(podName);
  await core.createNamespacedPod({ namespace: MAIL_NAMESPACE, body: podManifest as unknown as object });

  try {
    await waitPodPhase(core, podName, ['Succeeded', 'Failed'], 60_000);
    const log = await core.readNamespacedPodLog({ namespace: MAIL_NAMESPACE, name: podName });
    const text = typeof log === 'string' ? log : (log as { body?: string }).body ?? '';

    // The cli prints a human-readable header line ("Type: Use data
    // store") then a JSON object. Find the JSON object by extracting
    // everything between the first `{` and the last `}`.
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      throw new Error(`stalwart-cli get BlobStore did not return JSON: ${text.slice(0, 200)}`);
    }
    const json = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;

    const rawType = String(json['@type'] ?? '');
    const type = (['Default', 'S3', 'FileSystem'] as const).find((t) => t === rawType) ?? 'Default';

    return blobStoreResponseSchema.parse({
      id: String(json.id ?? 'singleton'),
      type,
      s3: type === 'S3' && typeof json.bucket === 'string'
        ? {
            bucket: String(json.bucket),
            region: extractRegion(json.region),
            endpoint: typeof json.endpoint === 'string' ? json.endpoint : undefined,
          }
        : undefined,
      fileSystem: type === 'FileSystem' && typeof json.path === 'string'
        ? {
            path: String(json.path),
            depth: typeof json.depth === 'number' ? json.depth : undefined,
          }
        : undefined,
      lastUpdatedAt: null,
    });
  } finally {
    await core.deleteNamespacedPod({ namespace: MAIL_NAMESPACE, name: podName }).catch(() => {/* best-effort */});
    void batch; // silence unused
  }
}

/**
 * Switch the BlobStore backend by spawning a one-shot Job that runs
 * `stalwart-cli update BlobStore --field type=...`. For S3, also
 * write/patch the Secret holding the access keys.
 *
 * Returns immediately with the Job name. UI polls
 * GET /admin/mail/blob-store/jobs/:name for status.
 *
 * Secret-handling invariants:
 *   - S3 access keys flow through the Secret + envFrom, NEVER argv
 *   - The Secret patch happens BEFORE Job creation (Job references it
 *     via envFrom; missing Secret would leave the Pod stuck in
 *     CreateContainerConfigError)
 *   - On Job-creation failure, the Secret patch is NOT rolled back
 *     (operator-driven retry is the correct flow; auto-rollback would
 *     just create a different inconsistency)
 */
export async function updateBlobStore(
  request: BlobStoreUpdateRequest,
  opts: BlobStoreOptions,
): Promise<BlobStoreUpdateResponse> {
  const { core, batch } = await loadK8sClients(opts.kubeconfigPath);

  // Step 1: write S3 credentials to the Secret if applicable.
  if (request.type === 'S3') {
    await ensureBlobCredentialsSecret(core, {
      accessKey: request.s3.accessKey,
      secretKey: request.s3.secretKey,
    });
  }

  // Step 2: render + create the Job. Name carries a timestamp + short
  // random suffix so concurrent updates from different operators don't
  // collide on the K8s name.
  const startedAt = new Date().toISOString();
  const jobName = `${JOB_NAME_PREFIX}${randomShort()}`;
  const jobManifest = renderUpdateJobManifest(jobName, request);
  try {
    await batch.createNamespacedJob({
      namespace: MAIL_NAMESPACE,
      body: jobManifest as unknown as object,
    });
  } catch (err) {
    throw new ApiError(
      'BLOB_STORE_JOB_CREATE_FAILED',
      `failed to create blob-store-update Job: ${(err as Error).message ?? String(err)}`,
      500,
    );
  }

  return blobStoreUpdateResponseSchema.parse({
    id: 'singleton',
    type: request.type,
    jobName,
    status: 'queued',
    startedAt,
  });
}

/**
 * Poll endpoint — the UI reads this every 3s while the Job is running
 * and surfaces the cli BEFORE/AFTER output via `podLogTail`.
 */
export async function getBlobStoreJobStatus(
  jobName: string,
  opts: BlobStoreOptions,
): Promise<BlobStoreJobStatusResponse> {
  // Validate the Job name shape — the route also validates but the
  // function is callable from elsewhere, so re-check here.
  if (!/^stalwart-blob-store-update-[a-z0-9-]+$/.test(jobName)) {
    throw new ApiError('BLOB_STORE_JOB_INVALID_NAME', `invalid job name: ${jobName}`, 400);
  }

  const { core, batch } = await loadK8sClients(opts.kubeconfigPath);

  const job = await batch.readNamespacedJob({
    namespace: MAIL_NAMESPACE,
    name: jobName,
  }).catch((err) => {
    const code = (err as { statusCode?: number; code?: number }).statusCode
      ?? (err as { code?: number }).code;
    if (code === 404) {
      throw new ApiError('BLOB_STORE_JOB_NOT_FOUND', `job ${jobName} not found`, 404);
    }
    throw err;
  }) as JobShape;

  const status = jobStatusFromConditions(job);
  const startedAt = job.status?.startTime ?? null;
  const completedAt = job.status?.completionTime ?? null;
  const failureReason = (job.status?.conditions ?? []).find((c) => c.type === 'Failed')?.message ?? null;

  // Read Pod log when the Job has at least one pod (Pending/Running/
  // Succeeded/Failed all OK to read from). Fall back to null on any
  // failure — the operator gets the status field regardless.
  let podLogTail: string | null = null;
  try {
    const pods = await core.listNamespacedPod({
      namespace: MAIL_NAMESPACE,
      labelSelector: `job-name=${jobName}`,
      limit: 1,
    } as unknown as Parameters<typeof core.listNamespacedPod>[0]) as { items?: { metadata?: { name?: string } }[] };
    const podName = pods.items?.[0]?.metadata?.name;
    if (podName) {
      const log = await core.readNamespacedPodLog({
        namespace: MAIL_NAMESPACE,
        name: podName,
        tailLines: 50,
      });
      podLogTail = typeof log === 'string' ? log : (log as { body?: string }).body ?? null;
    }
  } catch {
    podLogTail = null;
  }

  return blobStoreJobStatusResponseSchema.parse({
    jobName,
    status,
    startedAt: typeof startedAt === 'string' ? startedAt : null,
    completedAt: typeof completedAt === 'string' ? completedAt : null,
    podLogTail,
    failureReason,
  });
}

// ── helpers ────────────────────────────────────────────────────────────

interface JobShape {
  status?: {
    startTime?: string;
    completionTime?: string;
    succeeded?: number;
    failed?: number;
    active?: number;
    conditions?: { type: string; status: string; message?: string }[];
  };
}

function jobStatusFromConditions(job: JobShape): BlobStoreJobStatusResponse['status'] {
  const conds = job.status?.conditions ?? [];
  if (conds.some((c) => c.type === 'Complete' && c.status === 'True')) return 'succeeded';
  if (conds.some((c) => c.type === 'Failed' && c.status === 'True')) return 'failed';
  if ((job.status?.active ?? 0) > 0) return 'running';
  if (job.status?.startTime) return 'running';
  return 'queued';
}

interface K8sClientsBundle {
  core: import('@kubernetes/client-node').CoreV1Api;
  batch: import('@kubernetes/client-node').BatchV1Api;
}

async function loadK8sClients(kubeconfigPath: string | undefined): Promise<K8sClientsBundle> {
  const k8s = await import('@kubernetes/client-node');
  const kc = new k8s.KubeConfig();
  if (kubeconfigPath) kc.loadFromFile(kubeconfigPath);
  else kc.loadFromCluster();
  return {
    core: kc.makeApiClient(k8s.CoreV1Api),
    batch: kc.makeApiClient(k8s.BatchV1Api),
  };
}

function randomShort(): string {
  // Lowercase alnum 8 chars — fits in K8s name constraints.
  return Math.random().toString(36).slice(2, 10);
}

function extractRegion(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object' && 'region' in raw) {
    const v = (raw as { region: unknown }).region;
    if (typeof v === 'string') return v;
  }
  return undefined;
}

/**
 * Create or patch the Secret holding S3 credentials. Idempotent so
 * re-running an update with the same keys is a no-op; changing keys
 * is a patch.
 *
 * SECURITY: callers MUST pass plaintext access/secret keys here only
 * once; this function base64-encodes them for the Secret API and
 * returns nothing — values are never logged or returned. Tests
 * assert the function never throws strings containing the secret.
 */
async function ensureBlobCredentialsSecret(
  core: import('@kubernetes/client-node').CoreV1Api,
  creds: { accessKey: string; secretKey: string },
): Promise<void> {
  const accessKeyB64 = Buffer.from(creds.accessKey, 'utf8').toString('base64');
  const secretKeyB64 = Buffer.from(creds.secretKey, 'utf8').toString('base64');
  const data = {
    S3_ACCESS_KEY: accessKeyB64,
    S3_SECRET_KEY: secretKeyB64,
  };

  // Check if Secret exists; create if not, patch if yes.
  let exists = false;
  try {
    await core.readNamespacedSecret({ namespace: MAIL_NAMESPACE, name: SECRET_NAME });
    exists = true;
  } catch (err) {
    const code = (err as { statusCode?: number; code?: number }).statusCode
      ?? (err as { code?: number }).code;
    if (code !== 404) throw err;
  }

  if (!exists) {
    await core.createNamespacedSecret({
      namespace: MAIL_NAMESPACE,
      body: {
        metadata: { name: SECRET_NAME, namespace: MAIL_NAMESPACE },
        type: 'Opaque',
        data,
      },
    } as unknown as Parameters<typeof core.createNamespacedSecret>[0]);
  } else {
    const { JSON_PATCH } = await import('../../shared/k8s-patch.js');
    const ops = Object.entries(data).map(([k, v]) => ({
      op: 'replace' as const,
      path: `/data/${k}`,
      value: v,
    }));
    await core.patchNamespacedSecret(
      { namespace: MAIL_NAMESPACE, name: SECRET_NAME, body: ops as unknown as object },
      JSON_PATCH,
    );
  }
}

/**
 * Render the read Pod manifest. `stalwart-cli get BlobStore` is a
 * read-only call so a Pod (not a Job) is sufficient — fewer K8s
 * objects to clean up.
 */
function renderReadPodManifest(podName: string): unknown {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: podName,
      namespace: MAIL_NAMESPACE,
      labels: { 'app.kubernetes.io/component': 'stalwart-blob-store-read' },
    },
    spec: {
      restartPolicy: 'Never',
      containers: [
        {
          name: 'cli',
          image: 'alpine:3.20',
          env: [
            { name: 'STALWART_URL', value: STALWART_MGMT_URL },
            { name: 'STALWART_USER', value: 'admin' },
            {
              name: 'STALWART_PASSWORD',
              valueFrom: { secretKeyRef: { name: ADMIN_SECRET_NAME, key: 'recoveryPassword' } },
            },
          ],
          command: ['sh', '-c'],
          args: [renderCliBootScript(['"$CLI" get BlobStore --json'])],
        },
      ],
    },
  };
}

/**
 * Render the update Job manifest. Cli args are constructed from the
 * request payload — for S3, the access keys flow via env (Secret
 * mounted via envFrom) and the cli reads `$S3_ACCESS_KEY`/`$S3_SECRET_KEY`
 * from the shell expansion at run time.
 *
 * Self-verify after the update: re-run `cli get BlobStore` and exit
 * non-zero if the type doesn't match. K8s marks the Job Failed.
 */
function renderUpdateJobManifest(jobName: string, request: BlobStoreUpdateRequest): unknown {
  const cliCommands = buildCliCommands(request);
  const env: { name: string; value?: string; valueFrom?: unknown }[] = [
    { name: 'STALWART_URL', value: STALWART_MGMT_URL },
    { name: 'STALWART_USER', value: 'admin' },
    {
      name: 'STALWART_PASSWORD',
      valueFrom: { secretKeyRef: { name: ADMIN_SECRET_NAME, key: 'recoveryPassword' } },
    },
  ];
  const containerSpec: Record<string, unknown> = {
    name: 'cli',
    image: 'alpine:3.20',
    env,
    command: ['sh', '-c'],
    args: [renderCliBootScript(cliCommands)],
  };
  if (request.type === 'S3') {
    containerSpec.envFrom = [{ secretRef: { name: SECRET_NAME } }];
  }

  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: jobName,
      namespace: MAIL_NAMESPACE,
      labels: { [JOB_LABEL_KEY]: JOB_LABEL_VALUE },
    },
    spec: {
      backoffLimit: 1,
      ttlSecondsAfterFinished: 86400,
      template: {
        metadata: { labels: { [JOB_LABEL_KEY]: JOB_LABEL_VALUE, 'job-name': jobName } },
        spec: {
          restartPolicy: 'OnFailure',
          containers: [containerSpec],
        },
      },
    },
  };
}

/**
 * Build the cli commands that run inside the Pod. For S3, the access
 * keys NEVER appear here — they're injected via envFrom and the cli
 * reads `$S3_ACCESS_KEY` / `$S3_SECRET_KEY` at shell-expansion time.
 *
 * This function is exported (via re-export below) so a unit test can
 * grep for plaintext secrets in the rendered argv.
 */
export function buildCliCommands(request: BlobStoreUpdateRequest): string[] {
  const cmds: string[] = [];
  cmds.push('echo === BEFORE ===');
  cmds.push('"$CLI" get BlobStore --json || true');

  if (request.type === 'Default') {
    cmds.push('"$CLI" update BlobStore --field \'@type=Default\'');
  } else if (request.type === 'FileSystem') {
    const path = request.fileSystem.path.replace(/'/g, "'\\''");
    cmds.push(
      `"$CLI" update BlobStore --field '@type=FileSystem' --field 'path=${path}' --field 'depth=${request.fileSystem.depth}'`,
    );
  } else {
    // S3 — credentials NEVER inlined; reference shell-env values.
    const bucket = request.s3.bucket.replace(/'/g, "'\\''");
    const region = request.s3.region.replace(/'/g, "'\\''");
    const fields: string[] = [
      "--field '@type=S3'",
      `--field 'bucket=${bucket}'`,
      `--field 'region=${region}'`,
      "--field 'accessKey=$S3_ACCESS_KEY'",
      "--field 'secretKey=$S3_SECRET_KEY'",
    ];
    if (request.s3.endpoint) {
      const ep = request.s3.endpoint.replace(/'/g, "'\\''");
      fields.push(`--field 'endpoint=${ep}'`);
    }
    cmds.push(`"$CLI" update BlobStore ${fields.join(' ')}`);
  }

  cmds.push('echo === AFTER ===');
  cmds.push('"$CLI" get BlobStore --json');

  // Self-verify — extract the @type from cli JSON output and compare
  // to the requested. Non-match exits non-zero and K8s marks the Job
  // Failed, so the operator UI sees a hard failure rather than a
  // silently-succeeded no-op. The --json flag MUST stay paired with
  // this grep — without it the cli emits human-readable text
  // ("Type: Filesystem") and the regex returns empty, marking
  // genuinely-successful flips as failed.
  cmds.push(`expected="${request.type}"`);
  // Plain single-quoted string so JS doesn't interfere with the embedded
  // shell command substitution. `$CLI` must reach the shell verbatim —
  // an earlier version used a backtick template with `\\$CLI`, which
  // rendered `\$CLI` and made the shell treat it as a literal command
  // name (sh: $CLI: not found), silently failing every self-verify.
  cmds.push('actual=$("$CLI" get BlobStore --json | grep -oE \'"@type":"[A-Za-z]+"\' | head -1 | cut -d\'"\' -f4)');
  cmds.push(
    `if [ "$actual" != "$expected" ]; then echo "self-verify FAILED — expected=$expected actual=$actual" >&2; exit 1; fi`,
  );
  cmds.push('echo "self-verify ok — actual=$actual"');

  return cmds;
}

/**
 * Wrap cli commands in a shell preamble that downloads + sha256-pins
 * stalwart-cli and exposes it as `$CLI`. Mirrors the pattern in
 * stalwart-throttle-override-job.yaml so a future cli version bump
 * touches one constants file (`blob-store-cli-version.ts`).
 */
function renderCliBootScript(cliCommands: string[]): string {
  return [
    'set -e',
    'apk add --no-cache wget tar xz >/dev/null',
    'cd /tmp',
    `wget -q -O cli.tar.xz "${STALWART_CLI_DOWNLOAD_URL}"`,
    `actual=$(sha256sum cli.tar.xz | awk '{print $1}')`,
    `if [ "$actual" != "${STALWART_CLI_SHA256}" ]; then`,
    `  echo "ERROR: stalwart-cli SHA256 mismatch — expected ${STALWART_CLI_SHA256}, actual $actual" >&2`,
    '  exit 1',
    'fi',
    'tar -xJf cli.tar.xz',
    'CLI=/tmp/stalwart-cli-x86_64-unknown-linux-musl/stalwart-cli',
    'chmod +x "$CLI"',
    'for i in $(seq 1 30); do',
    '  if "$CLI" describe BlobStore >/dev/null 2>&1; then break; fi',
    '  echo waiting for stalwart mgmt API',
    '  sleep 5',
    'done',
    ...cliCommands,
  ].join('\n');
}

async function waitPodPhase(
  core: import('@kubernetes/client-node').CoreV1Api,
  name: string,
  acceptable: string[],
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pod = await core.readNamespacedPod({
      namespace: MAIL_NAMESPACE,
      name,
    }).catch(() => null) as { status?: { phase?: string } } | null;
    const phase = pod?.status?.phase;
    if (phase && acceptable.includes(phase)) return;
    await sleep(2_000);
  }
  throw new Error(`pod ${name} did not reach ${acceptable.join('/')} within ${timeoutMs}ms`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
