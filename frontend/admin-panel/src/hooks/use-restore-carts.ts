/**
 * React Query hooks for the tenant-backup-restore cart APIs (ADR-034).
 *
 * Mirrors the backend's POST /admin/restores/carts + bundle-browse
 * routes. Types are imported from @k8s-hosting/api-contracts so the
 * UI and backend can never drift.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  RestoreJobDetail,
  RestoreJobSummary,
  RestoreItemInfo,
  RestoreItemPayload,
  RestoreItemType,
} from '@k8s-hosting/api-contracts';

interface CartDetailResponse { readonly data: RestoreJobDetail }
interface CartSummaryResponse { readonly data: RestoreJobSummary }
interface CartItemResponse { readonly data: RestoreItemInfo }
// API envelope: success() wraps the handler's payload as {data: ...}.
// The list handler returns success({data: [...]}) so the over-the-wire
// shape is {data: {data: [...]}}. Earlier this interface declared
// only one level of `data` — consumers that did `q.data?.data ?? []`
// got the inner ENVELOPE OBJECT (not an array), and calling .map()
// on it threw "s.map is not a function" once any cart existed.
interface CartListResponse { readonly data: { readonly data: ReadonlyArray<RestoreJobSummary> } }

/**
 * List recent restore carts. Auto-refreshes every 30s so an
 * operator watching a long-running cart sees status flips without
 * a manual refresh.
 */
export function useRestoreCarts(filters: { clientId?: string; status?: string } = {}) {
  return useQuery({
    queryKey: ['restore-carts', filters],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (filters.clientId) qs.set('clientId', filters.clientId);
      if (filters.status) qs.set('status', filters.status);
      const suffix = qs.toString() ? `?${qs.toString()}` : '';
      return apiFetch<CartListResponse>(`/api/v1/admin/restores/carts${suffix}`);
    },
    refetchInterval: 30_000,
  });
}

export function useRestoreCart(cartId: string | null) {
  return useQuery({
    queryKey: ['restore-cart', cartId],
    enabled: !!cartId,
    queryFn: () => apiFetch<CartDetailResponse>(`/api/v1/admin/restores/carts/${cartId}`),
  });
}

export function useCreateRestoreCart() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { clientId: string; description?: string }) =>
      apiFetch<CartSummaryResponse>('/api/v1/admin/restores/carts', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: (resp) => qc.invalidateQueries({ queryKey: ['restore-cart', resp.data.id] }),
  });
}

export function useAddRestoreItem(cartId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RestoreItemPayload & { bundleId: string; label?: string }) =>
      apiFetch<CartItemResponse>(`/api/v1/admin/restores/carts/${cartId}/items`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['restore-cart', cartId] }),
  });
}

export function useRemoveRestoreItem(cartId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (itemId: string) =>
      apiFetch<{ data: null }>(`/api/v1/admin/restores/carts/${cartId}/items/${itemId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['restore-cart', cartId] }),
  });
}

export function useExecuteRestoreCart(cartId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<CartDetailResponse>(`/api/v1/admin/restores/carts/${cartId}/execute`, {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['restore-cart', cartId] }),
  });
}

export function useRollbackRestoreCart(cartId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ data: { cartId: string; operationId: string; snapshotId: string } }>(`/api/v1/admin/restores/carts/${cartId}/rollback`, {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['restore-cart', cartId] }),
  });
}

export function useDeleteRestoreCart() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (cartId: string) =>
      apiFetch<{ data: null }>(`/api/v1/admin/restores/carts/${cartId}`, {
        method: 'DELETE',
      }),
    onSuccess: (_, cartId) => qc.invalidateQueries({ queryKey: ['restore-cart', cartId] }),
  });
}

// ── Bundle browse ───────────────────────────────────────────────────

interface BrowseConfigTablesResponse {
  readonly data: { readonly bundleId: string; readonly tables: ReadonlyArray<{ name: string; rowCount: number }> };
}
export function useBrowseConfigTables(bundleId: string | null) {
  return useQuery({
    queryKey: ['restore-browse', 'config-tables', bundleId],
    enabled: !!bundleId,
    queryFn: () => apiFetch<BrowseConfigTablesResponse>(`/api/v1/admin/tenant-bundles/${bundleId}/browse/config-tables`),
  });
}

interface BrowseMailboxesResponse {
  readonly data: { readonly bundleId: string; readonly addresses: ReadonlyArray<string> };
}
export function useBrowseMailboxes(bundleId: string | null) {
  return useQuery({
    queryKey: ['restore-browse', 'mailboxes', bundleId],
    enabled: !!bundleId,
    queryFn: () => apiFetch<BrowseMailboxesResponse>(`/api/v1/admin/tenant-bundles/${bundleId}/browse/mailboxes`),
  });
}

interface BrowseDeploymentsResponse {
  readonly data: { readonly bundleId: string; readonly deployments: ReadonlyArray<{ id: string; name: string }> };
}
export function useBrowseDeployments(bundleId: string | null) {
  return useQuery({
    queryKey: ['restore-browse', 'deployments', bundleId],
    enabled: !!bundleId,
    queryFn: () => apiFetch<BrowseDeploymentsResponse>(`/api/v1/admin/tenant-bundles/${bundleId}/browse/deployments`),
  });
}

interface BrowseDomainsResponse {
  readonly data: { readonly bundleId: string; readonly domains: ReadonlyArray<{ id: string; hostname: string }> };
}
export function useBrowseDomains(bundleId: string | null) {
  return useQuery({
    queryKey: ['restore-browse', 'domains', bundleId],
    enabled: !!bundleId,
    queryFn: () => apiFetch<BrowseDomainsResponse>(`/api/v1/admin/tenant-bundles/${bundleId}/browse/domains`),
  });
}

interface BrowseFilesResponse {
  readonly data: {
    readonly bundleId: string;
    readonly totalCount: number;
    readonly entries: ReadonlyArray<{ path: string; size: number; mode: number; mtime: string }>;
    readonly nextCursor: string | null;
  };
}
export function useBrowseFiles(bundleId: string | null, after: string | null, limit = 500) {
  return useQuery({
    queryKey: ['restore-browse', 'files', bundleId, after, limit],
    enabled: !!bundleId,
    queryFn: () => {
      const qs = new URLSearchParams({ limit: String(limit) });
      if (after) qs.set('after', after);
      return apiFetch<BrowseFilesResponse>(`/api/v1/admin/tenant-bundles/${bundleId}/browse/files/tree?${qs.toString()}`);
    },
  });
}

export type { RestoreItemType, RestoreItemInfo };
