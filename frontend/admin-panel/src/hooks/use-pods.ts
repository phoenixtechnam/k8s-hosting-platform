import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface PodEntry {
  readonly name: string;
  readonly namespace: string;
  readonly phase: string;
  readonly classification:
    | 'running'
    | 'not_ready'
    | 'pending'
    | 'completed'
    | 'failed'
    | 'orphaned'
    | 'unknown';
  readonly isOrphaned: boolean;
  readonly ready: boolean;
  readonly restarts: number;
  readonly waitingReason: string | null;
  readonly node: string | null;
  readonly age: string | null;
}

export interface PodCapacity {
  readonly total: number;
  readonly allocatable: number;
  readonly used: number;
}

interface PodsResponse {
  readonly capacity: PodCapacity;
  readonly pods: readonly PodEntry[];
}

export function usePods() {
  return useQuery({
    queryKey: ['admin', 'pods'],
    queryFn: () => apiFetch<{ data: PodsResponse }>('/api/v1/admin/pods'),
    refetchInterval: 15_000,
  });
}
