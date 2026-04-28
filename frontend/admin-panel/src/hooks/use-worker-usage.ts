import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

/**
 * Per-tenant-capable-node free vs total capacity. Powers the worker
 * selector dropdown in the Placement card so the operator can pick
 * the node with the most headroom — or accept Auto and let the
 * platform choose.
 */
export interface WorkerUsage {
  readonly name: string;
  readonly displayName: string | null;
  readonly cpuMillicoresAllocatable: number | null;
  readonly cpuMillicoresUsed: number | null;
  readonly memoryBytesAllocatable: number | null;
  readonly memoryBytesUsed: number | null;
  readonly diskBytesTotal: number | null;
  readonly diskBytesFree: number | null;
}

interface Envelope { readonly data: readonly WorkerUsage[]; }

export function useWorkerUsageSummary() {
  return useQuery({
    queryKey: ['worker-usage-summary'],
    queryFn: () => apiFetch<Envelope>('/api/v1/admin/nodes/worker-usage-summary'),
    // Usage drifts; 30s cache is enough for an interactive dropdown.
    staleTime: 30_000,
  });
}
