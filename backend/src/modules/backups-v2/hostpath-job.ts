/**
 * One-shot Job that runs `install -d` on the hostpath bundle root, so
 * sub-directories created later are world-writable.
 *
 * Why this exists:
 *   The platform-api pod runs as uid 1000 (image USER), but the
 *   /var/lib/platform/snapshots hostPath dir on the node is
 *   root:root 0755. Any in-process `mkdir` from platform-api hits
 *   EACCES. The existing storage-lifecycle code dodges this by always
 *   spawning Jobs (which run as root by default in busybox) for every
 *   write.
 *
 *   This helper does the same for the bundle store: a tiny Job runs
 *   `install -d -m 0777 <path>` so the platform-api pod can then
 *   stream component artifacts into sub-paths without further perm
 *   issues.
 *
 * Idempotent — `install -d` is a no-op if the dir already exists with
 * the right mode.
 *
 * Lives in PLATFORM_TENANT_OPS_NS (no quota, privileged PSA).
 *
 * SECURITY ASSUMPTIONS (must hold for this Job to be safe):
 *   1. The `paths` array is built from server-side constants (the
 *      hardcoded `PLATFORM_BUNDLES_HOSTPATH` in routes.ts), NOT from
 *      operator-supplied input. If a future Phase 3 change moves the
 *      mount path to platform_settings, every value MUST be validated
 *      to start with `hostpathRoot` (which `buildHostpathDirJobSpec`
 *      already enforces) AND must not contain shell metachars
 *      (`$(`, backtick, `;`, etc.) — the path is interpolated into a
 *      `sh -c` script and executes as root.
 *   2. The created dir is mode 0777 — world-writable on the node.
 *      Phase 2 is safe because tenant Pods don't mount the snapshots
 *      hostPath. Phase 3's PVC-backed migration must drop the
 *      hostPath volume entirely, not just change the path.
 */

import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { PLATFORM_TENANT_OPS_NS, STORAGE_OPS_PRIORITY_CLASS } from '../storage-lifecycle/platform-ns.js';

const DEFAULT_TIMEOUT_MS = 60 * 1000; // small dir-create Job, 60s is plenty

/**
 * Build the K8s Job spec that runs `install -d -m 0777` on a list of
 * absolute paths under the snapshots hostPath.
 *
 * Pure function — exposed so unit tests can assert on the spec without
 * spinning up a kube client.
 */
export function buildHostpathDirJobSpec(input: {
  readonly jobName: string;
  readonly paths: ReadonlyArray<string>;
  readonly clientId: string;
  readonly bundleId: string;
  readonly hostpathRoot: string; // node-side path, mounted into the Job
  readonly mountPath: string; // in-Pod path, e.g. /snapshots
  readonly jobImage?: string;
}): Record<string, unknown> {
  // Convert each absolute node path to a path relative to hostpathRoot,
  // then to its in-Pod equivalent under mountPath. Caller passes node
  // paths so it can keep one path representation across the codebase.
  const relPaths = input.paths.map((p) => {
    if (!p.startsWith(input.hostpathRoot)) {
      throw new Error(`buildHostpathDirJobSpec: path '${p}' is not under hostpathRoot '${input.hostpathRoot}'`);
    }
    const rel = p.slice(input.hostpathRoot.length).replace(/^\/+/, '');
    return `${input.mountPath}/${rel}`;
  });
  const installCmds = relPaths.map((p) => `install -d -m 0777 "${p}"`).join(' && ');
  const script = `set -e; ${installCmds}; echo "DIRS_READY"`;

  return {
    metadata: {
      name: input.jobName,
      namespace: PLATFORM_TENANT_OPS_NS,
      labels: {
        'platform.io/component': 'backup-hostpath-init',
        'platform.io/client-id': input.clientId,
        'platform.io/backup-id': input.bundleId,
      },
    },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 300,
      template: {
        metadata: {
          labels: {
            'platform.io/component': 'backup-hostpath-init',
            'platform.io/client-id': input.clientId,
            'platform.io/backup-id': input.bundleId,
          },
        },
        spec: {
          restartPolicy: 'Never',
          priorityClassName: STORAGE_OPS_PRIORITY_CLASS,
          containers: [{
            name: 'mkdir',
            image: input.jobImage ?? 'busybox:1.36',
            imagePullPolicy: 'IfNotPresent',
            command: ['sh', '-c', script],
            resources: {
              requests: { cpu: '10m', memory: '16Mi' },
              limits: { cpu: '100m', memory: '64Mi' },
            },
            volumeMounts: [
              { name: 'platform-bundles', mountPath: input.mountPath },
            ],
          }],
          volumes: [
            {
              name: 'platform-bundles',
              hostPath: { path: input.hostpathRoot, type: 'DirectoryOrCreate' },
            },
          ],
        },
      },
    },
  };
}

