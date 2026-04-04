import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface ResourceMetrics {
  readonly clientId: string;
  readonly cpu: { readonly inUse: number; readonly reserved: number; readonly available: number };
  readonly memory: { readonly inUse: number; readonly reserved: number; readonly available: number };
  readonly storage: { readonly inUse: number; readonly reserved: number; readonly available: number };
  readonly lastUpdatedAt: string;
}

// Bulk fetch metrics for all clients shown in list
export function useAllClientMetrics(clientIds: readonly string[]) {
  return useQuery({
    queryKey: ['all-client-metrics', ...clientIds],
    queryFn: () => apiFetch<{ data: Record<string, ResourceMetrics | null> }>(
      `/api/v1/admin/clients/metrics?ids=${clientIds.join(',')}`
    ),
    enabled: clientIds.length > 0,
    staleTime: 60_000,
  });
}

export function useClientMetrics(clientId: string | undefined) {
  return useQuery({
    queryKey: ['client-metrics', clientId],
    queryFn: () => apiFetch<{ data: ResourceMetrics }>(`/api/v1/clients/${clientId}/metrics`),
    enabled: Boolean(clientId),
    staleTime: 60_000,
  });
}
