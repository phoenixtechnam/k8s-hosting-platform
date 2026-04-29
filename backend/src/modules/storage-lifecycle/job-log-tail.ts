import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

/**
 * Read the tail of a Job's pod log so the orchestrator can surface a
 * live progress line (last tar entry, curl byte counter, xfs_repair
 * pass output, etc.) into storage_operations.progressMessage instead
 * of leaving the operator staring at a stuck percentage.
 *
 * Best-effort: returns null on any failure (pod not yet started, no
 * pod-log RBAC, ephemeral 5xx from the apiserver). The caller treats
 * null as "no fresh signal" and keeps the previous message.
 */
export async function tailJobLog(
  k8s: K8sClients,
  namespace: string,
  jobName: string,
  options: { tailLines?: number; maxLineLength?: number } = {},
): Promise<string | null> {
  const tailLines = options.tailLines ?? 5;
  const maxLineLength = options.maxLineLength ?? 200;
  try {
    // Find the Job's pod. Single-replica Jobs (which all our snapshot/
    // restore/fsck Jobs are) have one pod selectable by job-name label.
    const pods = await k8s.core.listNamespacedPod({
      namespace,
      labelSelector: `job-name=${jobName}`,
      limit: 1,
    } as Parameters<typeof k8s.core.listNamespacedPod>[0]) as { items?: Array<{ metadata?: { name?: string }; status?: { phase?: string } }> };
    const pod = pods.items?.[0];
    const podName = pod?.metadata?.name;
    if (!podName) return null;
    // Pod still in Pending (no containers started yet) — log read would
    // 400 with "container ... is waiting to start". Skip.
    if (pod.status?.phase === 'Pending') return null;

    const log = await (k8s.core as unknown as {
      readNamespacedPodLog: (a: { name: string; namespace: string; tailLines?: number; container?: string }) => Promise<string>;
    }).readNamespacedPodLog({
      name: podName,
      namespace,
      tailLines,
    });

    if (typeof log !== 'string' || log.length === 0) return null;
    // Last non-empty line, trimmed + capped.
    const lines = log.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return null;
    const last = lines[lines.length - 1];
    return last.length > maxLineLength ? `${last.slice(0, maxLineLength)}…` : last;
  } catch {
    return null;
  }
}
