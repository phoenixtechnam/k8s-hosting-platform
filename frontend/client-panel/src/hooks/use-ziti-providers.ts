import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  ZitiProviderInput,
  ZitiProviderResponse,
  ZitiProviderTestResponse,
} from '@k8s-hosting/api-contracts';

interface ApiEnvelope<T> {
  readonly data: T;
}

const KEY = (cid: string) => ['ziti-providers', cid] as const;

export function useZitiProviders(clientId: string | undefined) {
  return useQuery({
    queryKey: KEY(clientId ?? ''),
    queryFn: async () => {
      const res = await apiFetch<ApiEnvelope<ZitiProviderResponse[]>>(
        `/api/v1/clients/${clientId}/ziti-providers`,
      );
      return res.data;
    },
    enabled: Boolean(clientId),
  });
}

export function useCreateZitiProvider(clientId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ZitiProviderInput) => {
      const res = await apiFetch<ApiEnvelope<ZitiProviderResponse>>(
        `/api/v1/clients/${clientId}/ziti-providers`,
        { method: 'POST', body: JSON.stringify(input) },
      );
      return res.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY(clientId) }),
  });
}

export function useUpdateZitiProvider(clientId: string, providerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Partial<ZitiProviderInput>) => {
      const res = await apiFetch<ApiEnvelope<ZitiProviderResponse>>(
        `/api/v1/clients/${clientId}/ziti-providers/${providerId}`,
        { method: 'PATCH', body: JSON.stringify(input) },
      );
      return res.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY(clientId) }),
  });
}

export function useDeleteZitiProvider(clientId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (providerId: string) => {
      await apiFetch<ApiEnvelope<{ deleted: boolean }>>(
        `/api/v1/clients/${clientId}/ziti-providers/${providerId}`,
        { method: 'DELETE' },
      );
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY(clientId) }),
  });
}

export function useTestZitiProvider(clientId: string, providerId: string) {
  return useMutation({
    mutationFn: async (controllerUrl: string) => {
      const res = await apiFetch<ApiEnvelope<ZitiProviderTestResponse>>(
        `/api/v1/clients/${clientId}/ziti-providers/${providerId}/test`,
        { method: 'POST', body: JSON.stringify({ controllerUrl }) },
      );
      return res.data;
    },
  });
}
