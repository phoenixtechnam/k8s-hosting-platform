/**
 * Mail PVC storage — read + online-grow the mail-pg-1 PVC.
 *
 * The platform mail-pg CNPG cluster owns one PVC per instance. With
 * `instances: 1` (the default) only `mail-pg-1` exists; HA mode (3
 * instances) creates `mail-pg-2`, `mail-pg-3` too. v1 of this surface
 * targets the primary PVC explicitly — multi-instance grow is a
 * follow-up (CNPG can extend its own cluster.spec.storage.size which
 * propagates to all replicas, but that's out of scope here).
 *
 * Mirrors the pattern in storage-lifecycle/service.ts:runGrowOnline:
 *   - PVC.spec.resources.requests.storage patch via MERGE_PATCH
 *   - Longhorn ControllerExpandVolume → kubelet xfs_growfs → status.capacity
 *   - No pod restart; PG stays running through the grow
 *
 * Three explicit reject paths (return 400 with clear codes):
 *   - MAIL_PVC_SHRINK_NOT_SUPPORTED — newGiB < currentGiB
 *   - MAIL_PVC_SAME_SIZE — newGiB == currentGiB
 *   - STORAGE_CLASS_NO_EXPANSION — SC.allowVolumeExpansion === false
 */

import { ApiError } from '../../shared/errors.js';
import {
  type MailPvcStorageResponse,
  type MailPvcResizeResponse,
  mailPvcStorageResponseSchema,
  mailPvcResizeResponseSchema,
} from '@k8s-hosting/api-contracts';

const MAIL_NAMESPACE = 'mail';
const MAIL_PVC_NAME = 'mail-pg-1';
const LAST_RESIZED_ANNOTATION = 'platform.phoenix-host.net/last-resized-at';

export interface MailPvcOptions {
  readonly kubeconfigPath: string | undefined;
}

/**
 * Read the live PVC + StorageClass + (best-effort) used/free from the
 * CNPG primary pod's df probe.
 */
