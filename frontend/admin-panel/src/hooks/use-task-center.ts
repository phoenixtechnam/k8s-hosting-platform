// Task Tracker hooks — chip + popover read state.
//
// Phase 1 ships with polling. The SSE endpoint (`/me/tasks/stream`) is
// implemented on the backend but Phase 1 frontend uses TanStack Query
// adaptive polling: 3 s when any task is running, 30 s idle. SSE wiring
// is Phase 5 polish — polling delivers the user-visible behaviour
// (chip lights up, count is right, click opens modal) at < 30 s
// resolution which is acceptable for the chip's purpose.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  ClearTasksResponse,
  MeTasksSnapshotResponse,
  TaskRow,
} from '@k8s-hosting/api-contracts';

const POLL_RUNNING_MS = 3_000;
const POLL_IDLE_MS = 30_000;

/**
 * Read the chip's working set: in-flight + recent terminal (≤ 5 min)
 * tasks for the current user. Adaptive cadence — 3 s while anything
 * is running, 30 s when idle.
 */
export function useTaskCenter() {
  return useQuery({
    queryKey: ['task-center', 'me'],
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
    mutationFn: (ids?: readonly string[]) =>
      apiFetch<ClearTasksResponse>('/api/v1/me/tasks/clear', {
        method: 'POST',
        body: JSON.stringify(ids ? { ids: [...ids] } : {}),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['task-center', 'me'] });
    },
  });
}
