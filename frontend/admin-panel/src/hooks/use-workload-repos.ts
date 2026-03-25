import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface WorkloadRepo {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly branch: string;
  readonly syncIntervalMinutes: number;
  readonly lastSyncedAt: string | null;
  readonly status: 'active' | 'error' | 'syncing';
  readonly lastError: string | null;
  readonly createdAt: string;
}

interface WorkloadReposResponse {
  readonly data: readonly WorkloadRepo[];
}

interface AddWorkloadRepoInput {
  readonly name: string;
  readonly url: string;
  readonly branch?: string;
  readonly auth_token?: string;
}

export function useWorkloadRepos() {
  return useQuery({
    queryKey: ['workload-repos'],
    queryFn: () => apiFetch<WorkloadReposResponse>('/api/v1/admin/workload-repos'),
    staleTime: 60_000,
  });
}

export function useAddWorkloadRepo() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: AddWorkloadRepoInput) =>
      apiFetch<{ data: WorkloadRepo }>('/api/v1/admin/workload-repos', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workload-repos'] });
    },
  });
}

export function useDeleteWorkloadRepo() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/api/v1/admin/workload-repos/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workload-repos'] });
    },
  });
}

export function useSyncWorkloadRepo() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ data: WorkloadRepo }>(`/api/v1/admin/workload-repos/${id}/sync`, {
        method: 'POST',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workload-repos'] });
    },
  });
}
