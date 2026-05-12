import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  MailSnapshotStatusResponse,
  MailSnapshotTriggerResponse,
  MailSnapshotJobStatusResponse,
} from '@k8s-hosting/api-contracts';

interface StatusEnvelope {
  readonly data: MailSnapshotStatusResponse;
}
interface TriggerEnvelope {
  readonly data: MailSnapshotTriggerResponse;
}
interface JobStatusEnvelope {
  readonly data: MailSnapshotJobStatusResponse;
}

const STATUS_KEY = ['mail', 'snapshot', 'status'] as const;

/** Poll the mail snapshot health endpoint every 30s. */
export function useMailSnapshotStatus() {
  return useQuery({
    queryKey: STATUS_KEY,
    queryFn: () => apiFetch<StatusEnvelope>('/api/v1/admin/mail/snapshot-status'),
    refetchInterval: 30_000,
    staleTime: 10_000,
    retry: false,
  });
}

/**
 * Trigger a one-shot snapshot Job. Returns the Job name + startedAt so
 * the card can hand off to useMailSnapshotJobStatus for live polling.
 */
export function useTriggerMailSnapshot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<TriggerEnvelope>('/api/v1/admin/mail/snapshot/trigger', {
        method: 'POST',
      }),
    onSuccess: () => {
      // Snapshot just ran — invalidate status so the card picks up the new
      // lastSnapshotAt once the Job completes and the backend re-reads S3.
      void qc;
    },
  });
}

/** Poll a snapshot Job's status at 3s intervals until terminal. */
export function useMailSnapshotJobStatus(jobName: string | null) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: ['mail', 'snapshot', 'jobs', jobName],
    queryFn: async () => {
      const result = await apiFetch<JobStatusEnvelope>(
        `/api/v1/admin/mail/snapshot/jobs/${encodeURIComponent(jobName ?? '')}`,
      );
      // On terminal state, invalidate the status GET so lastSnapshotAt refreshes.
      if (result.data.status === 'succeeded' || result.data.status === 'failed') {
        void qc.invalidateQueries({ queryKey: STATUS_KEY });
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
