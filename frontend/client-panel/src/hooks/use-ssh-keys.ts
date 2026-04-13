/**
 * Round-4 Phase B: client-panel SSH keys management hooks.
 *
 * Backend routes live at
 *   GET    /api/v1/clients/:clientId/ssh-keys
 *   POST   /api/v1/clients/:clientId/ssh-keys
 *   DELETE /api/v1/clients/:clientId/ssh-keys/:keyId
 * and are accessible to client_admin + client_user roles.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { CreateSshKeyInput, UpdateSshKeyInput, SshKeyResponse } from '@k8s-hosting/api-contracts';

export type SshKey = SshKeyResponse;

interface SshKeysResponse {
  readonly data: readonly SshKey[];
}

interface SshKeyResponseEnvelope {
  readonly data: SshKey;
}

export function useSshKeys(clientId: string | undefined) {
  return useQuery({
    queryKey: ['ssh-keys', clientId],
    queryFn: () => apiFetch<SshKeysResponse>(`/api/v1/clients/${clientId}/ssh-keys`),
    enabled: Boolean(clientId),
  });
}

export function useCreateSshKey(clientId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSshKeyInput) =>
      apiFetch<SshKeyResponseEnvelope>(
        `/api/v1/clients/${clientId}/ssh-keys`,
        { method: 'POST', body: JSON.stringify(input) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ssh-keys', clientId] });
    },
  });
}

export function useUpdateSshKey(clientId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ keyId, input }: { keyId: string; input: UpdateSshKeyInput }) =>
      apiFetch<SshKeyResponseEnvelope>(
        `/api/v1/clients/${clientId}/ssh-keys/${keyId}`,
        { method: 'PATCH', body: JSON.stringify(input) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ssh-keys', clientId] });
    },
  });
}

export function useDeleteSshKey(clientId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (keyId: string) =>
      apiFetch<void>(
        `/api/v1/clients/${clientId}/ssh-keys/${keyId}`,
        { method: 'DELETE' },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ssh-keys', clientId] });
    },
  });
}
