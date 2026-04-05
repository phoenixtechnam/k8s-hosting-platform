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

export function useDeployments(clientId: string | undefined, options?: { refetchInterval?: number | false }) {
  return useQuery({
    queryKey: ['deployments', clientId],
    queryFn: () => apiFetch<PaginatedResponse<Deployment>>(`/api/v1/clients/${clientId}/deployments?include_deleted=true`),
    enabled: Boolean(clientId),
    refetchInterval: options?.refetchInterval,
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

export interface DeploymentLiveMetrics {
  readonly cpuUsed: number;
  readonly cpuRequest: string;
  readonly memoryUsedMi: number;
  readonly memoryRequest: string;
  readonly storageUsedBytes?: number;
  readonly storageUsedFormatted?: string;
}

export function useDeploymentLiveMetrics(clientId: string | undefined, deploymentId: string | undefined) {
  return useQuery({
    queryKey: ['deployment-live-metrics', clientId, deploymentId],
    queryFn: () => apiFetch<{ data: DeploymentLiveMetrics }>(`/api/v1/clients/${clientId}/deployments/${deploymentId}/live-metrics`),
    enabled: Boolean(clientId && deploymentId),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export interface LogLine {
  readonly source: 'K8S' | 'APP';
  readonly text: string;
  readonly timestamp?: string;
  readonly level: 'info' | 'warning' | 'error';
}

export interface DeploymentLogs {
  readonly podName: string;
  readonly lines: readonly LogLine[];
  readonly terminationReason: string | null;
  readonly tailLines: number;
}

export function useDeploymentLogs(clientId: string | undefined, deploymentId: string | undefined, enabled = false) {
  return useQuery({
    queryKey: ['deployment-logs', clientId, deploymentId],
    queryFn: () => apiFetch<{ data: DeploymentLogs }>(`/api/v1/clients/${clientId}/deployments/${deploymentId}/logs?lines=200`),
    enabled: Boolean(clientId && deploymentId) && enabled,
    staleTime: 10_000,
  });
}

export interface ResourceAvailability {
  readonly cpu: { readonly min: string; readonly max: string; readonly current: string; readonly planLimit: string };
  readonly memory: { readonly min: string; readonly max: string; readonly current: string; readonly planLimit: string };
}

export function useResourceAvailability(clientId: string | undefined, deploymentId: string | undefined) {
  return useQuery({
    queryKey: ['resource-availability', clientId, deploymentId],
    queryFn: () => apiFetch<{ data: ResourceAvailability }>(`/api/v1/clients/${clientId}/deployments/${deploymentId}/resource-availability`),
    enabled: Boolean(clientId && deploymentId),
    staleTime: 30_000,
  });
}

export function useUpdateDeploymentResources(clientId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ deploymentId, cpu_request, memory_request }: { readonly deploymentId: string; readonly cpu_request?: string; readonly memory_request?: string }) =>
      apiFetch<{ data: Deployment }>(`/api/v1/clients/${clientId}/deployments/${deploymentId}/resources`, {
        method: 'PATCH',
        body: JSON.stringify({ cpu_request, memory_request }),
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

interface DeploymentCredentials {
  readonly credentials: Record<string, string>;
  readonly connectionInfo: {
    readonly host?: string;
    readonly port?: number;
    readonly database?: string;
    readonly username?: string;
    readonly connectionUrl?: string;
  } | null;
  readonly generatedKeys: readonly string[];
}

export function useDeploymentCredentials(clientId: string | undefined, deploymentId: string | undefined) {
  return useQuery({
    queryKey: ['deployment-credentials', clientId, deploymentId],
    queryFn: () => apiFetch<{ data: DeploymentCredentials }>(
      `/api/v1/clients/${clientId}/deployments/${deploymentId}/credentials`
    ),
    enabled: Boolean(clientId) && Boolean(deploymentId),
  });
}

export function useRestartDeployment(clientId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (deploymentId: string) =>
      apiFetch<{ data: { message: string } }>(
        `/api/v1/clients/${clientId}/deployments/${deploymentId}/restart`,
        { method: 'POST' },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deployments', clientId] });
    },
  });
}

export function useRegenerateCredentials(clientId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ deploymentId, keys }: { deploymentId: string; keys?: string[] }) =>
      apiFetch<{ data: DeploymentCredentials }>(
        `/api/v1/clients/${clientId}/deployments/${deploymentId}/regenerate-credentials`,
        { method: 'POST', body: JSON.stringify({ keys }) }
      ),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['deployment-credentials', clientId, variables.deploymentId] });
      queryClient.invalidateQueries({ queryKey: ['deployments', clientId] });
    },
  });
}

