import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { Deployment, PaginatedResponse } from '@/types/api';

interface CreateDeploymentInput {
  readonly name: string;
  readonly catalog_entry_id: string;
  readonly replica_count?: number;
  readonly cpu_request?: string;
  readonly memory_request?: string;
  readonly configuration?: Record<string, unknown>;
  readonly version?: string;
}

interface UpdateDeploymentInput {
  readonly status?: 'running' | 'stopped';
}

export function useDeployments(clientId: string | undefined) {
  return useQuery({
    queryKey: ['deployments', clientId],
    queryFn: () => apiFetch<PaginatedResponse<Deployment>>(`/api/v1/clients/${clientId}/deployments`),
    enabled: Boolean(clientId),
  });
}

export function useCreateDeployment(clientId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateDeploymentInput) => {
      if (!clientId) throw new Error('No client selected');
      return apiFetch<{ data: Deployment }>(`/api/v1/clients/${clientId}/deployments`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deployments', clientId] });
    },
  });
}

export function useUpdateDeployment(clientId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ deploymentId, ...input }: UpdateDeploymentInput & { readonly deploymentId: string }) =>
      apiFetch<{ data: Deployment }>(`/api/v1/clients/${clientId}/deployments/${deploymentId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deployments', clientId] });
    },
  });
}

export function useDeleteDeployment(clientId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (deploymentId: string) =>
      apiFetch<void>(`/api/v1/clients/${clientId}/deployments/${deploymentId}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deployments', clientId] });
    },
  });
}
