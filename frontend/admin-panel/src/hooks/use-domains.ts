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
  const path = clientId
    ? `/api/v1/clients/${clientId}/domains${qs ? `?${qs}` : ''}`
    : `/api/v1/admin/domains${qs ? `?${qs}` : ''}`;

  return useQuery({
    queryKey: ['domains', clientId ?? 'all', params],
    queryFn: () => apiFetch<PaginatedResponse<Domain>>(path),
  });
}

interface CreateDomainInput {
  readonly domain_name: string;
  readonly dns_mode: 'cname' | 'primary' | 'secondary';
  readonly deployment_id?: string;
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

interface UpdateDomainInput {
  readonly dns_mode?: 'cname' | 'primary' | 'secondary';
  readonly ssl_auto_renew?: boolean;
  readonly deployment_id?: string | null;
  readonly status?: 'active' | 'pending' | 'suspended' | 'deleted';
}

export function useUpdateDomain(clientId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ domainId, ...input }: UpdateDomainInput & { domainId: string }) =>
      apiFetch<{ data: Domain }>(`/api/v1/clients/${clientId}/domains/${domainId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['domains'] });
    },
  });
}

export interface VerificationCheck {
  readonly type: string;
  readonly status: 'pass' | 'fail';
  readonly detail: string;
}

export interface VerificationResult {
  readonly verified: boolean;
  readonly checks: readonly VerificationCheck[];
  readonly domainId: string;
  readonly domainName: string;
}

export function useVerifyDomain(clientId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (domainId: string) =>
      apiFetch<{ data: VerificationResult }>(
        `/api/v1/clients/${clientId}/domains/${domainId}/verify`,
        { method: 'POST' },
      ),
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
