import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export type IntegrityFinding =
  | 'namespace_missing'
  | 'pvc_missing'
  | 'resource_quota_missing'
  | 'network_policy_missing';

export interface NamespaceIntegrityReport {
  readonly clientId: string;
  readonly companyName: string;
  readonly namespace: string;
  readonly findings: readonly IntegrityFinding[];
  readonly repaired: readonly IntegrityFinding[];
  readonly errors: readonly string[];
}

export function useClientNamespaceIntegrity(clientId: string | undefined) {
  return useQuery({
    queryKey: ['namespace-integrity', clientId],
    queryFn: () =>
      apiFetch<{ data: NamespaceIntegrityReport }>(`/api/v1/admin/clients/${clientId}/namespace-integrity`),
    enabled: Boolean(clientId),
    refetchInterval: 60_000,
  });
}

export function useRepairClientNamespace(clientId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ data: NamespaceIntegrityReport }>(
        `/api/v1/admin/clients/${clientId}/namespace-integrity/repair`,
        { method: 'POST', body: JSON.stringify({}) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['namespace-integrity', clientId] });
      qc.invalidateQueries({ queryKey: ['clients', clientId] });
      qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

export function useSweepNamespaceIntegrity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ data: { checked: number; repaired: number; errored: number } }>(
        '/api/v1/admin/namespace-integrity/sweep',
        { method: 'POST', body: JSON.stringify({}) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['namespace-integrity'] });
      qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}
