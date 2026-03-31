import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

interface BulkResult {
  readonly data: {
    readonly succeeded: readonly string[];
    readonly failed: readonly { readonly id: string; readonly error: string }[];
  };
}

export function useBulkVerifyDomains() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (domainIds: readonly string[]) =>
      apiFetch<BulkResult>('/api/v1/admin/domains/bulk', {
        method: 'POST',
        body: JSON.stringify({ domain_ids: domainIds, action: 'verify' }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['domains'] });
    },
  });
}

export function useBulkDeleteDomains() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (domainIds: readonly string[]) =>
      apiFetch<BulkResult>('/api/v1/admin/domains/bulk', {
        method: 'POST',
        body: JSON.stringify({ domain_ids: domainIds, action: 'delete' }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['domains'] });
    },
  });
}
