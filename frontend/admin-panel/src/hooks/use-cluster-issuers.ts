import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface ClusterIssuerInfo {
  readonly name: string;
  readonly ready: boolean;
}

interface ClusterIssuersResponse {
  readonly data: ReadonlyArray<ClusterIssuerInfo>;
}

/**
 * Fetch cert-manager ClusterIssuers via the Admin API. The backend
 * returns an empty array if cert-manager isn't reachable — callers
 * should fall back to a free-text input in that case.
 */
export function useClusterIssuers() {
  return useQuery<ClusterIssuersResponse>({
    queryKey: ['cluster-issuers'],
    queryFn: () => apiFetch('/api/v1/admin/cluster-issuers'),
    staleTime: 30_000,
  });
}
