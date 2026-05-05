/**
 * React Query hooks for the per-client backup schedule (Tier-1
 * scheduled tenant bundles).
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  ClientBackupSchedule,
  UpdateClientBackupScheduleInput,
} from '@k8s-hosting/api-contracts';

interface ScheduleResponse { readonly data: ClientBackupSchedule | null }

export function useClientBackupSchedule(clientId: string | null) {
  return useQuery({
    queryKey: ['backup-schedule', clientId],
    enabled: !!clientId,
    queryFn: () => apiFetch<ScheduleResponse>(`/api/v1/admin/clients/${clientId}/backup-schedule`),
  });
}

export function useUpdateClientBackupSchedule(clientId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateClientBackupScheduleInput) =>
      apiFetch<ScheduleResponse>(`/api/v1/admin/clients/${clientId}/backup-schedule`, {
        method: 'PUT',
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['backup-schedule', clientId] }),
  });
}

export function useDeleteClientBackupSchedule(clientId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ data: null }>(`/api/v1/admin/clients/${clientId}/backup-schedule`, {
        method: 'DELETE',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['backup-schedule', clientId] }),
  });
}
