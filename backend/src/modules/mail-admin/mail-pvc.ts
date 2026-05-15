/**
 * Mail PVC storage — read the stalwart-rocksdb-data PVC.
 *
 * Mail standardised on local-path PVC after the RocksDB migration
 * (only storage class fast enough for `stalwart -e` import/export at
 * production message volumes — see project_stalwart_storage_benchmark_
 * 2026_05_11.md). Resize was historically supported but local-path
 * does NOT quota — `requests.storage` is informational only after
 * creation. The resize endpoint was deleted as part of the 2026-05-14
 * streamline; this module is now READ-ONLY.
 */

import { ApiError } from '../../shared/errors.js';
import {
  type MailPvcStorageResponse,
  mailPvcStorageResponseSchema,
} from '@k8s-hosting/api-contracts';

const MAIL_NAMESPACE = 'mail';
// Phase 1 (RocksDB migration): switched from CNPG PVC (mail-db-1) to the
// Stalwart RocksDB DataStore PVC (stalwart-rocksdb-data, local-path, 20Gi).
const MAIL_PVC_NAME = 'stalwart-rocksdb-data';

export interface MailPvcOptions {
  readonly kubeconfigPath: string | undefined;
}

/**
 * Read the live PVC + (best-effort) used bytes via `du -sb` exec probe.
 *
 * Mail PVC is always local-path post-RocksDB-migration. `requestedBytes`
 * and `capacityBytes` are reported for completeness but are
 * informational only — local-path does NOT enforce/quota the request.
 * `expansionAllowed` is always false and `lastResizedAt` is always null;
 * both kept on the response for contract stability (UI fields are being
 * removed in the Phase-5 mail-page rewrite).
 */
export async function getMailPvcStorage(
  opts: MailPvcOptions,
): Promise<MailPvcStorageResponse> {
  const { core, exec } = await loadK8sClients(opts.kubeconfigPath);

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

  // Best-effort `du -sb` probe in the Stalwart pod. Falls back to null
  // on any failure — the GET endpoint is the operator's primary
  // visibility tool, do NOT block on this. See tryDfProbe for the
  // rationale on choosing du over df for local-path PVCs.
  const df = await tryDfProbe(exec, opts.kubeconfigPath, requestedBytes);

  return mailPvcStorageResponseSchema.parse({
    pvcName: MAIL_PVC_NAME,
    namespace: MAIL_NAMESPACE,
    requestedBytes,
    capacityBytes,
    usedBytes: df.usedBytes,
    freeBytes: df.freeBytes,
    storageClass: scName,
    // local-path doesn't support expansion; resize was deleted in the
    // 2026-05-14 streamline. Kept on the response for UI stability.
    expansionAllowed: false,
    lastResizedAt: null,
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
 * Restricted to the canonical K8s storage suffixes `Ki` / `Mi` / `Gi` /
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
 * Best-effort `du -sb` probe inside the running Stalwart pod. Returns
 * the actual bytes written by Stalwart to the RocksDB DataStore mount
 * + a derived `freeBytes = requestedBytes - usedBytes` (floored at 0).
 *
 * Why `du` and not `df`:
 *   The mail PVC uses the `local-path` StorageClass on staging/prod.
 *   local-path bind-mounts a directory off the node's root filesystem,
 *   so `df` reports the WHOLE node disk — which on a 75 GB node with
 *   45 GB of unrelated container images + tenant PVCs shows ~62% used,
 *   yielding nonsense like "220% of the 20 GiB request" in the UI.
 *
 *   `du -sb` reports just the Stalwart data dir bytes. Mail is
 *   local-path only since the RocksDB migration (the storage
 *   benchmark showed local-path 35× faster than alternatives for
 *   `stalwart -e` import/export at production volumes).
 *
 * Falls back to nulls on any failure (exec RBAC denial, pod not Ready,
 * etc.) because the operator's primary need is to see the requested
 * + capacity sizes, not micro-accurate live usage.
 *
 * Phase 1 (RocksDB migration): probes /var/lib/stalwart/data (the
 * RocksDB DataStore mount) in the `stalwart` container.
 */
async function tryDfProbe(
  exec: import('@kubernetes/client-node').Exec,
  kubeconfigPath: string | undefined,
  requestedBytes: number,
): Promise<{ usedBytes: number | null; freeBytes: number | null }> {
  try {
    const k8s = await import('@kubernetes/client-node');
    const kc = new k8s.KubeConfig();
    if (kubeconfigPath) kc.loadFromFile(kubeconfigPath);
    else kc.loadFromCluster();
    const core = kc.makeApiClient(k8s.CoreV1Api);

    const pods = await core.listNamespacedPod({
      namespace: MAIL_NAMESPACE,
      labelSelector: 'app=stalwart-mail',
      limit: 1,
    } as unknown as Parameters<typeof core.listNamespacedPod>[0]) as { items?: { metadata?: { name?: string }; status?: { phase?: string } }[] };

    const podName = (pods.items ?? []).find((p) => p.status?.phase === 'Running')?.metadata?.name;
    if (!podName) return { usedBytes: null, freeBytes: null };

    const stdout = await execStdout(
      exec,
      MAIL_NAMESPACE,
      podName,
      'stalwart',
      ['du', '-sb', '/var/lib/stalwart/data'],
    );
    const usedBytes = parseDuOutput(stdout);
    if (usedBytes === null) return { usedBytes: null, freeBytes: null };
    const freeBytes = Math.max(0, requestedBytes - usedBytes);
    return { usedBytes, freeBytes };
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
 * Parse `du -sb <path>` output:
 *
 *   12345678<TAB>/var/lib/stalwart/data
 *
 * The first whitespace-separated field is the total byte count. Returns
 * the parsed byte count or null on unexpected shape.
 */
export function parseDuOutput(stdout: string): number | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  const firstField = trimmed.split(/\s+/, 1)[0];
  const n = Number(firstField);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
