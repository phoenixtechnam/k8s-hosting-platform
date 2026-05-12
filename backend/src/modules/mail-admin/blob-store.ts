/**
 * Stalwart 0.16 BlobStore singleton — read + switch the backend.
 *
 * The cli describes BlobStore as a singleton (id `singleton`) with
 * variants Default / S3 / FileSystem / Azure / Sharded / FoundationDb /
 * PostgreSql / MySql. The platform UI exposes four variants operators
 * care about: Default (current PG-via-DataStore), S3 (external bucket;
 * required for HA stateless), FileSystem (per-replica disk; INCOMPATIBLE
 * with multi-replica), and CIFS (network share via kernel CIFS mount;
 * Stalwart sees it as FileSystem at /mnt/blobstore; platform manages
 * credentials and hostPath Deployment patch).
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
 * from env — keys NEVER appear in argv. For CIFS, write connection
 * details to `stalwart-cifs-blobstore-creds` Secret and patch the
 * Stalwart Deployment to mount the hostPath before spawning the Job.
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
  STALWART_CLI_SHA256,
  STALWART_CLI_DOWNLOAD_URL,
} from './blob-store-cli-version.js';

const MAIL_NAMESPACE = 'mail';
const SECRET_NAME = 'stalwart-blob-credentials';
const CIFS_SECRET_NAME = 'stalwart-cifs-blobstore-creds';
const STALWART_DEPLOYMENT_NAME = 'stalwart-mail';
const STALWART_MGMT_URL = 'http://stalwart-mgmt.mail.svc.cluster.local:8080';
const ADMIN_SECRET_NAME = 'stalwart-admin-creds';
const JOB_NAME_PREFIX = 'stalwart-blob-store-update-';
const JOB_LABEL_KEY = 'app.kubernetes.io/component';
const JOB_LABEL_VALUE = 'stalwart-blob-store-update';
const CIFS_MOUNT_PATH = '/mnt/blobstore';

// CIFS hostPath mount constants — must match the systemd mount provisioned
// by bootstrap.sh (//host/share → /mnt/stalwart-cifs-blobstore).
const CIFS_HOST_PATH = '/mnt/stalwart-cifs-blobstore';
const CIFS_MOUNT_PATH = '/mnt/blobstore';
const CIFS_VOLUME_NAME = 'cifs-blobstore';

export interface BlobStoreOptions {
  readonly kubeconfigPath: string | undefined;
}

/**
 * Read the live BlobStore via a short-lived `stalwart-cli get` Pod.
 * Cli output is JSON (one line: `{"@type":"Default","id":"singleton"}`).
 *
 * CIFS detection: if Stalwart reports FileSystem AND the Secret
 * `stalwart-cifs-blobstore-creds` exists with key CIFS_HOST, the
 * returned type is overridden to 'CIFS' and the `cifs` field is
 * populated from the Secret metadata keys. Credentials (CIFS_USERNAME,
 * CIFS_PASSWORD) are NEVER included in the response.
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

    // CIFS detection: if Stalwart reports FileSystem, check whether the
    // CIFS credentials Secret exists. If it does (with CIFS_HOST key),
    // the operator previously set up a CIFS mount — override the type.
    if (type === 'FileSystem') {
      const cifsDetected = await readCifsSecret(core);
      if (cifsDetected !== null) {
        return blobStoreResponseSchema.parse({
          id: String(json.id ?? 'singleton'),
          type: 'CIFS',
          cifs: cifsDetected,
          lastUpdatedAt: null,
        });
      }
    }

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
 * write/patch the Secret holding the access keys. For CIFS, write
 * credentials to a dedicated Secret and patch the Stalwart Deployment
 * to mount the CIFS hostPath before spawning the Job.
 *
 * Returns immediately with the Job name. UI polls
 * GET /admin/mail/blob-store/jobs/:name for status.
 *
 * Secret-handling invariants:
 *   - S3 access keys flow through the Secret + envFrom, NEVER argv
 *   - CIFS password flows through the Secret + envFrom, NEVER argv
 *   - The Secret patch happens BEFORE Job creation (Job references it
 *     via envFrom; missing Secret would leave the Pod stuck in
 *     CreateContainerConfigError)
 *   - The Deployment patch (CIFS hostPath) happens BEFORE Job creation
 *     so the Stalwart pod is ready to use the mount before the cli
 *     updates the BlobStore pointer
 *   - On Job-creation failure, the Secret patch and Deployment patch
 *     are NOT rolled back (operator-driven retry is the correct flow;
 *     auto-rollback would just create a different inconsistency)
 */
