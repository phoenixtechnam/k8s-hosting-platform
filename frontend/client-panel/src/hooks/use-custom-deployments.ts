import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  CreateCustomDeploymentInput,
  CreateCustomDeploymentSimpleInput,
  CreateCustomDeploymentComposeInput,
  UpdateCustomDeploymentInput,
  ValidateCustomDeploymentResult,
  CheckUpdatesBatchResult,
  PullCredentialResponse,
  SubmitPullCredentialInput,
  CustomDeploymentSpec,
} from '@k8s-hosting/api-contracts';

/**
 * Server response row for a custom deployment. The backend's
 * `CustomDeploymentRow` is not exposed in api-contracts (it's a
 * service-internal type), so we mirror its shape here for the
 * client. Keep in sync with `backend/src/modules/custom-deployments/service.ts:CustomDeploymentRow`.
 */
export interface CustomDeploymentRow {
  readonly id: string;
  readonly clientId: string;
  readonly name: string;
  readonly status: string;
  readonly customSpec: CustomDeploymentSpec;
  readonly storagePath: string | null;
  readonly currentNodeName: string | null;
  readonly statusMessage: string | null;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const BASE = (clientId: string) => `/api/v1/clients/${clientId}/custom-deployments`;

// ─── List / Get ─────────────────────────────────────────────────────────────

export function useCustomDeployments(clientId: string | undefined, options?: { refetchInterval?: number | false }) {
  return useQuery({
    queryKey: ['custom-deployments', clientId],
    queryFn: () => apiFetch<{ data: readonly CustomDeploymentRow[] }>(BASE(clientId!)),
    enabled: Boolean(clientId),
    refetchInterval: options?.refetchInterval,
  });
}

export function useCustomDeployment(clientId: string | undefined, id: string | undefined) {
  return useQuery({
    queryKey: ['custom-deployment', clientId, id],
    queryFn: () => apiFetch<{ data: CustomDeploymentRow }>(`${BASE(clientId!)}/${id}`),
    enabled: Boolean(clientId && id),
  });
}

// ─── Create / Validate ──────────────────────────────────────────────────────

export function useValidateCustomDeployment(clientId: string | undefined) {
  return useMutation({
    mutationFn: (input: CreateCustomDeploymentInput) =>
      apiFetch<{ data: ValidateCustomDeploymentResult }>(`${BASE(clientId!)}/validate`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
  });
}

export function useCreateCustomDeployment(clientId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCustomDeploymentSimpleInput | CreateCustomDeploymentComposeInput) =>
      apiFetch<{ data: CustomDeploymentRow }>(BASE(clientId!), {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['custom-deployments', clientId] });
    },
  });
}

// ─── Update / Delete / Upgrade ──────────────────────────────────────────────

export function useUpdateCustomDeployment(clientId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: UpdateCustomDeploymentInput & { id: string }) =>
      apiFetch<{ data: CustomDeploymentRow }>(`${BASE(clientId!)}/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['custom-deployments', clientId] });
      queryClient.invalidateQueries({ queryKey: ['custom-deployment', clientId, vars.id] });
    },
  });
}

export function useDeleteCustomDeployment(clientId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<unknown>(`${BASE(clientId!)}/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['custom-deployments', clientId] });
    },
  });
}

export function useUpgradeTag(clientId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, image }: { id: string; image: string }) =>
      apiFetch<{ data: CustomDeploymentRow }>(`${BASE(clientId!)}/${id}/upgrade-tag`, {
        method: 'PUT',
        body: JSON.stringify({ image }),
      }),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['custom-deployments', clientId] });
      queryClient.invalidateQueries({ queryKey: ['custom-deployment', clientId, vars.id] });
    },
  });
}

// ─── Check updates batch (lazy on tab open) ─────────────────────────────────

export function useCheckUpdatesBatch(clientId: string | undefined, deploymentIds: readonly string[]) {
  return useQuery({
    queryKey: ['custom-deployments-updates', clientId, [...deploymentIds].sort().join(',')],
    queryFn: () =>
      apiFetch<{ data: CheckUpdatesBatchResult }>(`${BASE(clientId!)}/check-updates-batch`, {
        method: 'POST',
        body: JSON.stringify({ deployment_ids: [...deploymentIds] }),
      }),
    enabled: Boolean(clientId && deploymentIds.length > 0),
    // The backend caches for 60min; refetching on focus would burn
    // a registry probe per pane open. Once-per-mount is enough.
    refetchOnWindowFocus: false,
    staleTime: 30 * 60 * 1000,
  });
}

// ─── Pull credentials (PAT) ─────────────────────────────────────────────────

export function usePullCredential(clientId: string | undefined, id: string | undefined) {
  return useQuery({
    queryKey: ['custom-deployments-pull-credential', clientId, id],
    queryFn: () =>
      apiFetch<{ data: PullCredentialResponse | null }>(`${BASE(clientId!)}/${id}/pull-credentials`),
    enabled: Boolean(clientId && id),
  });
}

export function useAttachPullCredential(clientId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: SubmitPullCredentialInput }) =>
      apiFetch<{ data: PullCredentialResponse }>(`${BASE(clientId!)}/${id}/pull-credentials`, {
        method: 'PUT',
        body: JSON.stringify(input),
      }),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['custom-deployments-pull-credential', clientId, vars.id] });
    },
  });
}

export function useRevokePullCredential(clientId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<unknown>(`${BASE(clientId!)}/${id}/pull-credentials`, { method: 'DELETE' }),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: ['custom-deployments-pull-credential', clientId, id] });
    },
  });
}

// ─── Compose JSON Schema (one-shot, for monaco-yaml integration later) ──────

export function useComposeSchema() {
  return useQuery({
    queryKey: ['custom-deployments-compose-schema'],
    queryFn: () =>
      apiFetch<{ data: { $schema: string; title: string; schema: Record<string, unknown>; version: string } }>(
        '/api/v1/custom-deployments/compose-schema',
      ),
    staleTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}
