/**
 * System Backup Phase 4b — pg_dump schedule hooks.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  PgDumpSchedule,
  PgDumpScheduleUpsert,
} from '@k8s-hosting/api-contracts';

interface ApiEnv<T> { data: T }
const KEY = ['system-backup', 'pg-dump', 'schedules'] as const;

export function usePgDumpSchedules() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => apiFetch<ApiEnv<PgDumpSchedule[]>>(
      '/api/v1/system-backup/pg-dump/schedules',
    ).then((r) => r.data),
    refetchInterval: 30_000,
  });
}

export function useUpsertPgDumpSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PgDumpScheduleUpsert) =>
      apiFetch<ApiEnv<{ ok: boolean; id: string; nextRunAt: string }>>(
        '/api/v1/system-backup/pg-dump/schedules',
        { method: 'POST', body: JSON.stringify(input) },
      ).then((r) => r.data),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: KEY }); },
  });
}

export function useDeletePgDumpSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<ApiEnv<{ ok: boolean }>>(
        `/api/v1/system-backup/pg-dump/schedules/${id}`,
        { method: 'DELETE' },
      ).then((r) => r.data),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: KEY }); },
  });
}
