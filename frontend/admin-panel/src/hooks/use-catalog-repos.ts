import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface CatalogRepo {
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

interface CatalogReposResponse {
  readonly data: readonly CatalogRepo[];
}

interface AddCatalogRepoInput {
  readonly name: string;
  readonly url: string;
  readonly branch?: string;
  readonly auth_token?: string;
}

export function useCatalogRepos() {
  return useQuery({
    queryKey: ['catalog-repos'],
    queryFn: () => apiFetch<CatalogReposResponse>('/api/v1/admin/catalog-repos'),
    staleTime: 60_000,
  });
}

export function useRestoreDefaultCatalogRepo() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      apiFetch<{ data: CatalogRepo }>('/api/v1/admin/catalog-repos/restore-default', {
        method: 'POST',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['catalog-repos'] });
      queryClient.invalidateQueries({ queryKey: ['catalog'] });
    },
  });
}

export function useAddCatalogRepo() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: AddCatalogRepoInput) =>
      apiFetch<{ data: CatalogRepo }>('/api/v1/admin/catalog-repos', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['catalog-repos'] });
    },
  });
}

export function useDeleteCatalogRepo() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/api/v1/admin/catalog-repos/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['catalog-repos'] });
      queryClient.invalidateQueries({ queryKey: ['catalog'] });
    },
  });
}

export function useSyncCatalogRepo() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ data: CatalogRepo }>(`/api/v1/admin/catalog-repos/${id}/sync`, {
        method: 'POST',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['catalog-repos'] });
      queryClient.invalidateQueries({ queryKey: ['catalog'] });
    },
  });
}
