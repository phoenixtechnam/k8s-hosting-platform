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
