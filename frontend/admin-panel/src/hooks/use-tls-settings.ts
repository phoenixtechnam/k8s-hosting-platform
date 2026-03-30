import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { TlsSettingsResponse } from '@k8s-hosting/api-contracts';

interface TlsSettingsWrapped {
  readonly data: TlsSettingsResponse;
}

export function useTlsSettings() {
  return useQuery({
    queryKey: ['tls-settings'],
    queryFn: () => apiFetch<TlsSettingsWrapped>('/api/v1/admin/tls-settings'),
    staleTime: 60_000,
  });
}

export function useUpdateTlsSettings() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { clusterIssuerName?: string; autoTlsEnabled?: boolean }) =>
      apiFetch<TlsSettingsWrapped>('/api/v1/admin/tls-settings', {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tls-settings'] });
    },
  });
}
