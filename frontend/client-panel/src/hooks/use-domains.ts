import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { Domain, PaginatedResponse } from '@/types/api';

export function useDomains(clientId: string | undefined) {
  return useQuery({
    queryKey: ['domains', clientId],
    queryFn: () =>
      apiFetch<PaginatedResponse<Domain>>(
        `/api/v1/clients/${clientId}/domains`,
      ),
    enabled: Boolean(clientId),
  });
}
