import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

/**
 * Filesystem check / repair helpers — run xfs_repair (XFS) or e2fsck
 * (ext4) against a tenant PVC's underlying block device.
 *
 * Why a privileged hostPath Pod and not a regular volumeMount?
 * xfs_repair and e2fsck both refuse to operate on a mounted
 * filesystem — they need the BLOCK DEVICE, unmounted. Tenant PVCs
 * are provisioned in `volumeMode: Filesystem`, which is immutable, so
 * we can't switch to `volumeMode: Block` to expose the device via
 * `volumeDevices`. The remaining path is to schedule a privileged
 * Pod onto the node where Longhorn has attached the volume and run
 * the tool against `/dev/longhorn/<pvname>` exposed as hostPath.
 *
 * Caller contract:
 *   - The volume MUST be detached before calling. The orchestrator
 *     in service.ts handles quiesce (scale tenant + FM to 0, wait for
 *     Longhorn to detach), then unquiesce after this returns. Even
 *     dry-run mode needs the unmount because xfs_repair -n still
 *     refuses on a mounted FS.
 *   - The Pod is scheduled to the node currently owning the volume's
 *     replica via nodeName — the caller passes that in.
 *
 * This is intentionally narrow: NO automatic dependency on the
 * snapshot/quiesce primitives, NO DB writes. The orchestrator in
 * service.ts owns those.
 */

export interface FsckResult {
  /** Detected filesystem type the run targeted (xfs | ext4 | other). */
  readonly fsType: string;
  /** Whether this was a dry run (-n) or a repair run. */
  readonly dryRun: boolean;
  /** Pod's exit code (0 = clean / no errors found, 1 on e2fsck = errors
   *  corrected, 2+ = errors couldn't be fixed). */
  readonly exitCode: number;
  /** Combined stdout+stderr from the fsck tool, capped to MAX_OUTPUT_BYTES. */
  readonly output: string;
  /** True iff the tool reported a clean filesystem (exit 0 + no
   *  ERROR/CORRUPT keyword in the output). */
  readonly clean: boolean;
}

// Image must contain xfs_repair (xfsprogs) and e2fsck (e2fsprogs).
// busybox ships only the `fsck` stub. Alpine is small + the cluster
// pulls Alpine for several other tools; `apk add xfsprogs e2fsprogs`
// is fast.
const DEFAULT_JOB_IMAGE = 'alpine:3.20';
const DEFAULT_JOB_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_OUTPUT_BYTES = 64 * 1024;

interface FsckOpts {
  readonly namespace: string;
  /** PV name (NOT the PVC name) — Longhorn names its block device
   *  /dev/longhorn/<pv-name>. Caller looks this up via PVC.spec.volumeName. */
  readonly volumeName: string;
  readonly clientId: string;
  readonly fsType: string;
  readonly dryRun: boolean;
  /** Node name where the Longhorn volume is currently attached (or
   *  was last attached — Longhorn re-creates /dev/longhorn/* on the
   *  next attach). REQUIRED — caller looks this up from
   *  Volume.status.currentNodeID. */
  readonly nodeName: string;
  readonly jobImage?: string;
  readonly timeoutMs?: number;
  /** Live progress callback — fed the latest log line from the
   *  fsck Job pod every poll cycle (~3s). Wired into
   *  storage_operations.progressMessage so the operator sees
   *  xfs_repair pass output instead of a stuck percentage. */
  readonly onProgress?: (msg: string) => Promise<void> | void;
}

/**
 * Build the in-container shell script that installs the fsck tool,
 * runs it against the host block device, and exits with the tool's
 * status. Exported so unit tests can verify the right command is
 * picked per (fsType, dryRun) combo without spinning up a Job.
 */
