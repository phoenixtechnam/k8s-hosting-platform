/**
 * System PVC storage — read + online-grow the system-db-1 PVC.
 *
 * Mirror of mail-admin/mail-pvc.ts (see that module for the orchestration
 * rationale: PVC.spec.resources.requests.storage MERGE_PATCH; Longhorn
 * ControllerExpandVolume → kubelet xfs_growfs → status.capacity; no pod
 * restart). Differs only in cluster identity (platform/system-db,
 * primary pod label selector) and reject-code prefix.
 *
 * The two CNPG-managed system clusters are intentionally kept on
 * separate routes + reject codes so the UI can render distinct error
 * messages and the audit log captures which cluster was resized.
 */

import { ApiError } from '../../shared/errors.js';
import {
  type SystemPvcStorageResponse,
  type SystemPvcResizeResponse,
  systemPvcStorageResponseSchema,
  systemPvcResizeResponseSchema,
} from '@k8s-hosting/api-contracts';

const SYSTEM_NAMESPACE = 'platform';
// Cluster renamed 2026-05-07 from `postgres` → `system-db`. CNPG-managed
// PVCs follow the cluster-name pattern `<cluster>-<index>`. Single
// instance currently → `system-db-1`. HA mode (3 instances) creates
// system-db-2 + system-db-3; v1 of this surface targets the index-1
// PVC explicitly. CNPG's spec.storage.size grow propagates to all
// replicas, so a future multi-instance UI can either patch the CR
// directly or call this endpoint per-instance.
const SYSTEM_PVC_NAME = 'system-db-1';
const LAST_RESIZED_ANNOTATION = 'platform.phoenix-host.net/last-resized-at';

export interface SystemPvcOptions {
  readonly kubeconfigPath: string | undefined;
}

/**
 * Read the live PVC + StorageClass + (best-effort) used/free from the
 * CNPG primary pod's df probe.
 */
export async function getSystemPvcStorage(
  opts: SystemPvcOptions,
): Promise<SystemPvcStorageResponse> {
  const { core, storage, exec } = await loadK8sClients(opts.kubeconfigPath);

  const pvc = await core.readNamespacedPersistentVolumeClaim({
    name: SYSTEM_PVC_NAME,
    namespace: SYSTEM_NAMESPACE,
  }) as PvcShape;

  const requestedStr = pvc.spec?.resources?.requests?.storage;
  const capacityStr = pvc.status?.capacity?.storage;
  const scName = pvc.spec?.storageClassName;
  if (!requestedStr || !capacityStr || !scName) {
    throw new ApiError(
      'SYSTEM_PVC_INCOMPLETE',
      `PVC ${SYSTEM_NAMESPACE}/${SYSTEM_PVC_NAME} missing requested/capacity/storageClassName`,
      503,
    );
  }

  const requestedBytes = parseQuantity(requestedStr);
  const capacityBytes = parseQuantity(capacityStr);

  const sc = (await storage.readStorageClass({ name: scName })) as ScShape;
  const expansionAllowed = sc.allowVolumeExpansion === true;

  const df = await tryDfProbe(exec, opts.kubeconfigPath);

  const annotations = pvc.metadata?.annotations ?? {};
  const lastResizedAtRaw = annotations[LAST_RESIZED_ANNOTATION];
  const lastResizedAt = isIsoDate(lastResizedAtRaw) ? lastResizedAtRaw : null;

  return systemPvcStorageResponseSchema.parse({
    pvcName: SYSTEM_PVC_NAME,
    namespace: SYSTEM_NAMESPACE,
    requestedBytes,
    capacityBytes,
    usedBytes: df.usedBytes,
    freeBytes: df.freeBytes,
    storageClass: scName,
    expansionAllowed,
    lastResizedAt,
  });
}

/**
 * Online-grow the PVC. Refuses shrink + same-size + SC-no-expansion.
 */
