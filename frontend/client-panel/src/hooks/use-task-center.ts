// Client-panel mirror of admin-panel/src/hooks/use-task-center.ts.
// The endpoint is the same `/api/v1/me/tasks` — backend filters rows
// by user_id == jwt.sub, so a client_admin user only sees the tasks
// they themselves initiated (storage ops, restore-cart runs, etc.).
// Admin-initiated bulk ops affecting the tenant are NOT visible
// (different user_id).

import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  ClearTasksResponse,
  MeTasksSnapshotResponse,
  TaskRow,
} from '@k8s-hosting/api-contracts';

export const TASK_CENTER_QUERY_KEY = ['task-center', 'me'] as const;

const POLL_RUNNING_MS = 3_000;
const POLL_IDLE_MS = 30_000;

export function useTaskCenter() {
  return useQuery({
    queryKey: TASK_CENTER_QUERY_KEY,
    queryFn: () => apiFetch<MeTasksSnapshotResponse>('/api/v1/me/tasks'),
    staleTime: 1_000,
    refetchInterval: (query) => {
      const tasks = query.state.data?.data?.tasks ?? [];
      const anyRunning = tasks.some(
        (t: TaskRow) => t.status === 'queued' || t.status === 'running',
      );
      return anyRunning ? POLL_RUNNING_MS : POLL_IDLE_MS;
    },
    refetchOnWindowFocus: 'always',
  });
}

export function useClearTasks() {
  const qc = useQueryClient();
  return useMutation({
    // Tagged so the global MutationCache subscriber (App.tsx) skips it.
    mutationKey: ['task-center', 'clear'],
    mutationFn: (ids?: readonly string[]) =>
      apiFetch<ClearTasksResponse>('/api/v1/me/tasks/clear', {
        method: 'POST',
        body: JSON.stringify(ids ? { ids: [...ids] } : {}),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: TASK_CENTER_QUERY_KEY });
    },
  });
}

/**
 * Returns a function that mutations triggering long-running ops can
 * call to force-refetch the chip immediately. Without this, a new task
 * row only surfaces on the next 3 s polling tick — perceptible lag for
 * a click-to-spinner UX.
 */
export function useRefreshTaskCenter() {
  const qc = useQueryClient();
  return useCallback(() => {
    void qc.invalidateQueries({ queryKey: TASK_CENTER_QUERY_KEY });
  }, [qc]);
}
