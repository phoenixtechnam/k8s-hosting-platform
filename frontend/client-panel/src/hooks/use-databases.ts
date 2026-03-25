import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { Database, PaginatedResponse } from '@/types/api';

export function useDatabases(clientId: string | undefined) {
  return useQuery({
    queryKey: ['databases', clientId],
    queryFn: () =>
      apiFetch<PaginatedResponse<Database>>(
        `/api/v1/clients/${clientId}/databases`,
      ),
    enabled: Boolean(clientId),
  });
}

interface CreateDatabaseInput {
  readonly name: string;
  readonly db_type: string;
}

interface DatabaseWithPassword {
  readonly data: Database & { readonly password: string };
}

export function useCreateDatabase(clientId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateDatabaseInput) =>
      apiFetch<DatabaseWithPassword>(
        `/api/v1/clients/${clientId}/databases`,
        { method: 'POST', body: JSON.stringify(input) },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['databases', clientId] });
    },
  });
}

interface RotateCredentialsResponse {
  readonly data: Database & { readonly password: string };
}

export function useRotateCredentials(clientId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (databaseId: string) =>
      apiFetch<RotateCredentialsResponse>(
        `/api/v1/clients/${clientId}/databases/${databaseId}/credentials`,
        { method: 'PATCH' },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['databases', clientId] });
    },
  });
}
