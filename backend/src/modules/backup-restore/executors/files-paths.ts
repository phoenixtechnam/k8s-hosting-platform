/**
 * Restore executor: `files-paths`.
 *
 * Mirror of the Phase-3 `files` capture: spawns a Job in the tenant
 * namespace that mounts the tenant data PVC RW, downloads the
 * `archive.tar.gz` artifact from platform-api's internal-download
 * endpoint, and extracts the requested paths (or the whole archive
 * if selector.kind === 'full') into the PVC.
 *
 * Selector shapes (per api-contracts/restore.ts):
 *   { kind: 'full' }
 *   { kind: 'paths', paths: ['var/www/html/index.php', …] }
 *
 * Idempotent re-execute: GNU tar's default behaviour is "overwrite
 * existing", which matches our restore semantics. Files already at
 * the bundle's contents are silently re-written; files NOT in the
 * bundle are LEFT ALONE (no DELETE).
 *
 * Path-injection guard: every path in the selector must start with
 * `./` (or be expressed without a leading slash) AND must not contain
 * `..` segments. The Job's tar invocation receives paths from a file
 * (--files-from=/tmp/paths.lst) so they cannot be misread as tar
 * options. The token only authorises one specific archive, so a Job
 * cannot pivot to another bundle.
 */

import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type { BackupStore } from '../../tenant-bundles/bundle-store.js';
import { restoreItems, restoreJobs, clients, type RestoreItem } from '../../../db/schema.js';
import { ApiError } from '../../../shared/errors.js';
import { signUploadToken } from '../../tenant-bundles/upload-token.js';
import { tailJobLog } from '../../storage-lifecycle/job-log-tail.js';
import { createK8sClients, type K8sClients } from '../../k8s-provisioner/k8s-client.js';

interface Selector {
  kind: 'full' | 'paths';
  paths?: readonly string[];
}

const ARCHIVE_FILENAME = 'archive.tar.gz';
const DOWNLOAD_TOKEN_TTL_SEC = 30 * 60;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export async function execFilesPathsItem(args: {
  app: FastifyInstance;
  item: RestoreItem;
  store: BackupStore;
}): Promise<void> {
  const { app, item } = args;
  const selector = item.selector as unknown as Selector;
  // Selector validation up-front. paths must be relative + no `..`.
  let pathArgs: 'all' | readonly string[];
  if (selector.kind === 'full') {
    pathArgs = 'all';
  } else if (selector.kind === 'paths' && Array.isArray(selector.paths) && selector.paths.length > 0) {
    for (const p of selector.paths) {
      if (typeof p !== 'string' || p.length === 0) {
        throw new ApiError('VALIDATION_ERROR', `files-paths: path must be a non-empty string`, 400);
      }
      if (p.startsWith('/')) {
        throw new ApiError('VALIDATION_ERROR', `files-paths: absolute path '${p}' rejected`, 400);
      }
      if (p.split('/').includes('..')) {
        throw new ApiError('VALIDATION_ERROR', `files-paths: '..' segment rejected in '${p}'`, 400);
      }
      // Tar accepts `path` and `./path`; reject anything weirder.
      if (!/^[A-Za-z0-9._@/\-]+$/.test(p)) {
        throw new ApiError('VALIDATION_ERROR', `files-paths: path '${p}' contains characters outside [A-Za-z0-9._@/\-]`, 400);
      }
    }
    pathArgs = selector.paths;
  } else {
    throw new Error(`files-paths: unsupported selector ${JSON.stringify(selector)}`);
  }

  // Resolve the cart's client + tenant namespace + tenant PVC.
  const [job] = await app.db.select().from(restoreJobs).where(eq(restoreJobs.id, item.restoreJobId)).limit(1);
  if (!job) throw new ApiError('NOT_FOUND', `Restore job ${item.restoreJobId} not found`, 404);
  const [client] = await app.db.select().from(clients).where(eq(clients.id, job.clientId)).limit(1);
  if (!client) throw new ApiError('NOT_FOUND', `Client ${job.clientId} not found`, 404);
  const namespace = client.kubernetesNamespace;
  if (!namespace) throw new ApiError('CONFIG_INVALID', `Client ${job.clientId} has no kubernetes_namespace`, 400);

  // The tenant data PVC convention is `${namespace}-storage`,
  // matching tenant-bundles/orchestrator.ts.resolveTenantPvc. We mount
  // it RW for the restore (capture mounts it RO).
  const pvcName = `${namespace}-storage`;

  const platformApiUrl = (app.config as Record<string, unknown>).PLATFORM_API_INTERNAL_URL as string | undefined
    ?? process.env.PLATFORM_API_INTERNAL_URL
    ?? 'http://platform-api.platform.svc:3000';
  const secretsKeyHex = (app.config as Record<string, unknown>).OIDC_ENCRYPTION_KEY as string | undefined
    ?? process.env.OIDC_ENCRYPTION_KEY
    ?? '0'.repeat(64);

  const downloadToken = signUploadToken(
    { bundleId: item.bundleId, component: 'files', artifactName: ARCHIVE_FILENAME, ttlSeconds: DOWNLOAD_TOKEN_TTL_SEC },
    secretsKeyHex,
  );
  const downloadUrl = `${platformApiUrl.replace(/\/$/, '')}/api/v1/internal/bundles/${item.bundleId}/components/files/${ARCHIVE_FILENAME}?token=${downloadToken}`;

  const jobName = `rs-files-${item.id.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 50)}`;
  const spec = buildFilesPathsJobSpec({
    jobName,
    namespace,
    pvcName,
    clientId: job.clientId,
    cartId: item.restoreJobId,
    itemId: item.id,
    downloadUrl,
    pathArgs,
  });

  // Fastify doesn't decorate k8s today — construct on demand from
  // the configured kubeconfig (matches the orchestrator + lifecycle
  // patterns). Throws on no-kubeconfig in production; tolerated in
  // dev/staging where in-cluster ServiceAccount creds resolve.
  const kc = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined
    ?? process.env.KUBECONFIG;
  const k8s: K8sClients = createK8sClients(kc);
  await (k8s.batch as unknown as {
    createNamespacedJob: (a: { namespace: string; body: unknown }) => Promise<unknown>;
  }).createNamespacedJob({ namespace, body: spec });

  await waitForJob(k8s, namespace, jobName, DEFAULT_TIMEOUT_MS, async (msg) => {
    await app.db.update(restoreItems)
      .set({ progressMessage: msg })
      .where(eq(restoreItems.id, item.id));
  });

  // Read the Job's tail log to surface a result line.
  let log = '';
  try { log = (await tailJobLog(k8s, namespace, jobName, { tailLines: 30, maxLineLength: 5000 })) ?? ''; } catch { /* ignore */ }
  const extracted = (log.match(/FILES_RESTORED count=(\d+)/) ?? [])[1] ?? '?';

  await app.db.update(restoreItems)
    .set({ progressMessage: `restored ${extracted} file(s) into ${namespace}/${pvcName}` })
    .where(eq(restoreItems.id, item.id));
}

