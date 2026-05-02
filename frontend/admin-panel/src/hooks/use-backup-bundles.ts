import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  BundleSummary,
  BundleDetail,
  CreateBundleInput,
  VerifyBundleResponse,
} from '@k8s-hosting/api-contracts';

interface ListResponse {
  data: BundleSummary[];
  pagination: { total_count: number; cursor: string | null; has_more: boolean; page_size: number };
}

interface SingleResponse<T> { data: T }

/**
 * List bundles. Optionally filter by clientId. Refetches every 30s
 * so a freshly-created bundle shows up without manual refresh.
 */
export function useBundles(clientId?: string) {
  const path = clientId
    ? `/api/v1/admin/backups/bundles?clientId=${encodeURIComponent(clientId)}`
    : '/api/v1/admin/backups/bundles';
  return useQuery({
    queryKey: ['backup-bundles', clientId ?? 'all'],
    queryFn: () => apiFetch<ListResponse>(path),
    refetchInterval: 30_000,
  });
}

export function useBundleDetail(bundleId: string | null) {
  return useQuery({
    queryKey: ['backup-bundle', bundleId],
    queryFn: () => apiFetch<SingleResponse<BundleDetail>>(`/api/v1/admin/backups/bundles/${bundleId}`),
    enabled: !!bundleId,
  });
}

export function useCreateBundle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateBundleInput) =>
      apiFetch<SingleResponse<{ bundleId: string; status: string }>>('/api/v1/admin/backups/bundles', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['backup-bundles'] });
    },
  });
}

export function useDeleteBundle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (bundleId: string) =>
      apiFetch<void>(`/api/v1/admin/backups/bundles/${bundleId}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['backup-bundles'] });
      // Also invalidate any open detail panels (different key prefix);
      // see use-backup-bundles.ts useBundleDetail.
      qc.invalidateQueries({ queryKey: ['backup-bundle'] });
    },
  });
}

/**
 * Run the round-trip integrity check for a bundle. The endpoint reads
 * every component back from the off-site target, decrypts + parses
 * each, and returns per-component sizes / SHA-256 / row counts.
 * No DB writes — safe to run repeatedly.
 */
export function useVerifyBundle() {
  return useMutation({
    mutationFn: (bundleId: string) =>
      apiFetch<SingleResponse<VerifyBundleResponse>>(`/api/v1/admin/backups/bundles/${bundleId}/verify`, {
        method: 'POST',
      }),
  });
}
