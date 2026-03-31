import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { CronJob, PaginatedResponse } from '@/types/api';

interface UseCronJobsParams {
  readonly clientId?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export function useCronJobs(params: UseCronJobsParams = {}) {
  const { clientId, limit, cursor } = params;

  const searchParams = new URLSearchParams();
  if (limit) searchParams.set('limit', String(limit));
  if (cursor) searchParams.set('cursor', cursor);

  const qs = searchParams.toString();
  const basePath = clientId
    ? `/api/v1/clients/${clientId}/cron-jobs`
    : `/api/v1/admin/cron-jobs`;
  const path = `${basePath}${qs ? `?${qs}` : ''}`;

  return useQuery({
    queryKey: ['cron-jobs', clientId ?? 'all', { limit, cursor }],
    queryFn: () => apiFetch<PaginatedResponse<CronJob>>(path),
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

export function useUpdateCronJob(clientId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ cronJobId, ...input }: { cronJobId: string; enabled?: boolean }) =>
      apiFetch<{ data: CronJob }>(`/api/v1/clients/${clientId}/cron-jobs/${cronJobId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cron-jobs'] });
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
      queryClient.invalidateQueries({ queryKey: ['cron-jobs'] });
    },
  });
}

export function useDeleteCronJob(clientId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (cronJobId: string) =>
      apiFetch<void>(`/api/v1/clients/${clientId}/cron-jobs/${cronJobId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cron-jobs', clientId] });
    },
  });
}
