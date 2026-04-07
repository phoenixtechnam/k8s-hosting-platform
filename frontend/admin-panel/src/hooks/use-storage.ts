import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  StorageOverviewResponse,
  ImageInventoryResponse,
  PurgeImagesResponse,
} from '@k8s-hosting/api-contracts';

export function useStorageOverview() {
  return useQuery({
    queryKey: ['storage-overview'],
    queryFn: () => apiFetch<{ data: StorageOverviewResponse }>('/api/v1/admin/storage/overview'),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}

export function useImageInventory() {
  return useQuery({
    queryKey: ['storage-images'],
    queryFn: () => apiFetch<{ data: ImageInventoryResponse }>('/api/v1/admin/storage/images'),
    staleTime: 60_000,
  });
}

export function usePurgeImages() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { dryRun: boolean }) =>
      apiFetch<{ data: PurgeImagesResponse }>('/api/v1/admin/storage/purge', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: (_data, variables) => {
      if (!variables.dryRun) {
        queryClient.invalidateQueries({ queryKey: ['storage-overview'] });
        queryClient.invalidateQueries({ queryKey: ['storage-images'] });
      }
    },
  });
}
