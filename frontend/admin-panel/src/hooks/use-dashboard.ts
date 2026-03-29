import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

interface StatusResponse {
  readonly data: {
    readonly status: string;
    readonly timestamp: string;
    readonly version: string;
  };
}

export function usePlatformStatus() {
  return useQuery({
    queryKey: ['platform-status'],
    queryFn: () => apiFetch<StatusResponse>('/api/v1/admin/status'),
    refetchInterval: 30_000,
  });
}

interface DashboardMetrics {
  readonly total_clients: number;
  readonly active_clients: number;
  readonly total_domains: number;
  readonly total_backups: number;
  readonly platform_version: string;
}

interface DashboardMetricsResponse {
  readonly data: DashboardMetrics;
}

export function useDashboardMetrics() {
  return useQuery({
    queryKey: ['dashboard-metrics'],
    queryFn: () => apiFetch<DashboardMetricsResponse>('/api/v1/admin/dashboard'),
    refetchInterval: 60_000,
  });
}
