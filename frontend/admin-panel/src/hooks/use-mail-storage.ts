import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  MailPvcStorageResponse,
  MailPvcResizeRequest,
  MailPvcResizeResponse,
} from '@k8s-hosting/api-contracts';

interface StorageEnvelope {
  readonly data: MailPvcStorageResponse;
}
interface ResizeEnvelope {
  readonly data: MailPvcResizeResponse;
}

const STORAGE_KEY = ['mail', 'pvc', 'storage'] as const;

/**
 * Read live mail-pg-1 PVC state. `staleTime: 5_000` because the
 * grow flow polls capacity convergence — operators expect fresh
 * numbers within a few seconds of the patch landing.
 */
export function useMailPvcStorage() {
  return useQuery({
    queryKey: STORAGE_KEY,
    queryFn: () => apiFetch<StorageEnvelope>('/api/v1/admin/mail/pvc/storage'),
    staleTime: 5_000,
    retry: false,
  });
}

/**
 * Online-grow the PVC. Backend rejects shrink + same-size + SC-no-
 * expansion BEFORE patching, so a 4xx here is operator-actionable.
 *
 * onSuccess invalidates the GET so the card refetches the new
 * requestedBytes immediately. Capacity may still lag for ~30-60s
 * while Longhorn extends the volume + kubelet runs filesystem
 * resize; the UI shows a "extending..." spinner driven by the
 * requested-vs-capacity delta.
 */
export function useResizeMailPvc() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: MailPvcResizeRequest) =>
      apiFetch<ResizeEnvelope>('/api/v1/admin/mail/pvc/storage', {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: STORAGE_KEY }),
  });
}
