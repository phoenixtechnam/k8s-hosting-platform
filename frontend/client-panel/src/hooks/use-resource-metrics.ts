import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { useClientContext } from '@/hooks/use-client-context';

export interface ResourceMetrics {
  readonly clientId: string;
  readonly cpu: { readonly inUse: number; readonly reserved: number; readonly available: number };
  readonly memory: { readonly inUse: number; readonly reserved: number; readonly available: number };
  readonly storage: { readonly inUse: number; readonly reserved: number; readonly available: number };
  readonly lastUpdatedAt: string;
}

export function useResourceMetrics() {
  const { clientId } = useClientContext();
  return useQuery({
    queryKey: ['resource-metrics', clientId],
    queryFn: () => apiFetch<{ data: ResourceMetrics }>(`/api/v1/clients/${clientId}/metrics`),
    enabled: Boolean(clientId),
    staleTime: 60_000, // 1 minute client-side cache
  });
}

export function useRefreshMetrics() {
  const { clientId } = useClientContext();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<{ data: ResourceMetrics }>(`/api/v1/clients/${clientId}/metrics/refresh`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['resource-metrics', clientId] });
    },
  });
}
