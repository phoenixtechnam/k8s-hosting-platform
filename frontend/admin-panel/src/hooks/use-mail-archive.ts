import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  MailArchiveMode,
  MailArchiveStatusResponse,
  MailArchiveListResponse,
  MailArchiveRun,
  MailArchiveTriggerResponse,
  MailArchiveRestoreRequest,
  MailArchiveRestoreResponse,
} from '@k8s-hosting/api-contracts';

const STATUS_KEY = ['mail', 'archive', 'status'] as const;
const LIST_KEY = ['mail', 'archive', 'list'] as const;
const RUN_KEY = (id: string) => ['mail', 'archive', 'run', id] as const;

interface Envelope<T> {
  readonly data: T;
}

/**
 * Status summary for the Mail Archive card.
 * Polls every 5s when a run is in progress, every 30s otherwise.
 */
export function useMailArchiveStatus() {
  return useQuery({
    queryKey: STATUS_KEY,
    queryFn: () => apiFetch<Envelope<MailArchiveStatusResponse>>('/api/v1/admin/mail/archive-status'),
    refetchInterval: (q) => (q.state.data?.data.current ? 5_000 : 30_000),
    retry: false,
  });
}

/** Paginated archive runs for the list table. */
export function useMailArchiveList(limit = 20, offset = 0) {
  return useQuery({
    queryKey: [...LIST_KEY, limit, offset],
    queryFn: () =>
      apiFetch<Envelope<MailArchiveListResponse>>(
        `/api/v1/admin/mail/archive-runs?limit=${limit}&offset=${offset}`,
      ),
    staleTime: 15_000,
    retry: false,
  });
}

/**
 * Live run polling for the progress modal. Stops polling once the run
 * reaches a terminal state.
 */
export function useMailArchiveRun(runId: string | null) {
  return useQuery({
    queryKey: runId ? RUN_KEY(runId) : ['mail', 'archive', 'run', 'none'],
    queryFn: () =>
      runId
        ? apiFetch<Envelope<MailArchiveRun>>(`/api/v1/admin/mail/archive-runs/${runId}`)
        : Promise.reject(new Error('no run id')),
    enabled: Boolean(runId),
    refetchInterval: (q) => {
      const state = q.state.data?.data.state;
      if (state === 'succeeded' || state === 'failed') return false;
      return 3_000;
    },
    retry: false,
  });
}

/**
 * Trigger a new archive run.
 *
 * Pass `mode` to choose between:
 *   - 'no_downtime' (default) — RocksDB-secondary + Checkpoint, live
 *     Stalwart keeps serving mail throughout. Wall time: a few seconds.
 *   - 'downtime' — scale Stalwart to 0, export, scale back. ~60-120s
 *     mail downtime. Belt-and-suspenders option.
 *
 * Omit mode entirely (or pass `{}`) to let the server pick the default.
 */
export function useTriggerMailArchive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input?: { mode?: MailArchiveMode }) =>
      apiFetch<Envelope<MailArchiveTriggerResponse>>('/api/v1/admin/mail/archive/trigger', {
        method: 'POST',
        body: JSON.stringify(input ?? {}),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: STATUS_KEY });
      void qc.invalidateQueries({ queryKey: LIST_KEY });
    },
  });
}

/**
 * Restore from a past archive run. Caller MUST send
 * `confirm: 'yes-replace-live-mail'` (typed via the contract).
 */
export function useRestoreMailArchive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: MailArchiveRestoreRequest) =>
      apiFetch<Envelope<MailArchiveRestoreResponse>>('/api/v1/admin/mail/archive/restore', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: STATUS_KEY });
      void qc.invalidateQueries({ queryKey: LIST_KEY });
    },
  });
}