export function useRestoreDeployment(clientId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (deploymentId: string) =>
      apiFetch<{ data: Deployment }>(`/api/v1/clients/${clientId}/deployments/${deploymentId}/restore`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deployments', clientId] });
    },
  });
}

export function usePermanentDeleteDeployment(clientId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ deploymentId, deleteData }: { deploymentId: string; deleteData?: boolean }) => {
      const params = new URLSearchParams({ force: 'true' });
      if (deleteData) params.set('deleteData', 'true');
      return apiFetch<void>(`/api/v1/clients/${clientId}/deployments/${deploymentId}?${params.toString()}`, { method: 'DELETE' });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deployments', clientId] });
    },
  });
}

// ─── Database Management Hooks ──────────────────────────────────────────────

export interface DbDatabase {
  readonly name: string;
}

export interface DbUser {
  readonly username: string;
  readonly host: string;
  readonly databases?: readonly string[];
}

export function useDbDatabases(clientId: string | undefined, deploymentId: string | undefined) {
  return useQuery({
    queryKey: ['db-databases', clientId, deploymentId],
    queryFn: () =>
      apiFetch<{ data: readonly DbDatabase[] }>(
        `/api/v1/clients/${clientId}/deployments/${deploymentId}/databases`,
      ),
    enabled: Boolean(clientId) && Boolean(deploymentId),
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
  });
}

export function useCreateDbDatabase(clientId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ deploymentId, name }: { deploymentId: string; name: string }) =>
      apiFetch<{ data: { name: string } }>(
        `/api/v1/clients/${clientId}/deployments/${deploymentId}/databases`,
        { method: 'POST', body: JSON.stringify({ name }) },
      ),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['db-databases', clientId, variables.deploymentId] });
    },
  });
}

export function useDropDbDatabase(clientId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ deploymentId, name }: { deploymentId: string; name: string }) =>
      apiFetch<void>(
        `/api/v1/clients/${clientId}/deployments/${deploymentId}/databases/${encodeURIComponent(name)}`,
        { method: 'DELETE' },
      ),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['db-databases', clientId, variables.deploymentId] });
    },
  });
}

export function useDbUsers(clientId: string | undefined, deploymentId: string | undefined) {
  return useQuery({
    queryKey: ['db-users', clientId, deploymentId],
    queryFn: () =>
      apiFetch<{ data: readonly DbUser[] }>(
        `/api/v1/clients/${clientId}/deployments/${deploymentId}/db-users`,
      ),
    enabled: Boolean(clientId) && Boolean(deploymentId),
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
  });
}

export function useCreateDbUser(clientId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      deploymentId,
      username,
      password,
      database,
    }: {
      deploymentId: string;
      username: string;
      password: string;
      database?: string;
    }) =>
      apiFetch<{ data: { username: string } }>(
        `/api/v1/clients/${clientId}/deployments/${deploymentId}/db-users`,
        { method: 'POST', body: JSON.stringify({ username, password, database }) },
      ),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['db-users', clientId, variables.deploymentId] });
    },
  });
}

export function useDropDbUser(clientId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ deploymentId, username }: { deploymentId: string; username: string }) =>
      apiFetch<void>(
        `/api/v1/clients/${clientId}/deployments/${deploymentId}/db-users/${encodeURIComponent(username)}`,
        { method: 'DELETE' },
      ),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['db-users', clientId, variables.deploymentId] });
    },
  });
}

// ─── Resource Usage ─────────────────────────────────────────────────────────

export interface ResourceUsage {
  readonly cpu: { readonly used: string; readonly limit: string };
  readonly memory: { readonly used: string; readonly limit: string };
  readonly storage: { readonly used: string; readonly limit: string };
}

export function useResourceUsage(clientId: string | null | undefined) {
  return useQuery({
    queryKey: ['resource-usage', clientId],
    queryFn: () =>
      apiFetch<{ data: ResourceUsage }>(
        `/api/v1/clients/${clientId}/resource-usage`,
      ),
    enabled: Boolean(clientId),
    refetchInterval: 15_000,
  });
}

export function useSetDbUserPassword(clientId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      deploymentId,
      username,
      password,
    }: {
      deploymentId: string;
      username: string;
      password: string;
    }) =>
      apiFetch<{ data: { message: string } }>(
        `/api/v1/clients/${clientId}/deployments/${deploymentId}/db-users/${encodeURIComponent(username)}/password`,
        { method: 'POST', body: JSON.stringify({ password }) },
      ),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['db-users', clientId, variables.deploymentId] });
    },
  });
}
