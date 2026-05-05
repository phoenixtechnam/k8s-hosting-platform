/**
 * System Backup Phase 4 — WAL archive hooks.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  WalArchiveCluster,
  WalArchiveEnableRequest,
  WalArchiveDisableRequest,
  WalArchiveActionResponse,
} from '@k8s-hosting/api-contracts';

interface ApiEnv<T> { data: T }

const KEY = ['system-backup', 'wal-archive', 'clusters'] as const;

export function useWalArchiveClusters() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => apiFetch<ApiEnv<WalArchiveCluster[]>>(
      '/api/v1/system-backup/wal-archive/clusters',
    ).then((r) => r.data),
    // Status fields (lastArchivedWalTime) update live as CNPG archives
    // WAL — refresh every 15s when any cluster is enabled.
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data || data.length === 0) return 60_000;
      return data.some((c) => c.enabled) ? 15_000 : 60_000;
    },
  });
}

export function useEnableWalArchive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: WalArchiveEnableRequest) =>
      apiFetch<ApiEnv<WalArchiveActionResponse>>(
        '/api/v1/system-backup/wal-archive/enable',
        { method: 'POST', body: JSON.stringify(input) },
      ).then((r) => r.data),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: KEY }); },
  });
}

export function useDisableWalArchive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: WalArchiveDisableRequest) =>
      apiFetch<ApiEnv<WalArchiveActionResponse>>(
        '/api/v1/system-backup/wal-archive/disable',
        { method: 'POST', body: JSON.stringify(input) },
      ).then((r) => r.data),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: KEY }); },
  });
}
