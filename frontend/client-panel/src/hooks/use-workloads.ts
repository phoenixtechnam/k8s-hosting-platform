import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { Workload, PaginatedResponse, ContainerImageResponse } from '@/types/api';

export function useWorkloads(clientId: string | undefined) {
  return useQuery({
    queryKey: ['workloads', clientId],
    queryFn: () => apiFetch<PaginatedResponse<Workload>>(`/api/v1/clients/${clientId}/workloads`),
    enabled: Boolean(clientId),
  });
}

export function useContainerImages() {
  return useQuery({
    queryKey: ['container-images'],
    queryFn: () => apiFetch<{ data: readonly ContainerImageResponse[] }>('/api/v1/container-images'),
    staleTime: 300_000,
  });
}

interface CreateWorkloadInput {
  readonly name: string;
  readonly image_id: string;
  readonly replica_count?: number;
  readonly cpu_request?: string;
  readonly memory_request?: string;
}

export function useCreateWorkload(clientId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateWorkloadInput) =>
      apiFetch<{ data: Workload }>(`/api/v1/clients/${clientId}/workloads`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workloads', clientId] });
    },
  });
}

interface UpdateWorkloadInput {
  readonly status?: 'running' | 'stopped';
}

export function useUpdateWorkload(clientId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ workloadId, ...input }: UpdateWorkloadInput & { readonly workloadId: string }) =>
      apiFetch<{ data: Workload }>(`/api/v1/clients/${clientId}/workloads/${workloadId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workloads', clientId] });
    },
  });
}

export function useDeleteWorkload(clientId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (workloadId: string) =>
      apiFetch<void>(`/api/v1/clients/${clientId}/workloads/${workloadId}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workloads', clientId] });
    },
  });
}
