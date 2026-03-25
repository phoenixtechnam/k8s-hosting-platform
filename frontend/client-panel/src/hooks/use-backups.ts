import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { Backup, PaginatedResponse } from '@/types/api';

export function useBackups(clientId: string | undefined) {
  return useQuery({
    queryKey: ['backups', clientId],
    queryFn: () =>
      apiFetch<PaginatedResponse<Backup>>(
        `/api/v1/clients/${clientId}/backups`,
      ),
    enabled: Boolean(clientId),
  });
}
