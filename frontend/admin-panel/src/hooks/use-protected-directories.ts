import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { ProtectedDirectoryResponse, ProtectedDirectoryUserResponse } from '@/types/api';

function basePath(clientId: string, domainId: string) {
  return `/api/v1/clients/${clientId}/domains/${domainId}/protected-directories`;
}

// ─── Directory CRUD ──────────────────────────────────────────────────────────

export function useProtectedDirectories(clientId: string | undefined, domainId: string | undefined) {
  return useQuery({
    queryKey: ['protected-directories', clientId, domainId],
    queryFn: () =>
      apiFetch<{ data: readonly ProtectedDirectoryResponse[] }>(basePath(clientId!, domainId!)),
    enabled: Boolean(clientId && domainId),
  });
}

interface CreateDirectoryInput {
  readonly path: string;
  readonly realm?: string;
}

export function useCreateProtectedDirectory(clientId: string | undefined, domainId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateDirectoryInput) =>
      apiFetch<{ data: ProtectedDirectoryResponse }>(basePath(clientId!, domainId!), {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['protected-directories', clientId, domainId] });
    },
  });
}

export function useDeleteProtectedDirectory(clientId: string | undefined, domainId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (dirId: string) =>
      apiFetch<void>(`${basePath(clientId!, domainId!)}/${dirId}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['protected-directories', clientId, domainId] });
    },
  });
}

// ─── Directory Users ─────────────────────────────────────────────────────────

export function useDirectoryUsers(
  clientId: string | undefined,
  domainId: string | undefined,
  dirId: string | undefined,
) {
  return useQuery({
    queryKey: ['directory-users', clientId, domainId, dirId],
    queryFn: () =>
      apiFetch<{ data: readonly ProtectedDirectoryUserResponse[] }>(
        `${basePath(clientId!, domainId!)}/${dirId}/users`,
      ),
    enabled: Boolean(clientId && domainId && dirId),
  });
}

interface CreateDirectoryUserInput {
  readonly username: string;
  readonly password: string;
}

export function useCreateDirectoryUser(
  clientId: string | undefined,
  domainId: string | undefined,
  dirId: string | undefined,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateDirectoryUserInput) =>
      apiFetch<{ data: ProtectedDirectoryUserResponse }>(
        `${basePath(clientId!, domainId!)}/${dirId}/users`,
        { method: 'POST', body: JSON.stringify(input) },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['directory-users', clientId, domainId, dirId] });
    },
  });
}

export function useDisableDirectoryUser(
  clientId: string | undefined,
  domainId: string | undefined,
  dirId: string | undefined,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (userId: string) =>
      apiFetch<{ data: { message: string } }>(
        `${basePath(clientId!, domainId!)}/${dirId}/users/${userId}/disable`,
        { method: 'POST' },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['directory-users', clientId, domainId, dirId] });
    },
  });
}

export function useDeleteDirectoryUser(
  clientId: string | undefined,
  domainId: string | undefined,
  dirId: string | undefined,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (userId: string) =>
      apiFetch<void>(`${basePath(clientId!, domainId!)}/${dirId}/users/${userId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['directory-users', clientId, domainId, dirId] });
    },
  });
}
