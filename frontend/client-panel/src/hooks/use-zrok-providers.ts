import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  ZrokProviderInput,
  ZrokProviderResponse,
  ZrokProviderTestResponse,
} from '@k8s-hosting/api-contracts';

interface ApiEnvelope<T> {
  readonly data: T;
}

const KEY = (cid: string) => ['zrok-providers', cid] as const;

export function useZrokProviders(clientId: string | undefined) {
  return useQuery({
    queryKey: KEY(clientId ?? ''),
    queryFn: async () => {
      const res = await apiFetch<ApiEnvelope<ZrokProviderResponse[]>>(
        `/api/v1/clients/${clientId}/zrok-providers`,
      );
      return res.data;
    },
    enabled: Boolean(clientId),
  });
}

export function useCreateZrokProvider(clientId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ZrokProviderInput) => {
      const res = await apiFetch<ApiEnvelope<ZrokProviderResponse>>(
        `/api/v1/clients/${clientId}/zrok-providers`,
        { method: 'POST', body: JSON.stringify(input) },
      );
      return res.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY(clientId) }),
  });
}

export function useUpdateZrokProvider(clientId: string, providerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Partial<ZrokProviderInput>) => {
      const res = await apiFetch<ApiEnvelope<ZrokProviderResponse>>(
        `/api/v1/clients/${clientId}/zrok-providers/${providerId}`,
        { method: 'PATCH', body: JSON.stringify(input) },
      );
      return res.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY(clientId) }),
  });
}

export function useDeleteZrokProvider(clientId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (providerId: string) => {
      await apiFetch<ApiEnvelope<{ deleted: boolean }>>(
        `/api/v1/clients/${clientId}/zrok-providers/${providerId}`,
        { method: 'DELETE' },
      );
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY(clientId) }),
  });
}

export function useTestZrokProvider(clientId: string, providerId: string) {
  return useMutation({
    mutationFn: async (controllerUrl: string) => {
      const res = await apiFetch<ApiEnvelope<ZrokProviderTestResponse>>(
        `/api/v1/clients/${clientId}/zrok-providers/${providerId}/test`,
        { method: 'POST', body: JSON.stringify({ controllerUrl }) },
      );
      return res.data;
    },
  });
}
