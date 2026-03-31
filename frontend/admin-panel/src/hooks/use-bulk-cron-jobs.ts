import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

interface BulkResult {
  readonly data: {
    readonly succeeded: readonly string[];
    readonly failed: readonly { readonly id: string; readonly error: string }[];
  };
}

export function useBulkEnableCronJobs() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (cronJobIds: readonly string[]) =>
      apiFetch<BulkResult>('/api/v1/admin/cron-jobs/bulk', {
        method: 'POST',
        body: JSON.stringify({ cron_job_ids: cronJobIds, action: 'enable' }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cron-jobs'] });
    },
  });
}

export function useBulkDisableCronJobs() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (cronJobIds: readonly string[]) =>
      apiFetch<BulkResult>('/api/v1/admin/cron-jobs/bulk', {
        method: 'POST',
        body: JSON.stringify({ cron_job_ids: cronJobIds, action: 'disable' }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cron-jobs'] });
    },
  });
}

export function useBulkDeleteCronJobs() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (cronJobIds: readonly string[]) =>
      apiFetch<BulkResult>('/api/v1/admin/cron-jobs/bulk', {
        method: 'POST',
        body: JSON.stringify({ cron_job_ids: cronJobIds, action: 'delete' }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cron-jobs'] });
    },
  });
}
