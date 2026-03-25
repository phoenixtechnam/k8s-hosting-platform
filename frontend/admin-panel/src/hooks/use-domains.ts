import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { Domain, PaginatedResponse } from '@/types/api';

interface ListDomainsParams {
  readonly search?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export function useDomains(clientId: string | undefined, params: ListDomainsParams = {}) {
  const searchParams = new URLSearchParams();
  if (params.search) searchParams.set('search', params.search);
  if (params.limit) searchParams.set('limit', String(params.limit));
  if (params.cursor) searchParams.set('cursor', params.cursor);

  const qs = searchParams.toString();
  const path = `/api/v1/clients/${clientId}/domains${qs ? `?${qs}` : ''}`;

  return useQuery({
    queryKey: ['domains', clientId, params],
    queryFn: () => apiFetch<PaginatedResponse<Domain>>(path),
    enabled: !!clientId,
  });
}

interface CreateDomainInput {
  readonly domain_name: string;
  readonly dns_mode: 'cname' | 'primary' | 'secondary';
}

export function useCreateDomain(clientId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateDomainInput) =>
      apiFetch<{ data: Domain }>(`/api/v1/clients/${clientId}/domains`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['domains', clientId] });
    },
  });
}

export function useDeleteDomain(clientId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (domainId: string) =>
      apiFetch<void>(`/api/v1/clients/${clientId}/domains/${domainId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['domains', clientId] });
    },
  });
}
