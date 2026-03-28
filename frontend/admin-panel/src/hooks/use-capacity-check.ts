import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

interface CapacityCheckResult {
  readonly totalCpu: number;
  readonly totalMemory: number;
  readonly totalStorage: number;
  readonly allocatedCpu: number;
  readonly allocatedMemory: number;
  readonly allocatedStorage: number;
  readonly requestedCpu: number;
  readonly requestedMemory: number;
  readonly requestedStorage: number;
  readonly fits: boolean;
  readonly warnings: readonly string[];
}

interface CapacityCheckResponse {
  readonly data: CapacityCheckResult;
}

export function useCapacityCheck(cpu: string, memory: string, storage: string, enabled = true) {
  return useQuery({
    queryKey: ['capacity-check', cpu, memory, storage],
    queryFn: () =>
      apiFetch<CapacityCheckResponse>('/api/v1/admin/platform/capacity-check', {
        method: 'POST',
        body: JSON.stringify({ cpu, memory, storage }),
      }),
    enabled,
    staleTime: 30_000,
  });
}
