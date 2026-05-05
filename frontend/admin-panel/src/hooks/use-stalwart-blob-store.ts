import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  BlobStoreResponse,
  BlobStoreUpdateRequest,
  BlobStoreUpdateResponse,
  BlobStoreJobStatusResponse,
} from '@k8s-hosting/api-contracts';

interface BlobStoreEnvelope {
  readonly data: BlobStoreResponse;
}
interface UpdateEnvelope {
  readonly data: BlobStoreUpdateResponse;
}
interface JobStatusEnvelope {
  readonly data: BlobStoreJobStatusResponse;
}

const STORE_KEY = ['mail', 'blob-store'] as const;

/** Read the live BlobStore singleton type + non-secret config. */
export function useBlobStore() {
  return useQuery({
    queryKey: STORE_KEY,
    queryFn: () => apiFetch<BlobStoreEnvelope>('/api/v1/admin/mail/blob-store'),
    staleTime: 10_000,
    retry: false,
  });
}

/**
 * Switch the BlobStore backend. Backend spawns a Job that runs
 * stalwart-cli update + self-verify; this mutation returns the Job
 * name + initial status. The card then polls
 * useBlobStoreJobStatus(jobName) until completion.
 *
 * On Job success, invalidate the GET so the card shows the new
 * backend type.
 */
export function useUpdateBlobStore() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BlobStoreUpdateRequest) =>
      apiFetch<UpdateEnvelope>('/api/v1/admin/mail/blob-store', {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      // Don't invalidate yet — the Job hasn't run. The poll hook's
      // onSuccess invalidates after observing job.status === 'succeeded'.
      void qc;
    },
  });
}

/** Poll a blob-store-update Job's status until terminal. */
export function useBlobStoreJobStatus(jobName: string | null) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: ['mail', 'blob-store', 'jobs', jobName],
    queryFn: async () => {
      const result = await apiFetch<JobStatusEnvelope>(
        `/api/v1/admin/mail/blob-store/jobs/${encodeURIComponent(jobName ?? '')}`,
      );
      // Invalidate the live BlobStore GET when the Job lands in a
      // terminal state so the card reflects the new backend.
      if (result.data.status === 'succeeded' || result.data.status === 'failed') {
        qc.invalidateQueries({ queryKey: STORE_KEY });
      }
      return result;
    },
    enabled: jobName !== null,
    refetchInterval: (query) => {
      const data = query.state.data?.data;
      if (!data) return 3_000;
      return data.status === 'succeeded' || data.status === 'failed' ? false : 3_000;
    },
  });
}
