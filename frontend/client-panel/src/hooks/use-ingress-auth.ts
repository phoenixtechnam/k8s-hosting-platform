import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  IngressAuthConfigInput,
  IngressAuthConfigResponse,
  IngressAuthTestResponse,
} from '@k8s-hosting/api-contracts';

interface ApiEnvelope<T> {
  readonly data: T;
}

const KEY = (cid: string, rid: string) => ['ingress-auth', cid, rid] as const;

export function useIngressAuth(clientId: string | undefined, routeId: string | undefined) {
  return useQuery({
    queryKey: KEY(clientId ?? '', routeId ?? ''),
    queryFn: async () => {
      const res = await apiFetch<ApiEnvelope<IngressAuthConfigResponse | null>>(
        `/api/v1/clients/${clientId}/ingress-routes/${routeId}/auth`,
      );
      return res.data;
    },
    enabled: Boolean(clientId && routeId),
  });
}

export function useUpsertIngressAuth(clientId: string, routeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: IngressAuthConfigInput) => {
      const res = await apiFetch<ApiEnvelope<IngressAuthConfigResponse>>(
        `/api/v1/clients/${clientId}/ingress-routes/${routeId}/auth`,
        { method: 'PATCH', body: JSON.stringify(input) },
      );
      return res.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY(clientId, routeId) }),
  });
}

export function useDeleteIngressAuth(clientId: string, routeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await apiFetch<ApiEnvelope<{ deleted: boolean }>>(
        `/api/v1/clients/${clientId}/ingress-routes/${routeId}/auth`,
        { method: 'DELETE' },
      );
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY(clientId, routeId) }),
  });
}

export function useTestIngressAuth(clientId: string, routeId: string) {
  return useMutation({
    mutationFn: async (issuerUrl: string) => {
      const res = await apiFetch<ApiEnvelope<IngressAuthTestResponse>>(
        `/api/v1/clients/${clientId}/ingress-routes/${routeId}/auth/test`,
        { method: 'POST', body: JSON.stringify({ issuerUrl }) },
      );
      return res.data;
    },
  });
}
