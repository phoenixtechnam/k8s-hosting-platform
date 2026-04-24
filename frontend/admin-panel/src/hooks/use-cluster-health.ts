import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface ComponentReadiness {
  readonly name: string;
  readonly namespace: string;
  readonly kind: 'Deployment' | 'DaemonSet';
  readonly desired: number;
  readonly ready: number;
  readonly healthy: boolean;
  readonly message?: string;
}

export function useClusterHealth() {
  return useQuery({
    queryKey: ['cluster-health'],
    queryFn: () => apiFetch<{ data: { components: readonly ComponentReadiness[] } }>('/api/v1/admin/cluster-health'),
    refetchInterval: 30_000,
  });
}
