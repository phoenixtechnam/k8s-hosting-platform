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
