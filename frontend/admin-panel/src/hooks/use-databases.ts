import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { PaginatedResponse } from '@/types/api';

export interface Database {
  readonly id: string;
  readonly name: string;
  readonly type: 'mariadb' | 'postgresql';
  readonly status: 'active' | 'suspended' | 'pending' | 'error';
  readonly sizeBytes: number;
  readonly createdAt: string;
}

export interface Backup {
  readonly id: string;
  readonly type: 'auto' | 'manual';
  readonly resource: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export function useDatabases(clientId: string | undefined) {
  const path = `/api/v1/clients/${clientId}/databases`;

  return useQuery({
    queryKey: ['databases', clientId],
    queryFn: () => apiFetch<PaginatedResponse<Database>>(path),
    enabled: !!clientId,
  });
}

export function useBackups(clientId: string | undefined) {
  const path = `/api/v1/clients/${clientId}/backups`;

  return useQuery({
    queryKey: ['backups', clientId],
    queryFn: () => apiFetch<PaginatedResponse<Backup>>(path),
    enabled: !!clientId,
  });
}
