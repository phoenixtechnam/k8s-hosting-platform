import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface Plan {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly cpuLimit: string;
  readonly memoryLimit: string;
  readonly storageLimit: string;
  readonly monthlyPriceUsd: string;
  readonly maxSubUsers: number;
  readonly maxMailboxes: number;
  readonly status: string;
}

export interface Region {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly provider: string;
  readonly status: string;
}

export function usePlans() {
  return useQuery({
    queryKey: ['plans'],
    queryFn: () => apiFetch<{ data: readonly Plan[] }>('/api/v1/plans'),
    staleTime: 300_000,
  });
}

export function useRegions() {
  return useQuery({
    queryKey: ['regions'],
    queryFn: () => apiFetch<{ data: readonly Region[] }>('/api/v1/regions'),
    staleTime: 300_000,
  });
}
