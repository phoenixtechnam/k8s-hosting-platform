import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { CronJob, PaginatedResponse } from '@/types/api';

export function useCronJobs(clientId: string | undefined) {
  return useQuery({
    queryKey: ['cron-jobs', clientId],
    queryFn: () => apiFetch<PaginatedResponse<CronJob>>(`/api/v1/clients/${clientId}/cron-jobs`),
    enabled: Boolean(clientId),
  });
}

interface CreateCronJobInput {
  readonly name: string;
  readonly schedule: string;
  readonly command: string;
  readonly enabled: boolean;
}

export function useCreateCronJob(clientId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCronJobInput) =>
      apiFetch<{ data: CronJob }>(`/api/v1/clients/${clientId}/cron-jobs`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cron-jobs', clientId] });
    },
  });
}

export function useDeleteCronJob(clientId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (cronJobId: string) =>
      apiFetch<void>(`/api/v1/clients/${clientId}/cron-jobs/${cronJobId}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cron-jobs', clientId] });
    },
  });
}