export async function getMailPvcStorage(
  opts: MailPvcOptions,
): Promise<MailPvcStorageResponse> {
  const { core, storage, exec } = await loadK8sClients(opts.kubeconfigPath);

  const pvc = await core.readNamespacedPersistentVolumeClaim({
    name: MAIL_PVC_NAME,
    namespace: MAIL_NAMESPACE,
  }) as PvcShape;

  const requestedStr = pvc.spec?.resources?.requests?.storage;
  const capacityStr = pvc.status?.capacity?.storage;
  const scName = pvc.spec?.storageClassName;
  if (!requestedStr || !capacityStr || !scName) {
    throw new ApiError(
      'MAIL_PVC_INCOMPLETE',
      `PVC ${MAIL_NAMESPACE}/${MAIL_PVC_NAME} missing requested/capacity/storageClassName`,
      503,
    );
  }

  const requestedBytes = parseQuantity(requestedStr);
  const capacityBytes = parseQuantity(capacityStr);

  // StorageClass.allowVolumeExpansion drives whether grow is even
  // possible. Without this flag the kubelet would silently no-op the
  // PVC patch — surface up-front instead.
  const sc = (await storage.readStorageClass({ name: scName })) as ScShape;
  const expansionAllowed = sc.allowVolumeExpansion === true;

  // Best-effort df probe via kubectl exec into the primary CNPG pod.
  // Falls back to null on any failure — the GET endpoint is the
  // operator's primary visibility tool, do NOT block on this.
  const df = await tryDfProbe(exec, opts.kubeconfigPath);

  const annotations = pvc.metadata?.annotations ?? {};
  const lastResizedAtRaw = annotations[LAST_RESIZED_ANNOTATION];
  const lastResizedAt = isIsoDate(lastResizedAtRaw) ? lastResizedAtRaw : null;

  return mailPvcStorageResponseSchema.parse({
    pvcName: MAIL_PVC_NAME,
    namespace: MAIL_NAMESPACE,
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
 *
 * Patches `pvc.spec.resources.requests.storage` via MERGE_PATCH (same
 * shape storage-lifecycle uses for tenant PVCs). Returns immediately
 * after the patch — the operator UI polls GET to observe convergence
 * because Longhorn's expand + kubelet's filesystem-resize sequence
 * can take 30-120s on contended clusters.
 */
export async function resizeMailPvc(
  newGiB: number,
  opts: MailPvcOptions,
): Promise<MailPvcResizeResponse> {
  if (!Number.isInteger(newGiB) || newGiB < 1) {
    throw new ApiError('MAIL_PVC_INVALID_SIZE', `newGiB must be a positive integer; got ${newGiB}`, 400);
  }

  // Read current state first so we can validate + return reject codes
  // BEFORE issuing the patch.
  const current = await getMailPvcStorage(opts);
  const newBytes = newGiB * 1024 * 1024 * 1024;

  if (newBytes < current.requestedBytes) {
    throw new ApiError(
      'MAIL_PVC_SHRINK_NOT_SUPPORTED',
      `K8s does not support online PVC shrink. Current ${formatGiB(current.requestedBytes)}, requested ${newGiB}GiB. To reduce capacity, snapshot mail-pg, restore into a fresh smaller cluster, swap.`,
      400,
    );
  }
  if (newBytes === current.requestedBytes) {
    throw new ApiError(
      'MAIL_PVC_SAME_SIZE',
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

  // Two MERGE_PATCH calls — spec.resources.requests.storage first
  // (the actionable change) then metadata.annotations (informational).
  // If the second fails, the resize already succeeded; surface a
  // warning rather than rolling back the request.
  try {
    await core.patchNamespacedPersistentVolumeClaim({
      name: MAIL_PVC_NAME,
      namespace: MAIL_NAMESPACE,
      body: { spec: { resources: { requests: { storage: newSizeStr } } } },
    } as unknown as Parameters<typeof core.patchNamespacedPersistentVolumeClaim>[0],
      MERGE_PATCH);
  } catch (err) {
    const code = (err as { statusCode?: number; code?: number }).statusCode
      ?? (err as { code?: number }).code;
    if (code === 422) {
      throw new ApiError(
        'MAIL_PVC_GROW_REJECTED',
        `kubelet rejected PVC patch — SC ${current.storageClass} may have allowVolumeExpansion=false, or ${newSizeStr} is below current capacity`,
        400,
      );
    }
    throw new ApiError(
      'MAIL_PVC_PATCH_FAILED',
      `K8s API rejected PVC patch: ${(err as Error).message ?? String(err)}`,
      500,
    );
  }

  try {
    await core.patchNamespacedPersistentVolumeClaim({
      name: MAIL_PVC_NAME,
      namespace: MAIL_NAMESPACE,
      body: { metadata: { annotations: { [LAST_RESIZED_ANNOTATION]: nowIso } } },
    } as unknown as Parameters<typeof core.patchNamespacedPersistentVolumeClaim>[0],
      MERGE_PATCH);
  } catch {
    // Annotation patch is informational — the resize already
    // succeeded. Silently swallow; UI will just show null
    // lastResizedAt until the next successful resize.
  }

  return mailPvcResizeResponseSchema.parse({
    pvcName: MAIL_PVC_NAME,
    requestedBytes: newBytes,
    lastResizedAt: nowIso,
  });
}

// ── helpers ────────────────────────────────────────────────────────────

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
  // Imports are lazy so this module is import-cheap for tests that
  // never exercise the cluster. Mirrors rotate-jmap.ts:defaultDeps.
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

/**
 * Parse a K8s quantity (`5Gi`, `1024Mi`, `5368709120`) into bytes.
 *
 * Spec: https://kubernetes.io/docs/reference/kubernetes-api/common-definitions/quantity/
 *
 * Restricted to the suffixes Longhorn produces — `Ki` / `Mi` / `Gi` /
 * `Ti` (binary, the K8s default for storage). Decimal SI suffixes
 * (`K` / `M` / etc.) are accepted with their power-of-1000 values.
 */
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

/**
 * Best-effort `df -B1` probe inside the CNPG primary pod. Returns
 * { usedBytes, freeBytes }. Falls back to nulls on any failure
 * (image without busybox df, exec RBAC denial, pod not Ready, etc.)
 * because the operator's primary need is to see the requested +
 * capacity sizes, not micro-accurate live usage.
 */
async function tryDfProbe(
  exec: import('@kubernetes/client-node').Exec,
  kubeconfigPath: string | undefined,
): Promise<{ usedBytes: number | null; freeBytes: number | null }> {
  // Find the primary pod via label selector. Exposes a small surface
  // — only the Pod name + container — so an unrelated pod failure
  // doesn't block the GET.
  try {
    const k8s = await import('@kubernetes/client-node');
    const kc = new k8s.KubeConfig();
    if (kubeconfigPath) kc.loadFromFile(kubeconfigPath);
    else kc.loadFromCluster();
    const core = kc.makeApiClient(k8s.CoreV1Api);

    const pods = await core.listNamespacedPod({
      namespace: MAIL_NAMESPACE,
      labelSelector: 'cnpg.io/cluster=mail-pg,role=primary',
      limit: 1,
    } as unknown as Parameters<typeof core.listNamespacedPod>[0]) as { items?: { metadata?: { name?: string } }[] };

    const podName = pods.items?.[0]?.metadata?.name;
    if (!podName) return { usedBytes: null, freeBytes: null };

    // CNPG mounts the PG data dir at /var/lib/postgresql/data.
    const stdout = await execStdout(
      exec,
      MAIL_NAMESPACE,
      podName,
      'postgres',
      ['df', '-B1', '/var/lib/postgresql/data'],
    );
    return parseDfOutput(stdout);
  } catch {
    return { usedBytes: null, freeBytes: null };
  }
}

/**
 * Run a command in a pod via @kubernetes/client-node Exec API and
 * collect stdout into a string. Times out after 5s — df is fast.
 */
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
    // node:stream's PassThrough is the cheapest sink; avoid pulling
    // an extra dep just to capture output.
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

/**
 * Parse `df -B1` output:
 *
 *   Filesystem    1B-blocks      Used Available Use% Mounted on
 *   /dev/longhorn ...
 *
 * The data line is the second line; columns 2/3/4 are total/used/avail
 * in bytes. Returns { usedBytes, freeBytes } or { null, null } on
 * unexpected shape.
 */
export function parseDfOutput(stdout: string): { usedBytes: number | null; freeBytes: number | null } {
  const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length < 2) return { usedBytes: null, freeBytes: null };
  // df may wrap long fs names — the data we want lives on the LAST line.
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