export async function resizeSystemPvc(
  newGiB: number,
  opts: SystemPvcOptions,
): Promise<SystemPvcResizeResponse> {
  if (!Number.isInteger(newGiB) || newGiB < 1) {
    throw new ApiError('SYSTEM_PVC_INVALID_SIZE', `newGiB must be a positive integer; got ${newGiB}`, 400);
  }

  const current = await getSystemPvcStorage(opts);
  const newBytes = newGiB * 1024 * 1024 * 1024;

  if (newBytes < current.requestedBytes) {
    throw new ApiError(
      'SYSTEM_PVC_SHRINK_NOT_SUPPORTED',
      `K8s does not support online PVC shrink. Current ${formatGiB(current.requestedBytes)}, requested ${newGiB}GiB. To reduce capacity, snapshot system-db, restore into a fresh smaller cluster, swap.`,
      400,
    );
  }
  if (newBytes === current.requestedBytes) {
    throw new ApiError(
      'SYSTEM_PVC_SAME_SIZE',
      `Storage already at ${newGiB}GiB`,
      400,
    );
  }
  if (!current.expansionAllowed) {
    throw new ApiError(
      'STORAGE_CLASS_NO_EXPANSION',
      `StorageClass ${current.storageClass} does not allow volume expansion. Operator must set allowVolumeExpansion=true on the SC before resizing.`,
      400,
    );
  }

  const { core } = await loadK8sClients(opts.kubeconfigPath);
  const { MERGE_PATCH } = await import('../../shared/k8s-patch.js');

  const newSizeStr = `${newGiB}Gi`;
  const nowIso = new Date().toISOString();

  try {
    await core.patchNamespacedPersistentVolumeClaim({
      name: SYSTEM_PVC_NAME,
      namespace: SYSTEM_NAMESPACE,
      body: { spec: { resources: { requests: { storage: newSizeStr } } } },
    } as unknown as Parameters<typeof core.patchNamespacedPersistentVolumeClaim>[0],
      MERGE_PATCH);
  } catch (err) {
    const code = (err as { statusCode?: number; code?: number }).statusCode
      ?? (err as { code?: number }).code;
    if (code === 422) {
      throw new ApiError(
        'SYSTEM_PVC_GROW_REJECTED',
        `kubelet rejected PVC patch — SC ${current.storageClass} may have allowVolumeExpansion=false, or ${newSizeStr} is below current capacity`,
        400,
      );
    }
    throw new ApiError(
      'SYSTEM_PVC_PATCH_FAILED',
      `K8s API rejected PVC patch: ${(err as Error).message ?? String(err)}`,
      500,
    );
  }

  try {
    await core.patchNamespacedPersistentVolumeClaim({
      name: SYSTEM_PVC_NAME,
      namespace: SYSTEM_NAMESPACE,
      body: { metadata: { annotations: { [LAST_RESIZED_ANNOTATION]: nowIso } } },
    } as unknown as Parameters<typeof core.patchNamespacedPersistentVolumeClaim>[0],
      MERGE_PATCH);
  } catch {
    // Annotation patch is informational — silently swallow.
  }

  return systemPvcResizeResponseSchema.parse({
    pvcName: SYSTEM_PVC_NAME,
    requestedBytes: newBytes,
    lastResizedAt: nowIso,
  });
}

interface PvcShape {
  metadata?: { annotations?: Record<string, string> };
  spec?: {
    storageClassName?: string;
    resources?: { requests?: { storage?: string } };
  };
  status?: {
    capacity?: { storage?: string };
  };
}

interface ScShape {
  allowVolumeExpansion?: boolean;
}

interface K8sClientsBundle {
  core: import('@kubernetes/client-node').CoreV1Api;
  storage: import('@kubernetes/client-node').StorageV1Api;
  exec: import('@kubernetes/client-node').Exec;
}

async function loadK8sClients(kubeconfigPath: string | undefined): Promise<K8sClientsBundle> {
  const k8s = await import('@kubernetes/client-node');
  const kc = new k8s.KubeConfig();
  if (kubeconfigPath) kc.loadFromFile(kubeconfigPath);
  else kc.loadFromCluster();
  return {
    core: kc.makeApiClient(k8s.CoreV1Api),
    storage: kc.makeApiClient(k8s.StorageV1Api),
    exec: new k8s.Exec(kc),
  };
}

