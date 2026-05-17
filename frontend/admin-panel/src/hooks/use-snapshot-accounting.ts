import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { SnapshotAccountingResponse } from '@k8s-hosting/api-contracts';

interface ApiEnvelope<T> {
  readonly data: T;
}

/**
 * Per-class + per-tenant snapshot byte rollup powering the Storage >
 * Overview accountability tile. The underlying query touches every row
 * of storage_snapshots so we don't want to fetch on every render.
 *
 * - staleTime 30 s: stops a tab-focus refetch from firing within a 30 s
 *   window. Only meaningful on the first render after the panel mounts.
 * - refetchInterval 60 s: unconditional periodic refresh while the
 *   panel is open. Always fires regardless of staleTime — TanStack
 *   Query v5 treats refetchInterval as authoritative once set.
 *
 * Net: at most one fetch per 60 s while the panel is mounted, plus
 * one on mount (or focus if 30 s since the last) — bounded write load
 * on the DB even with many admin tabs open.
 */
export function useSnapshotAccounting() {
  return useQuery<ApiEnvelope<SnapshotAccountingResponse>>({
    queryKey: ['snapshot-accounting'],
    queryFn: () => apiFetch('/api/v1/admin/storage/snapshot-accounting'),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}
