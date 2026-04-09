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
 * changes go through `useResetSubUserPassword` in Phase 4.
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

/**
 * Phase 4: admin-assisted password reset. The calling client_admin
 * sets a new password for a teammate and is responsible for
 * communicating it out-of-band. No email is sent.
 */
export function useResetSubUserPassword(clientId: string | null) {
  return useMutation({
    mutationFn: ({ userId, newPassword }: { userId: string; newPassword: string }) =>
      apiFetch<void>(`/api/v1/clients/${clientId}/users/${userId}/reset-password`, {
        method: 'POST',
        body: JSON.stringify({ new_password: newPassword }),
      }),
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
