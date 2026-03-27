import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

interface HealthService {
  readonly name: string;
  readonly status: 'ok' | 'error' | 'degraded';
  readonly latencyMs: number;
  readonly message?: string;
}

interface HealthResponse {
  readonly data: {
    readonly overall: 'healthy' | 'degraded' | 'unhealthy';
    readonly services: readonly HealthService[];
    readonly checkedAt: string;
  };
}

export function useHealth() {
  return useQuery({
    queryKey: ['health'],
    queryFn: () => apiFetch<HealthResponse>('/api/v1/admin/health'),
    refetchInterval: 60_000,
  });
}