export async function updateBlobStore(
  request: BlobStoreUpdateRequest,
  opts: BlobStoreOptions,
): Promise<BlobStoreUpdateResponse> {
  const { core, batch, apps } = await loadK8sClients(opts.kubeconfigPath);

  // Step 1: write credentials / prepare infrastructure if applicable.
  if (request.type === 'S3') {
    await ensureBlobCredentialsSecret(core, {
      accessKey: request.s3.accessKey,
      secretKey: request.s3.secretKey,
    });
  } else if (request.type === 'CIFS') {
    // Validate host before touching any infrastructure.
    validateCifsHost(request.cifs.host);

    // Write CIFS credentials + metadata to Secret.
    await ensureCifsCredentialsSecret(core, request.cifs);

    // Patch the Stalwart Deployment to add the CIFS hostPath mount.
    // This is idempotent — existing volumes/mounts are deduped.
    await patchStalwartDeploymentVolumes(apps);
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
  apps: import('@kubernetes/client-node').AppsV1Api;
}

async function loadK8sClients(kubeconfigPath: string | undefined): Promise<K8sClientsBundle> {
  const k8s = await import('@kubernetes/client-node');
  const kc = new k8s.KubeConfig();
  if (kubeconfigPath) kc.loadFromFile(kubeconfigPath);
  else kc.loadFromCluster();
  return {
    core: kc.makeApiClient(k8s.CoreV1Api),
    batch: kc.makeApiClient(k8s.BatchV1Api),
    apps: kc.makeApiClient(k8s.AppsV1Api),
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
 * Reject obvious dangerous hosts: localhost, loopback (127.x), and the
 * cloud metadata endpoint (169.254.x.x). RFC-1918 addresses are
 * intentionally NOT blocked because operators may use internal DC
 * networks (e.g. Hetzner Storage Box via private network).
 *
 * SECURITY: this guard prevents SSRF via the CIFS host field reaching
 * metadata endpoints or loopback services. It does not protect against
 * all possible SSRF vectors — network-level controls (NetworkPolicies,
 * nftables) are the primary defence.
 */
export function validateCifsHost(host: string): void {
  const h = host.trim().toLowerCase();

  if (h === 'localhost') {
    throw new ApiError('CIFS_HOST_INVALID', 'CIFS host must not be localhost', 400);
  }

  // Reject loopback range: 127.0.0.0/8
  if (/^127\./.test(h)) {
    throw new ApiError('CIFS_HOST_INVALID', 'CIFS host must not be a loopback address', 400);
  }

  // Reject link-local range: 169.254.0.0/16 (includes cloud metadata endpoint)
  if (/^169\.254\./.test(h)) {
    throw new ApiError('CIFS_HOST_INVALID', 'CIFS host must not be in the link-local range (169.254.x.x)', 400);
  }

  // Reject IPv6 loopback, link-local, and all-zeros
  const bare = h.replace(/^\[|]$/g, '');
  if (bare === '::1' || bare === '0.0.0.0') {
    throw new ApiError('CIFS_HOST_INVALID', 'CIFS host must not be a loopback or any-address', 400);
  }
  if (/^fe80:/i.test(bare)) {
    throw new ApiError('CIFS_HOST_INVALID', 'CIFS host must not be a link-local IPv6 address', 400);
  }
}

/**
 * Attempt to read the CIFS credentials Secret and return the non-sensitive
 * connection details (host, share, path, depth) if the Secret exists with
 * CIFS_HOST key. Returns null on any failure (404, permission error, missing
 * CIFS_HOST key) — callers treat null as "not a CIFS store".
 *
 * SECURITY: CIFS_USERNAME and CIFS_PASSWORD are present in the Secret but
 * NEVER returned here — they are write-only from the API perspective.
 */
async function readCifsSecret(
  core: import('@kubernetes/client-node').CoreV1Api,
): Promise<{ host: string; share: string; path: string; depth?: number } | null> {
  try {
    const secret = await core.readNamespacedSecret({
      namespace: MAIL_NAMESPACE,
      name: CIFS_SECRET_NAME,
    }) as { data?: Record<string, string> };

    const data = secret.data ?? {};
    const host = data['CIFS_HOST'];
    if (!host) return null;

    const decodeB64 = (v: string | undefined): string | undefined =>
      v ? Buffer.from(v, 'base64').toString('utf8') : undefined;

    const hostStr = decodeB64(host);
    const shareStr = decodeB64(data['CIFS_SHARE']);
    const pathStr = decodeB64(data['CIFS_PATH']);
    const depthRaw = decodeB64(data['CIFS_DEPTH']);

    if (!hostStr || !shareStr || !pathStr) return null;

    const depth = depthRaw ? parseInt(depthRaw, 10) : undefined;

    return {
      host: hostStr,
      share: shareStr,
      path: pathStr,
      depth: depth !== undefined && !isNaN(depth) ? depth : undefined,
    };
  } catch {
    // 404, permission denied, or any other error → treat as non-CIFS
    return null;
  }
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
    // backup-coverage: excluded:cluster-infrastructure
    // (Stalwart blob-store credentials in `mail` ns; not tenant data.
    // Mail content lives in Stalwart's PG cluster + is captured by
    // the mailboxes component via IMAP master-user proxy.)
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
 * Create or patch the CIFS credentials + metadata Secret.
 *
 * Keys stored:
 *   - CIFS_HOST, CIFS_SHARE, CIFS_PATH, CIFS_DEPTH — non-sensitive
 *     connection metadata; base64-encoded for Secret API consistency;
 *     read back by getBlobStore() to identify a CIFS store.
 *   - CIFS_USERNAME, CIFS_PASSWORD — sensitive credentials; write-only
 *     from the API perspective (never returned in responses).
 *
 * SECURITY: CIFS_PASSWORD is base64-encoded here but must NEVER appear
 * in log messages, CLI args, audit records, or API responses. Tests
 * assert the function never throws strings containing the password.
 */
async function ensureCifsCredentialsSecret(
  core: import('@kubernetes/client-node').CoreV1Api,
  cifs: { host: string; share: string; path: string; depth: number; username: string; password: string },
): Promise<void> {
  const data: Record<string, string> = {
    CIFS_HOST: Buffer.from(cifs.host, 'utf8').toString('base64'),
    CIFS_SHARE: Buffer.from(cifs.share, 'utf8').toString('base64'),
    CIFS_PATH: Buffer.from(cifs.path, 'utf8').toString('base64'),
    CIFS_DEPTH: Buffer.from(String(cifs.depth), 'utf8').toString('base64'),
    CIFS_USERNAME: Buffer.from(cifs.username, 'utf8').toString('base64'),
    CIFS_PASSWORD: Buffer.from(cifs.password, 'utf8').toString('base64'),
  };

  let exists = false;
  try {
    await core.readNamespacedSecret({ namespace: MAIL_NAMESPACE, name: CIFS_SECRET_NAME });
    exists = true;
  } catch (err) {
    const code = (err as { statusCode?: number; code?: number }).statusCode
      ?? (err as { code?: number }).code;
    if (code !== 404) throw err;
  }

  if (!exists) {
    // backup-coverage: excluded:cluster-infrastructure
    await core.createNamespacedSecret({
      namespace: MAIL_NAMESPACE,
      body: {
        metadata: { name: CIFS_SECRET_NAME, namespace: MAIL_NAMESPACE },
        type: 'Opaque',
        data,
      },
    } as unknown as Parameters<typeof core.createNamespacedSecret>[0]);
  } else {
    const { MERGE_PATCH } = await import('../../shared/k8s-patch.js');
    await core.patchNamespacedSecret(
      {
        namespace: MAIL_NAMESPACE,
        name: CIFS_SECRET_NAME,
        body: { data } as unknown as object,
      },
      MERGE_PATCH,
    );
  }
}

/**
 * Patch the Stalwart Deployment to add the CIFS hostPath volume + volumeMount.
 * Uses strategic merge patch so existing volumes/mounts are preserved.
 * Idempotent: if the volume/mount is already present (same name), no-op.
 *
 * Volume added:
 *   { name: 'cifs-blobstore', hostPath: { path: '/mnt/stalwart-cifs-blobstore', type: 'DirectoryOrCreate' } }
 *
 * VolumeMount added to containers[0]:
 *   { name: 'cifs-blobstore', mountPath: '/mnt/blobstore' }
 *
 * SECURITY NOTE: hostPath volumes have elevated privilege implications.
 * This is intentional — CIFS mounts provisioned by bootstrap.sh land at
 * the fixed path /mnt/stalwart-cifs-blobstore and are read/writable only
 * by root. The Stalwart container runs as root (binds port 25) so the
 * hostPath is accessible. Operators must ensure only the target CIFS share
 * is mounted at that path on the pinned node.
 */
async function patchStalwartDeploymentVolumes(
  apps: import('@kubernetes/client-node').AppsV1Api,
): Promise<void> {
  type DeploymentShape = {
    spec?: {
      template?: {
        spec?: {
          volumes?: { name: string }[];
          containers?: { name: string; volumeMounts?: { name: string }[] }[];
        };
      };
    };
  };

  const deployment = await apps.readNamespacedDeployment({
    namespace: MAIL_NAMESPACE,
    name: STALWART_DEPLOYMENT_NAME,
  }).catch((err) => {
    throw new ApiError(
      'STALWART_DEPLOYMENT_NOT_FOUND',
      `failed to read Stalwart Deployment: ${(err as Error).message ?? String(err)}`,
      500,
    );
  }) as DeploymentShape;

  const existingVolumes = deployment.spec?.template?.spec?.volumes ?? [];
  const mainContainerMounts = deployment.spec?.template?.spec?.containers?.[0]?.volumeMounts ?? [];

  const volumeExists = existingVolumes.some((v) => v.name === CIFS_VOLUME_NAME);
  const mountExists = mainContainerMounts.some((m) => m.name === CIFS_VOLUME_NAME);

  // Both already present — fully idempotent, nothing to do.
  if (volumeExists && mountExists) return;

  // Build the strategic merge patch. Strategic merge patch merges lists
  // by the `name` key for pod specs, so adding an entry with a new name
  // appends it without clobbering existing entries.
  const templateSpec: Record<string, unknown> = {};

  if (!volumeExists) {
    templateSpec['volumes'] = [
      {
        name: CIFS_VOLUME_NAME,
        hostPath: {
          path: CIFS_HOST_PATH,
          type: 'DirectoryOrCreate',
        },
      },
    ];
  }

  if (!mountExists) {
    templateSpec['containers'] = [
      {
        name: 'stalwart',
        volumeMounts: [
          {
            name: CIFS_VOLUME_NAME,
            mountPath: CIFS_MOUNT_PATH,
          },
        ],
      },
    ];
  }

  const patch = {
    spec: {
      template: {
        spec: templateSpec,
      },
    },
  };

  const { STRATEGIC_MERGE_PATCH } = await import('../../shared/k8s-patch.js');
  await apps.patchNamespacedDeployment(
    {
      namespace: MAIL_NAMESPACE,
      name: STALWART_DEPLOYMENT_NAME,
      body: patch as unknown as object,
    },
    STRATEGIC_MERGE_PATCH,
  ).catch((err) => {
    throw new ApiError(
      'STALWART_DEPLOYMENT_PATCH_FAILED',
      `failed to patch Stalwart Deployment with CIFS volume: ${(err as Error).message ?? String(err)}`,
      500,
    );
  });
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
 * from the shell expansion at run time. For CIFS, no credentials are
 * passed to the cli (it operates on the already-mounted filesystem).
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
 * For CIFS, the cli is told to use FileSystem at the mount path;
 * no CIFS credentials appear in the cli invocation.
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
  } else if (request.type === 'CIFS') {
    // CIFS maps to FileSystem for Stalwart; the blob root is the
    // sub-path within the mounted CIFS share at /mnt/blobstore.
    // Strip any leading slash from request.cifs.path before appending
    // so the result is always /mnt/blobstore/<path> (never /mnt/blobstore//path).
    const relativePath = request.cifs.path.replace(/^\/+/, '');
    const mountedPath = `${CIFS_MOUNT_PATH}/${relativePath}`.replace(/'/g, "'\\''");
    cmds.push(
      `"$CLI" update BlobStore --field '@type=FileSystem' --field 'path=${mountedPath}' --field 'depth=${request.cifs.depth}'`,
    );
  } else if (request.type === 'S3') {
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
  } else {
    const _exhaustive: never = request;
    throw new Error(`Unhandled BlobStoreUpdateRequest type: ${String((_exhaustive as { type: string }).type)}`);
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
  //
  // CIFS uses FileSystem as the Stalwart-level type — the self-verify
  // checks for "FileSystem" accordingly.
  const expectedType = request.type === 'CIFS' ? 'FileSystem' : request.type;
  cmds.push(`expected="${expectedType}"`);
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
