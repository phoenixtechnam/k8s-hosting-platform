// Task Tracker hooks — chip + popover read state.
//
// Phase 1 ships with polling. The SSE endpoint (`/me/tasks/stream`) is
// implemented on the backend but Phase 1 frontend uses TanStack Query
// adaptive polling: 3 s when any task is running, 30 s idle. SSE wiring
// is Phase 5 polish — polling delivers the user-visible behaviour
// (chip lights up, count is right, click opens modal) at < 30 s
// resolution which is acceptable for the chip's purpose.

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

/**
 * Read the chip's working set: in-flight + recent terminal (≤ 5 min)
 * tasks for the current user. Adaptive cadence — 3 s while anything
 * is running, 30 s when idle.
 */
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
    // Always refetch on window focus — operators come back to the tab
    // and want a fresh count immediately.
    refetchOnWindowFocus: 'always',
  });
}

export function useClearTasks() {
  const qc = useQueryClient();
  return useMutation({
    // Tagged so the global MutationCache subscriber (App.tsx) skips it
    // — otherwise clearing tasks would trigger a chip refetch that
    // immediately re-fetches the just-cleared list.
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
 *
 * Usage in a trigger mutation:
 *
 *   const refreshTasks = useRefreshTaskCenter();
 *   const startBackup = useMutation({
 *     mutationFn: () => apiFetch('/.../start', { method: 'POST' }),
 *     onSuccess: () => refreshTasks(),
 *   });
 */
export function useRefreshTaskCenter() {
  const qc = useQueryClient();
  return useCallback(() => {
    void qc.invalidateQueries({ queryKey: TASK_CENTER_QUERY_KEY });
  }, [qc]);
}
