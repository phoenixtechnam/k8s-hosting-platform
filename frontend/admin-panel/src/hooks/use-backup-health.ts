import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { BackupHealthResponse } from '@k8s-hosting/api-contracts';

interface ApiEnvelope<T> {
  readonly data: T;
}

const REFETCH_MS = 60_000;

/**
 * Polls /admin/backup-health every 60s. The backend rolls up Job
 * health from labels — adding new backup jobs (with the
 * platform.phoenix-host.net/backup-health-watch=true label) is a
 * pure YAML change, no hook update needed.
 */
export function useBackupHealth() {
  return useQuery({
    queryKey: ['backup-health'],
    queryFn: async () => {
      const res = await apiFetch<ApiEnvelope<BackupHealthResponse>>(
        '/api/v1/admin/backup-health',
      );
      return res.data;
    },
    refetchInterval: REFETCH_MS,
    refetchOnWindowFocus: false,
  });
}
