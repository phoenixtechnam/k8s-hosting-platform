import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { Domain, PaginatedResponse } from '@/types/api';

export function useDomains(clientId: string | undefined) {
  return useQuery({
    queryKey: ['domains', clientId],
    queryFn: () =>
      apiFetch<PaginatedResponse<Domain>>(
        `/api/v1/clients/${clientId}/domains`,
      ),
    enabled: Boolean(clientId),
  });
}

interface CreateDomainInput {
  readonly domain_name: string;
  readonly dns_mode: 'cname' | 'primary' | 'secondary';
  readonly workload_id?: string;
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
