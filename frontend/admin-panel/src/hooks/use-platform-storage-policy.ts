import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  GetPlatformStoragePolicyResponse,
  ApplyPlatformStoragePolicyResponse,
  UpdatePlatformStoragePolicyInput,
} from '@k8s-hosting/api-contracts';

export function usePlatformStoragePolicy() {
  return useQuery({
    queryKey: ['platform-storage-policy'],
    queryFn: () => apiFetch<{ data: GetPlatformStoragePolicyResponse }>(
      '/api/v1/admin/platform-storage-policy',
    ),
    refetchInterval: 30_000,
  });
}

export function useUpdatePlatformStoragePolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdatePlatformStoragePolicyInput) =>
      apiFetch<{ data: ApplyPlatformStoragePolicyResponse }>(
        '/api/v1/admin/platform-storage-policy',
        { method: 'PATCH', body: JSON.stringify(input) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['platform-storage-policy'] });
    },
  });
}
