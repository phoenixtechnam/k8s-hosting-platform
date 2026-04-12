import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  CreateSftpUserInput,
  UpdateSftpUserInput,
  RotateSftpPasswordInput,
  SftpUserResponse,
  SftpConnectionInfo,
  SftpAuditLogEntry,
} from '@k8s-hosting/api-contracts';

export type SftpUser = SftpUserResponse;

interface SftpUsersResponse { readonly data: readonly SftpUser[] }
interface SftpUserEnvelope { readonly data: SftpUser & { password?: string } }
interface ConnectionInfoEnvelope { readonly data: SftpConnectionInfo }
interface AuditLogResponse { readonly data: readonly SftpAuditLogEntry[] }
interface PasswordEnvelope { readonly data: { password: string } }

export function useSftpUsers(clientId: string | undefined) {
  return useQuery({
    queryKey: ['sftp-users', clientId],
    queryFn: () => apiFetch<SftpUsersResponse>(`/api/v1/clients/${clientId}/sftp-users`),
    enabled: Boolean(clientId),
  });
}

export function useCreateSftpUser(clientId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSftpUserInput) =>
      apiFetch<SftpUserEnvelope>(`/api/v1/clients/${clientId}/sftp-users`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sftp-users', clientId] }); },
  });
}

export function useUpdateSftpUser(clientId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, input }: { userId: string; input: UpdateSftpUserInput }) =>
      apiFetch<SftpUserEnvelope>(`/api/v1/clients/${clientId}/sftp-users/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sftp-users', clientId] }); },
  });
}

export function useDeleteSftpUser(clientId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      apiFetch<void>(`/api/v1/clients/${clientId}/sftp-users/${userId}`, { method: 'DELETE' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sftp-users', clientId] }); },
  });
}

export function useRotateSftpPassword(clientId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, input }: { userId: string; input?: RotateSftpPasswordInput }) =>
      apiFetch<PasswordEnvelope>(`/api/v1/clients/${clientId}/sftp-users/${userId}/rotate-password`, {
        method: 'POST',
        body: JSON.stringify(input ?? {}),
      }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sftp-users', clientId] }); },
  });
}

export function useSftpConnectionInfo(clientId: string | undefined) {
  return useQuery({
    queryKey: ['sftp-connection-info', clientId],
    queryFn: () => apiFetch<ConnectionInfoEnvelope>(`/api/v1/clients/${clientId}/sftp-users/connection-info`),
    enabled: Boolean(clientId),
  });
}

export function useSftpAuditLog(clientId: string | undefined, limit = 50, offset = 0) {
  return useQuery({
    queryKey: ['sftp-audit', clientId, limit, offset],
    queryFn: () => apiFetch<AuditLogResponse>(`/api/v1/clients/${clientId}/sftp-audit?limit=${limit}&offset=${offset}`),
    enabled: Boolean(clientId),
  });
}