export function parseQuantity(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(Ki|Mi|Gi|Ti|K|M|G|T)?$/.exec(s.trim());
  if (!m) throw new Error(`unparseable K8s quantity: ${s}`);
  const n = Number(m[1]);
  switch (m[2]) {
    case 'Ki': return Math.round(n * 1024);
    case 'Mi': return Math.round(n * 1024 ** 2);
    case 'Gi': return Math.round(n * 1024 ** 3);
    case 'Ti': return Math.round(n * 1024 ** 4);
    case 'K':  return Math.round(n * 1000);
    case 'M':  return Math.round(n * 1000 ** 2);
    case 'G':  return Math.round(n * 1000 ** 3);
    case 'T':  return Math.round(n * 1000 ** 4);
    case undefined: return Math.round(n);
    default: throw new Error(`unhandled quantity suffix: ${m[2]}`);
  }
}

function formatGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)}GiB`;
}

function isIsoDate(s: unknown): s is string {
  return typeof s === 'string' && !Number.isNaN(Date.parse(s));
}

async function tryDfProbe(
  exec: import('@kubernetes/client-node').Exec,
  kubeconfigPath: string | undefined,
): Promise<{ usedBytes: number | null; freeBytes: number | null }> {
  try {
    const k8s = await import('@kubernetes/client-node');
    const kc = new k8s.KubeConfig();
    if (kubeconfigPath) kc.loadFromFile(kubeconfigPath);
    else kc.loadFromCluster();
    const core = kc.makeApiClient(k8s.CoreV1Api);

    const pods = await core.listNamespacedPod({
      namespace: SYSTEM_NAMESPACE,
      labelSelector: 'cnpg.io/cluster=system-db,role=primary',
      limit: 1,
    } as unknown as Parameters<typeof core.listNamespacedPod>[0]) as { items?: { metadata?: { name?: string } }[] };

    const podName = pods.items?.[0]?.metadata?.name;
    if (!podName) return { usedBytes: null, freeBytes: null };

    const stdout = await execStdout(
      exec,
      SYSTEM_NAMESPACE,
      podName,
      'postgres',
      ['df', '-B1', '/var/lib/postgresql/data'],
    );
    return parseDfOutput(stdout);
  } catch {
    return { usedBytes: null, freeBytes: null };
  }
}

function execStdout(
  exec: import('@kubernetes/client-node').Exec,
  namespace: string,
  podName: string,
  containerName: string,
  argv: string[],
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let timer: NodeJS.Timeout | undefined;
    void import('node:stream').then(({ PassThrough, Writable }) => {
      const stdoutSink = new PassThrough();
      stdoutSink.on('data', (c: Buffer) => chunks.push(c));
      const stderrSink = new Writable({
        write(_chunk, _enc, cb) { cb(); },
      });
      timer = setTimeout(() => reject(new Error('df probe timed out')), 5_000);
      exec.exec(
        namespace,
        podName,
        containerName,
        argv,
        stdoutSink,
        stderrSink,
        null,
        false,
        (status) => {
          if (timer) clearTimeout(timer);
          if (status.status === 'Failure') {
            reject(new Error(`df probe non-zero exit: ${status.message ?? 'unknown'}`));
            return;
          }
          resolve(Buffer.concat(chunks).toString('utf8'));
        },
      ).catch(reject);
    });
  });
}

export function parseDfOutput(stdout: string): { usedBytes: number | null; freeBytes: number | null } {
  const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length < 2) return { usedBytes: null, freeBytes: null };
  const dataLine = lines[lines.length - 1];
  const parts = dataLine.split(/\s+/);
  if (parts.length < 5) return { usedBytes: null, freeBytes: null };
  const usedRaw = Number(parts[2]);
  const availRaw = Number(parts[3]);
  return {
    usedBytes: Number.isFinite(usedRaw) ? usedRaw : null,
    freeBytes: Number.isFinite(availRaw) ? availRaw : null,
  };
}
