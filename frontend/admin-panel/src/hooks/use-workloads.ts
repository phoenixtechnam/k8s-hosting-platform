import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { Workload, PaginatedResponse } from '@/types/api';

export function useWorkloads(clientId: string | undefined) {
  const path = `/api/v1/clients/${clientId}/workloads`;

  return useQuery({
    queryKey: ['workloads', clientId],
    queryFn: () => apiFetch<PaginatedResponse<Workload>>(path),
    enabled: !!clientId,
  });
}
