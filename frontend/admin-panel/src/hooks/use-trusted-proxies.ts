/**
 * Trusted upstream-proxy CIDRs — operator-managed list.
 *
 *   GET    /admin/cluster-network/trusted-proxies
 *   POST   /admin/cluster-network/trusted-proxies
 *   DELETE /admin/cluster-network/trusted-proxies/:id
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  CreateTrustedProxyRangeRequest,
  ListTrustedProxyRangesResponse,
} from '@k8s-hosting/api-contracts';

interface Envelope<T> { readonly data: T; }

const TRUSTED_PROXIES_KEY = ['cluster-network', 'trusted-proxies'] as const;

export function useTrustedProxies() {
  return useQuery({
    queryKey: TRUSTED_PROXIES_KEY,
    queryFn: async (): Promise<ListTrustedProxyRangesResponse> => {
      const body = await apiFetch<Envelope<ListTrustedProxyRangesResponse>>(
        '/api/v1/admin/cluster-network/trusted-proxies',
      );
      return body.data;
    },
    // Refresh every 10s while the page is open so the operator sees
    // "panel pods rolled" progress without a manual refresh after add/delete.
    refetchInterval: 10_000,
  });
}

export function useCreateTrustedProxy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTrustedProxyRangeRequest) =>
      apiFetch('/api/v1/admin/cluster-network/trusted-proxies', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: TRUSTED_PROXIES_KEY });
    },
  });
}

export function useDeleteTrustedProxy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch(
        `/api/v1/admin/cluster-network/trusted-proxies/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: TRUSTED_PROXIES_KEY });
    },
  });
}