export function buildFsckScript(fsType: string, dryRun: boolean): string {
  const lower = fsType.toLowerCase();
  let install: string;
  let cmd: string;

  if (lower === 'xfs') {
    install = 'apk add --no-cache xfsprogs >/dev/null';
    // -n  no-modify check, safe to run repeatedly
    // -v  verbose
    // -L (zero log) is INTENTIONALLY NOT INCLUDED — it's destructive
    //    and operators should run it manually if a damaged log
    //    blocks repair.
    cmd = dryRun
      ? 'xfs_repair -n -v "$DEV"'
      : 'xfs_repair -v "$DEV"';
  } else if (lower === 'ext4' || lower === 'ext3' || lower === 'ext2') {
    install = 'apk add --no-cache e2fsprogs >/dev/null';
    // -n  read-only check
    // -y  auto-answer yes (for repair)
    // -f  force check (don't trust the clean bit)
    // -v  verbose
    cmd = dryRun
      ? 'e2fsck -n -fv "$DEV"'
      : 'e2fsck -y -fv "$DEV"';
  } else {
    return [
      'set +e',
      `echo "fsck: unsupported fsType '${lower}' — only xfs/ext4 supported" >&2`,
      'exit 64',
    ].join('\n');
  }

  return [
    'set +e',
    `echo "[fsck] fsType=${lower} dryRun=${dryRun ? 'true' : 'false'} dev=$DEV"`,
    install,
    '[ -b "$DEV" ] || { echo "[fsck] block device $DEV not found on this node — Longhorn volume not attached?"; exit 65; }',
    cmd,
    'RC=$?',
    'echo "[fsck] exit=$RC"',
    'exit $RC',
  ].join('\n');
}

