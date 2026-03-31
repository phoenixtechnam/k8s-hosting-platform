import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

interface BulkResult {
  readonly data: {
    readonly succeeded: readonly string[];
    readonly failed: readonly { readonly id: string; readonly error: string }[];
  };
}

export function useBulkDeleteAdminUsers() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (userIds: readonly string[]) =>
      apiFetch<BulkResult>('/api/v1/admin/users/bulk', {
        method: 'DELETE',
        body: JSON.stringify({ user_ids: userIds }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
    },
  });
}
