import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  SystemPvcStorageResponse,
  SystemPvcResizeRequest,
  SystemPvcResizeResponse,
} from '@k8s-hosting/api-contracts';

interface StorageEnvelope {
  readonly data: SystemPvcStorageResponse;
}
interface ResizeEnvelope {
  readonly data: SystemPvcResizeResponse;
}

const STORAGE_KEY = ['system', 'pvc', 'storage'] as const;

/**
 * Read live system-db-1 PVC state. `staleTime: 5_000` because the
 * grow flow polls capacity convergence — operators expect fresh
 * numbers within a few seconds of the patch landing.
 */
export function useSystemPvcStorage() {
  return useQuery({
    queryKey: STORAGE_KEY,
    queryFn: () => apiFetch<StorageEnvelope>('/api/v1/admin/system/pvc/storage'),
    staleTime: 5_000,
    retry: false,
  });
}

/**
 * Online-grow the PVC. Backend rejects shrink + same-size + SC-no-
 * expansion BEFORE patching, so a 4xx here is operator-actionable.
 */
export function useResizeSystemPvc() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SystemPvcResizeRequest) =>
      apiFetch<ResizeEnvelope>('/api/v1/admin/system/pvc/storage', {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: STORAGE_KEY }),
  });
}
