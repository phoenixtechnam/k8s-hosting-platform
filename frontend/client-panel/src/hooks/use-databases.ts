import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { Database, PaginatedResponse } from '@/types/api';

export function useDatabases(clientId: string | undefined) {
  return useQuery({
    queryKey: ['databases', clientId],
    queryFn: () =>
      apiFetch<PaginatedResponse<Database>>(
        `/api/v1/clients/${clientId}/databases`,
      ),
    enabled: Boolean(clientId),
  });
}