/**
 * Run the dir-create Job and wait for completion.
 *
 * Throws on Job failure or timeout. Idempotent on repeated calls
 * (same `jobName` will 409; we tolerate that and just poll).
 */
export async function ensureHostpathDirs(opts: {
  readonly k8s: K8sClients;
  readonly bundleId: string;
  readonly clientId: string;
  readonly hostpathRoot: string;
  readonly mountPath: string;
  readonly paths: ReadonlyArray<string>;
  readonly timeoutMs?: number;
}): Promise<void> {
  // Job name needs to be unique-per-bundle but stable on retry.
  const jobName = `bk-mkdir-${opts.bundleId}`.slice(0, 63);
  const spec = buildHostpathDirJobSpec({
    jobName,
    paths: opts.paths,
    clientId: opts.clientId,
    bundleId: opts.bundleId,
    hostpathRoot: opts.hostpathRoot,
    mountPath: opts.mountPath,
  });

  const batch = opts.k8s.batch as unknown as {
    createNamespacedJob: (a: { namespace: string; body: unknown }) => Promise<unknown>;
    readNamespacedJob: (a: { name: string; namespace: string }) => Promise<{
      status?: {
        conditions?: Array<{ type: string; status: string; message?: string }>;
        succeeded?: number;
        failed?: number;
      };
    }>;
  };

  try {
    await batch.createNamespacedJob({ namespace: PLATFORM_TENANT_OPS_NS, body: spec });
  } catch (err) {
    // 409 = already exists; tolerate (caller may have restarted mid-flight).
    // Match storage-lifecycle/service.ts is404() pattern: the @kubernetes/
    // client-node library surfaces the HTTP status in three different
    // shapes depending on the call site — bare `code`, `statusCode`,
    // and `body.code`. Check all three.
    if (!is409(err)) throw err;
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const job = await batch.readNamespacedJob({ name: jobName, namespace: PLATFORM_TENANT_OPS_NS });
    const status = job.status ?? {};
    const completed = (status.conditions ?? []).find((c) => c.type === 'Complete' && c.status === 'True');
    const failed = (status.conditions ?? []).find((c) => c.type === 'Failed' && c.status === 'True');
    if (completed || (status.succeeded ?? 0) > 0) return;
    if (failed || (status.failed ?? 0) > 0) {
      throw new Error(`hostpath-init Job ${jobName} failed: ${failed?.message ?? 'unknown'}`);
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`hostpath-init Job ${jobName} timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
}

/**
 * Match `storage-lifecycle/service.ts is404()` style — the
 * @kubernetes/client-node library surfaces the HTTP status in
 * three different shapes (bare `code`, `statusCode`, `body.code`)
 * depending on which client method is called. None is reliable in
 * isolation, so we check all three.
 */
function is409(err: unknown): boolean {
  const e = err as { code?: number | string; statusCode?: number; body?: { code?: number } };
  if (e.statusCode === 409) return true;
  if (e.code === 409 || e.code === '409') return true;
  if (e.body?.code === 409) return true;
  return false;
}
