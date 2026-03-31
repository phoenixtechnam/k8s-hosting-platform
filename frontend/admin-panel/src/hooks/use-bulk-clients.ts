import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

interface BulkResult {
  readonly data: {
    readonly succeeded: readonly string[];
    readonly failed: readonly { readonly id: string; readonly error: string }[];
  };
}

export function useBulkSuspendClients() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (clientIds: readonly string[]) =>
      apiFetch<BulkResult>('/api/v1/admin/clients/bulk', {
        method: 'POST',
        body: JSON.stringify({ client_ids: clientIds, action: 'suspend' }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clients'] });
    },
  });
}

export function useBulkReactivateClients() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (clientIds: readonly string[]) =>
      apiFetch<BulkResult>('/api/v1/admin/clients/bulk', {
        method: 'POST',
        body: JSON.stringify({ client_ids: clientIds, action: 'reactivate' }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clients'] });
    },
  });
}

export function useBulkDeleteClients() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (clientIds: readonly string[]) =>
      apiFetch<BulkResult>('/api/v1/admin/clients/bulk', {
        method: 'DELETE',
        body: JSON.stringify({ client_ids: clientIds }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clients'] });
    },
  });
}
