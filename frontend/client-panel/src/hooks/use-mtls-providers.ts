import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  MtlsProviderInput,
  MtlsProviderUpdate,
  MtlsProviderResponse,
  MtlsIssueCertInput,
  MtlsIssueCertResponse,
} from '@k8s-hosting/api-contracts';

interface ApiEnvelope<T> {
  readonly data: T;
}

const KEY = (cid: string) => ['mtls-providers', cid] as const;

export function useMtlsProviders(clientId: string | undefined) {
  return useQuery({
    queryKey: KEY(clientId ?? ''),
    queryFn: async () => {
      const res = await apiFetch<ApiEnvelope<MtlsProviderResponse[]>>(
        `/api/v1/clients/${clientId}/mtls-providers`,
      );
      return res.data;
    },
    enabled: Boolean(clientId),
  });
}

export function useCreateMtlsProvider(clientId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: MtlsProviderInput) => {
      const res = await apiFetch<ApiEnvelope<MtlsProviderResponse>>(
        `/api/v1/clients/${clientId}/mtls-providers`,
        { method: 'POST', body: JSON.stringify(input) },
      );
      return res.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY(clientId) }),
  });
}

export function useUpdateMtlsProvider(clientId: string, providerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: MtlsProviderUpdate) => {
      const res = await apiFetch<ApiEnvelope<MtlsProviderResponse>>(
        `/api/v1/clients/${clientId}/mtls-providers/${providerId}`,
        { method: 'PATCH', body: JSON.stringify(input) },
      );
      return res.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY(clientId) }),
  });
}

export function useDeleteMtlsProvider(clientId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (providerId: string) => {
      await apiFetch<ApiEnvelope<{ deleted: boolean }>>(
        `/api/v1/clients/${clientId}/mtls-providers/${providerId}`,
        { method: 'DELETE' },
      );
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY(clientId) }),
  });
}

export function useIssueMtlsCert(clientId: string, providerId: string) {
  return useMutation({
    mutationFn: async (input: MtlsIssueCertInput) => {
      const res = await apiFetch<ApiEnvelope<MtlsIssueCertResponse>>(
        `/api/v1/clients/${clientId}/mtls-providers/${providerId}/issue-cert`,
        { method: 'POST', body: JSON.stringify(input) },
      );
      return res.data;
    },
  });
}
