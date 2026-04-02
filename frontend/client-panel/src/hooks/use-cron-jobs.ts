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
  readonly type: 'webcron' | 'deployment';
  readonly schedule: string;
  readonly url?: string;
  readonly http_method?: 'GET' | 'POST' | 'PUT';
  readonly command?: string;
  readonly deployment_id?: string;
  readonly enabled?: boolean;
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

export function useUpdateCronJob(clientId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ cronJobId, ...input }: { cronJobId: string; enabled?: boolean }) =>
      apiFetch<{ data: CronJob }>(`/api/v1/clients/${clientId}/cron-jobs/${cronJobId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cron-jobs', clientId] });
    },
  });
}

export function useRunCronJob(clientId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (cronJobId: string) =>
      apiFetch<{ data: CronJob }>(`/api/v1/clients/${clientId}/cron-jobs/${cronJobId}/run`, {
        method: 'POST',
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