export function buildFilesPathsJobSpec(input: {
  jobName: string;
  namespace: string;
  pvcName: string;
  clientId: string;
  cartId: string;
  itemId: string;
  downloadUrl: string;
  pathArgs: 'all' | readonly string[];
}): Record<string, unknown> {
  const script = buildScript({
    downloadUrl: input.downloadUrl,
    pathArgs: input.pathArgs,
  });
  return {
    metadata: {
      name: input.jobName,
      namespace: input.namespace,
      labels: {
        // restore-files matches the (now-tightened) NetworkPolicy
        // pod selector.
        'platform.io/component': 'restore-files',
        'platform.io/client-id': input.clientId,
        'platform.io/restore-cart': input.cartId,
        'platform.io/restore-item': input.itemId,
      },
    },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 600,
      template: {
        metadata: {
          labels: {
            'platform.io/component': 'restore-files',
            'platform.io/client-id': input.clientId,
            'platform.io/restore-cart': input.cartId,
            'platform.io/restore-item': input.itemId,
          },
        },
        spec: {
          restartPolicy: 'Never',
          priorityClassName: 'platform-tenant-overhead',
          containers: [{
            name: 'files-restore',
            image: 'alpine:3.20',
            imagePullPolicy: 'IfNotPresent',
            command: ['sh', '-c', script],
            resources: {
              requests: { cpu: '100m', memory: '128Mi' },
              limits: { cpu: '500m', memory: '512Mi' },
            },
            volumeMounts: [
              { name: 'target', mountPath: '/target', readOnly: false },
              { name: 'scratch', mountPath: '/tmp' },
            ],
          }],
          volumes: [
            { name: 'target', persistentVolumeClaim: { claimName: input.pvcName } },
            { name: 'scratch', emptyDir: { sizeLimit: '50Gi' } },
          ],
        },
      },
    },
  };
}

function buildScript(opts: { downloadUrl: string; pathArgs: 'all' | readonly string[] }): string {
  // Build the tar-paths file. tar --files-from reads each line as a
  // separate path argument — this is the safe way to pass user-
  // controlled path lists, since tar will not interpret leading `--`
  // as options when reading from a file.
  //
  // The bundle archive was produced by `find .` (capture's files-
  // component build) so every entry path is prefixed with `./`.
  // We normalise selectors to the same `./X` shape so tar's
  // --files-from lookup matches the archive entry exactly. Without
  // this, GNU tar exits 2 with "not found in archive" even when the
  // file is present under a different path-prefix shape.
  const normalize = (p: string): string => `./${p.replace(/^\.\//, '')}`;
  const linesScript = opts.pathArgs === 'all'
    ? '> /tmp/paths.lst' // empty paths file → tar -x without --files-from below
    : opts.pathArgs.map(normalize).map((p) => `printf '%s\\n' '${p.replace(/'/g, "'\\''")}' >> /tmp/paths.lst`).join('\n');
  const tarExtract = opts.pathArgs === 'all'
    ? 'tar -xzf /tmp/archive.tar.gz -C /target'
    : 'tar -xzf /tmp/archive.tar.gz -C /target --files-from=/tmp/paths.lst';
  return [
    'set -e',
    'command -v curl >/dev/null 2>&1 || apk add --no-cache curl >/dev/null 2>&1 || { echo "ERROR: curl install failed"; exit 1; }',
    'echo "Building paths list..."',
    ': > /tmp/paths.lst',
    linesScript,
    'echo "Downloading archive.tar.gz..."',
    // --fail-with-body returns non-zero on HTTP errors AND prints body
    `curl --fail-with-body -sS -o /tmp/archive.tar.gz "${opts.downloadUrl}"`,
    'echo "Extracting archive..."',
    'cd /target',
    tarExtract,
    `EXTRACTED=$(${opts.pathArgs === 'all' ? 'tar -tzf /tmp/archive.tar.gz | wc -l' : 'wc -l < /tmp/paths.lst'})`,
    'echo "FILES_RESTORED count=$EXTRACTED"',
  ].join('\n');
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
      readNamespacedJob: (a: { name: string; namespace: string }) => Promise<{
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
      throw new Error(`files-paths Job ${jobName} failed: ${msg}`);
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`files-paths Job ${jobName} did not complete within ${timeoutMs}ms`);
    }
    if (onProgress) {
      const elapsedSec = Math.floor((Date.now() - start) / 1000);
      await onProgress(`files-restore in progress (${elapsedSec}s)`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}
