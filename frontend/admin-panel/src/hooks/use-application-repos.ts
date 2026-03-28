import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { ApplicationRepoResponse, AddAppRepoInput } from '@k8s-hosting/api-contracts';

interface ApplicationReposResponse {
  readonly data: readonly ApplicationRepoResponse[];
}

export function useApplicationRepos() {
  return useQuery({
    queryKey: ['application-repos'],
    queryFn: () => apiFetch<ApplicationReposResponse>('/api/v1/admin/application-repos'),
    staleTime: 60_000,
  });
}

export function useRestoreDefaultAppRepo() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      apiFetch<{ data: ApplicationRepoResponse }>('/api/v1/admin/application-repos/restore-default', {
        method: 'POST',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['application-repos'] });
      queryClient.invalidateQueries({ queryKey: ['application-catalog'] });
    },
  });
}

export function useAddApplicationRepo() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: AddAppRepoInput) =>
      apiFetch<{ data: ApplicationRepoResponse }>('/api/v1/admin/application-repos', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['application-repos'] });
    },
  });
}

export function useDeleteApplicationRepo() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/api/v1/admin/application-repos/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['application-repos'] });
      queryClient.invalidateQueries({ queryKey: ['application-catalog'] });
    },
  });
}

export function useSyncApplicationRepo() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ data: ApplicationRepoResponse }>(`/api/v1/admin/application-repos/${id}/sync`, {
        method: 'POST',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['application-repos'] });
      queryClient.invalidateQueries({ queryKey: ['application-catalog'] });
    },
  });
}
