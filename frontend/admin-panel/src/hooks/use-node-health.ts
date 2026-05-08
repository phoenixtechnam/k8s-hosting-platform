import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  NodeHealthEntry,
  NodeHealthSeverity,
} from '@k8s-hosting/api-contracts';

export type { NodeHealthEntry, NodeHealthSeverity };

interface NodeHealthSummaryEnvelope {
  readonly data: {
    readonly nodes: readonly NodeHealthEntry[];
    readonly overallSeverity: NodeHealthSeverity;
    readonly lastTickAt: string | null;
  };
}

/**
 * Per-node health snapshot from the 5-min reconciler. The Monitoring
 * page surfaces the per-node table; the Nodes & Storage page joins on
 * `name` to render a per-row severity badge.
 *
 * Refetches every 30s — the underlying data only changes on each
 * reconciler tick (5min), so 30s is responsive without hammering.
 */
export function useNodeHealth() {
  return useQuery({
    queryKey: ['node-health', 'summary'],
    queryFn: () => apiFetch<NodeHealthSummaryEnvelope>('/api/v1/admin/node-health/summary'),
    refetchInterval: 30_000,
  });
}

/**
 * Operator-driven "reconcile now" — used after the operator has
 * fixed something (deleted a stuck pod, freed disk) and wants the
 * Monitoring page to update without waiting up to 5 min for the
 * next scheduler tick.
 */
export function useReconcileNodeHealth() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ data: { reconciled: number; notified: readonly string[] } }>(
        '/api/v1/admin/node-health/reconcile',
        { method: 'POST' },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['node-health'] }),
  });
}

// ─── Recovery actions ───────────────────────────────────────────────
//
// One mutation per recovery endpoint. Failed actions
// (RECOVERY_FORBIDDEN_NAMESPACE, RECOVERY_NODE_MISMATCH, etc.)
// bubble up as ApiError with a code the UI can branch on.

interface RecycleArgs {
  readonly node: string;
  readonly namespace: string;
  readonly podName: string;
  readonly reason: string;
}

export function useRecyclePod() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: RecycleArgs) =>
      apiFetch<{ data: { recovered: 0 | 1 } }>(
        '/api/v1/admin/node-health/recovery/recycle-pod',
        { method: 'POST', body: JSON.stringify(args) },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['node-health'] }),
  });
}

export function useCleanStalePods() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { node: string; reason: string }) =>
      apiFetch<{ data: { recovered: number; deleted: readonly string[] } }>(
        '/api/v1/admin/node-health/recovery/clean-stale-pods',
        { method: 'POST', body: JSON.stringify(args) },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['node-health'] }),
  });
}

export function useRestartCsiPlugin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { node: string; reason: string }) =>
      apiFetch<{ data: { recovered: 0 | 1; podName: string | null } }>(
        '/api/v1/admin/node-health/recovery/restart-csi-plugin',
        { method: 'POST', body: JSON.stringify(args) },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['node-health'] }),
  });
}
