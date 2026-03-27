import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface SubUser {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly roleName: string;
  readonly status: string;
  readonly createdAt: string;
  readonly lastLoginAt: string | null;
}

export function useSubUsers(clientId: string | null) {
  return useQuery({
    queryKey: ['sub-users', clientId],
    queryFn: () => apiFetch<{ data: readonly SubUser[] }>(`/api/v1/clients/${clientId}/users`),
    enabled: Boolean(clientId),
  });
}

interface CreateSubUserInput {
  readonly email: string;
  readonly full_name: string;
  readonly password: string;
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

export function useDeleteSubUser(clientId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      apiFetch<void>(`/api/v1/clients/${clientId}/users/${userId}`, { method: 'DELETE' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sub-users', clientId] }); },
  });
}
