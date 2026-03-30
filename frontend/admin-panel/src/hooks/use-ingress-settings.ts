import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { IngressSettingsResponse } from '@k8s-hosting/api-contracts';

interface IngressSettingsWrapped {
  readonly data: IngressSettingsResponse;
}

export function useIngressSettings() {
  return useQuery({
    queryKey: ['ingress-settings'],
    queryFn: () => apiFetch<IngressSettingsWrapped>('/api/v1/admin/ingress-settings'),
    staleTime: 60_000,
  });
}

export function useUpdateIngressSettings() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { ingressBaseDomain?: string; ingressDefaultIpv4?: string; ingressDefaultIpv6?: string | null }) =>
      apiFetch<IngressSettingsWrapped>('/api/v1/admin/ingress-settings', {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ingress-settings'] });
    },
  });
}