export async function runFsck(k8s: K8sClients, opts: FsckOpts): Promise<FsckResult> {
  const jobImage = opts.jobImage ?? DEFAULT_JOB_IMAGE;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
  const jobName = `fsck-${opts.dryRun ? 'check' : 'repair'}-${opts.volumeName.slice(-12)}-${Date.now().toString(36)}`.slice(0, 63);
  const script = buildFsckScript(opts.fsType, opts.dryRun);

  // Longhorn block device path on the host. Created by the engine pod
  // when the volume is attached; remains until next detach.
  const devPath = `/dev/longhorn/${opts.volumeName}`;

  const jobBody = {
    metadata: {
      name: jobName,
      namespace: opts.namespace,
      labels: {
        'platform.io/component': 'fsck',
        'platform.io/client-id': opts.clientId,
        'platform.io/fsck-mode': opts.dryRun ? 'check' : 'repair',
      },
    },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 1800,
      template: {
        metadata: { labels: { 'platform.io/component': 'fsck' } },
        spec: {
          restartPolicy: 'Never',
          // Pin to the node currently holding the Longhorn volume —
          // /dev/longhorn/<vol> only exists on that node.
          nodeName: opts.nodeName,
          containers: [{
            name: 'fsck',
            image: jobImage,
            imagePullPolicy: 'IfNotPresent',
            command: ['sh', '-c', script],
            env: [{ name: 'DEV', value: devPath }],
            resources: {
              requests: { cpu: '100m', memory: '256Mi' },
              limits: { cpu: '1000m', memory: '1Gi' },
            },
            // We need the kernel block-device interface. Privileged
            // is the simplest way to get the right capabilities +
            // device permissions on a hostPath block dev.
            securityContext: {
              runAsUser: 0,
              privileged: true,
            },
            volumeMounts: [{
              name: 'longhorn-dev',
              mountPath: '/dev/longhorn',
            }],
          }],
          volumes: [{
            name: 'longhorn-dev',
            hostPath: { path: '/dev/longhorn', type: 'Directory' },
          }],
          // Tolerate any taints — fsck Pods need to land where the
          // data is, even on cordoned/quarantined nodes.
          tolerations: [{ operator: 'Exists' }],
        },
      },
    },
  };

  await (k8s.batch as unknown as {
    createNamespacedJob: (args: { namespace: string; body: unknown }) => Promise<unknown>;
  }).createNamespacedJob({ namespace: opts.namespace, body: jobBody });

  // Poll for completion
  const start = Date.now();
  let finalExitCode = -1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const job = await (k8s.batch as unknown as {
      readNamespacedJob: (args: { name: string; namespace: string }) => Promise<{
        status?: { conditions?: Array<{ type: string; status: string }>; succeeded?: number; failed?: number };
      }>;
    }).readNamespacedJob({ name: jobName, namespace: opts.namespace });
    const status = job.status ?? {};
    const completed = (status.conditions ?? []).find((c) => c.type === 'Complete' && c.status === 'True');
    const failed = (status.conditions ?? []).find((c) => c.type === 'Failed' && c.status === 'True');
    if (completed || (status.succeeded ?? 0) > 0) {
      finalExitCode = 0;
      break;
    }
    if (failed || (status.failed ?? 0) > 0) {
      finalExitCode = await readPodExitCode(k8s, opts.namespace, jobName);
      break;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`fsck Job ${jobName} timed out after ${timeoutMs}ms`);
    }
    if (opts.onProgress) {
      const { tailJobLog } = await import('./job-log-tail.js');
      const tail = await tailJobLog(k8s, opts.namespace, jobName);
      if (tail) await opts.onProgress(`${opts.fsType}: ${tail}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

  const output = await readPodLogs(k8s, opts.namespace, jobName);

  // Best-effort delete; ttlSecondsAfterFinished GCs anyway.
  try {
    await (k8s.batch as unknown as {
      deleteNamespacedJob: (args: { name: string; namespace: string; propagationPolicy?: string }) => Promise<unknown>;
    }).deleteNamespacedJob({ name: jobName, namespace: opts.namespace, propagationPolicy: 'Background' });
  } catch { /* fine */ }

  // "clean" heuristic: exit 0 AND no obvious error keyword.
  const lower = output.toLowerCase();
  const dirty = /error|corrupt|bad superblock|cannot|fail/.test(lower);
  const clean = finalExitCode === 0 && !dirty;

  return {
    fsType: opts.fsType.toLowerCase(),
    dryRun: opts.dryRun,
    exitCode: finalExitCode,
    output: output.slice(0, MAX_OUTPUT_BYTES),
    clean,
  };
}

async function readPodLogs(k8s: K8sClients, namespace: string, jobName: string): Promise<string> {
  try {
    const podList = await k8s.core.listNamespacedPod({
      namespace,
      labelSelector: `job-name=${jobName}`,
    } as unknown as Parameters<typeof k8s.core.listNamespacedPod>[0]) as { items?: Array<{ metadata?: { name?: string } }> };
    const pod = podList.items?.[0];
    if (!pod?.metadata?.name) return '(no pod found for fsck job)';
    const logs = await (k8s.core as unknown as {
      readNamespacedPodLog: (args: { name: string; namespace: string; container?: string; tailLines?: number }) => Promise<string>;
    }).readNamespacedPodLog({ name: pod.metadata.name, namespace, container: 'fsck' });
    return typeof logs === 'string' ? logs : String(logs);
  } catch (err) {
    return `(failed to read fsck pod logs: ${(err as Error).message})`;
  }
}

async function readPodExitCode(k8s: K8sClients, namespace: string, jobName: string): Promise<number> {
  try {
    const podList = await k8s.core.listNamespacedPod({
      namespace,
      labelSelector: `job-name=${jobName}`,
    } as unknown as Parameters<typeof k8s.core.listNamespacedPod>[0]) as {
      items?: Array<{
        status?: {
          containerStatuses?: Array<{ state?: { terminated?: { exitCode?: number } }; lastState?: { terminated?: { exitCode?: number } } }>;
        };
      }>;
    };
    const pod = podList.items?.[0];
    const cs = pod?.status?.containerStatuses?.[0];
    return cs?.state?.terminated?.exitCode
      ?? cs?.lastState?.terminated?.exitCode
      ?? -1;
  } catch {
    return -1;
  }
}
