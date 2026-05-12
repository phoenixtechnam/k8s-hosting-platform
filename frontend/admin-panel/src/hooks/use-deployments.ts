import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { PaginatedResponse } from '@/types/api';

export interface Deployment {
  readonly id: string;
  readonly clientId: string;
  readonly name: string;
  // Nullable: custom deployments (ADR-036, source='custom') carry no
  // catalog entry. The XOR constraint at the DB layer keeps `source`
  // and this field consistent.
  readonly catalogEntryId: string | null;
  /** ADR-036 source discriminator. Defaults to 'catalog' on older
   *  rows that pre-date PR-1's migration. */
  readonly source?: 'catalog' | 'custom';
  readonly type: 'application' | 'runtime' | 'database' | 'service' | 'static';
  readonly status: string;
  /** Persistent error message when status='failed' (e.g. volume faulted, image pull error). */
  readonly lastError: string | null;
  /** Transient progress message while status='pending' (e.g. "1/3 replicas ready"). */
  readonly statusMessage: string | null;
  /** Cluster node currently hosting the first scheduled pod. */
  readonly currentNodeName: string | null;
  readonly replicaCount: number;
  readonly cpuRequest: string;
  readonly memoryRequest: string;
  readonly installedVersion: string | null;
  readonly targetVersion: string | null;
  readonly domainName: string | null;
  readonly storagePath: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function useDeployments(clientId: string | undefined, type?: string) {
  const params = new URLSearchParams();
  if (type) params.set('type', type);
  const qs = params.toString();
  const path = `/api/v1/clients/${clientId}/deployments${qs ? `?${qs}` : ''}`;

  return useQuery({
    queryKey: ['deployments', clientId, type],
    queryFn: () => apiFetch<PaginatedResponse<Deployment>>(path),
    enabled: !!clientId,
  });
}

export function useDeployment(clientId: string | undefined, deploymentId: string | undefined) {
  return useQuery({
    queryKey: ['deployments', clientId, deploymentId],
    queryFn: () =>
      apiFetch<{ data: Deployment }>(`/api/v1/clients/${clientId}/deployments/${deploymentId}`),
    enabled: !!clientId && !!deploymentId,
  });
}

interface CreateDeploymentInput {
  readonly name: string;
  readonly catalog_entry_id: string;
  readonly replica_count?: number;
  readonly cpu_request?: string;
  readonly memory_request?: string;
}

export function useCreateDeployment(clientId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateDeploymentInput) =>
      apiFetch<{ data: Deployment }>(`/api/v1/clients/${clientId}/deployments`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deployments', clientId] });
    },
  });
}

interface UpdateDeploymentInput {
  readonly name?: string;
  readonly replica_count?: number;
  readonly cpu_request?: string;
  readonly memory_request?: string;
  readonly status?: 'running' | 'stopped';
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

export function useRestartDeployment(clientId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (deploymentId: string) =>
      apiFetch(`/api/v1/clients/${clientId}/deployments/${deploymentId}/restart`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deployments'] });
    },
  });
}

// Two modes:
//   string                 — fleet-wide filter by catalog_entry_id (running only)
//   readonly string[]      — explicit deployment_ids, force-restart any state
//   undefined              — fleet-wide all running deployments
export function useBulkRestartDeployments() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input?: string | readonly string[]) => {
      let body: Record<string, unknown> = {};
      if (Array.isArray(input)) {
        body = { deployment_ids: input };
      } else if (typeof input === 'string') {
        body = { catalog_entry_id: input };
      }
      return apiFetch('/api/v1/admin/deployments/bulk-restart', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deployments'] });
    },
  });
}
