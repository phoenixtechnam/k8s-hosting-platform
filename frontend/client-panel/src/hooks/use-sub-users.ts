import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  CreateSubUserInput,
  SubUser,
  SubUserRole,
  UpdateSubUserInput,
} from '@k8s-hosting/api-contracts';
import { apiFetch } from '@/lib/api-client';

export type {
  SubUser,
  CreateSubUserInput,
  SubUserRole,
  UpdateSubUserInput,
} from '@k8s-hosting/api-contracts';

export function useSubUsers(clientId: string | null) {
  return useQuery({
    queryKey: ['sub-users', clientId],
    queryFn: () => apiFetch<{ data: readonly SubUser[] }>(`/api/v1/clients/${clientId}/users`),
    enabled: Boolean(clientId),
  });
}

export function useCreateSubUser(clientId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSubUserInput) =>
      apiFetch<{ data: SubUser }>(`/api/v1/clients/${clientId}/users`, {
        method: 'POST', body: JSON.stringify(input),
      }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sub-users', clientId] }); },
  });
}

/**
 * Phase 3: edit a sub-user's name, role, or status. Password
 * changes go through a separate `useResetSubUserPassword` hook
 * added in Phase 4.
 */
export function useUpdateSubUser(clientId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, patch }: { userId: string; patch: UpdateSubUserInput }) =>
      apiFetch<{ data: SubUser }>(`/api/v1/clients/${clientId}/users/${userId}`, {
        method: 'PATCH', body: JSON.stringify(patch),
      }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sub-users', clientId] }); },
  });
}

export function useDeleteSubUser(clientId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      apiFetch<void>(`/api/v1/clients/${clientId}/users/${userId}`, { method: 'DELETE' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sub-users', clientId] }); },
  });
}
