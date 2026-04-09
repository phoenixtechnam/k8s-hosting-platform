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

/**
 * Phase 5: admin panel hooks for managing a specific client's
 * sub-users. The backend routes are the same as the client panel
 * (`/api/v1/clients/:clientId/users*`) — the admin panel just
 * supplies its own JWT (super_admin / admin) which has staff role
 * requirements.
 */

/**
 * Only the read query accepts `string | null` — it translates
 * cleanly to a disabled TanStack Query. The mutation hooks demand
 * a non-null `string` because mutations have no disabled-state
 * equivalent: a null clientId would produce a request to
 * `/api/v1/clients/null/users` which the route matcher would
 * happily accept before failing downstream with a misleading
 * error.
 */
export function useAdminSubUsers(clientId: string | null) {
  return useQuery({
    queryKey: ['admin', 'sub-users', clientId],
    queryFn: () =>
      apiFetch<{ data: readonly SubUser[] }>(`/api/v1/clients/${clientId}/users`),
    enabled: Boolean(clientId),
  });
}

export function useAdminCreateSubUser(clientId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSubUserInput) =>
      apiFetch<{ data: SubUser }>(`/api/v1/clients/${clientId}/users`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'sub-users', clientId] });
    },
  });
}

export function useAdminUpdateSubUser(clientId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, patch }: { userId: string; patch: UpdateSubUserInput }) =>
      apiFetch<{ data: SubUser }>(`/api/v1/clients/${clientId}/users/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'sub-users', clientId] });
    },
  });
}

export function useAdminResetSubUserPassword(clientId: string) {
  return useMutation({
    mutationFn: ({ userId, newPassword }: { userId: string; newPassword: string }) =>
      apiFetch<void>(`/api/v1/clients/${clientId}/users/${userId}/reset-password`, {
        method: 'POST',
        body: JSON.stringify({ new_password: newPassword }),
      }),
  });
}

export function useAdminDeleteSubUser(clientId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      apiFetch<void>(`/api/v1/clients/${clientId}/users/${userId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'sub-users', clientId] });
    },
  });
}
