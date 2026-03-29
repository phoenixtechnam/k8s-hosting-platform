import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { ApplicationCatalogResponse } from '@k8s-hosting/api-contracts';

interface ApplicationCatalogListResponse {
  readonly data: readonly ApplicationCatalogResponse[];
}

export function useApplicationCatalog() {
  return useQuery({
    queryKey: ['application-catalog'],
    queryFn: () => apiFetch<ApplicationCatalogListResponse>('/api/v1/admin/application-catalog'),
    staleTime: 60_000,
  });
}
