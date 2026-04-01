import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { PaginatedResponse } from '@/types/api';
import type { CatalogEntry } from '@/types/api';

export function useCatalog(type?: string) {
  const params = new URLSearchParams();
  if (type) params.set('type', type);
  const qs = params.toString();
  return useQuery({
    queryKey: ['catalog', type],
    queryFn: () => apiFetch<PaginatedResponse<CatalogEntry>>(`/api/v1/catalog${qs ? `?${qs}` : ''}`),
    staleTime: 300_000,
  });
}

export function useCatalogEntry(id: string | undefined) {
  return useQuery({
    queryKey: ['catalog', id],
    queryFn: () => apiFetch<{ data: CatalogEntry }>(`/api/v1/catalog/${id}`),
    enabled: Boolean(id),
  });
}
