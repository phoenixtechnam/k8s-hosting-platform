import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { PaginatedResponse } from '@/types/api';
import type { DatabaseResponse, BackupResponse } from '@k8s-hosting/api-contracts';

export type { DatabaseResponse as Database, BackupResponse as Backup } from '@k8s-hosting/api-contracts';

export function useDatabases(clientId: string | undefined) {
  const path = `/api/v1/clients/${clientId}/databases`;

  return useQuery({
    queryKey: ['databases', clientId],
    queryFn: () => apiFetch<PaginatedResponse<DatabaseResponse>>(path),
    enabled: !!clientId,
  });
}

export function useBackups(clientId: string | undefined) {
  const path = `/api/v1/clients/${clientId}/backups`;

  return useQuery({
    queryKey: ['backups', clientId],
    queryFn: () => apiFetch<PaginatedResponse<BackupResponse>>(path),
    enabled: !!clientId,
  });
}
