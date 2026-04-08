import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { WebmailSettingsResponse } from '@k8s-hosting/api-contracts';

interface WebmailSettingsWrapped {
  readonly data: WebmailSettingsResponse;
}

export function useWebmailSettings() {
  return useQuery({
    queryKey: ['webmail-settings'],
    queryFn: () => apiFetch<WebmailSettingsWrapped>('/api/v1/admin/webmail-settings'),
    staleTime: 60_000,
  });
}

export function useUpdateWebmailSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { defaultWebmailUrl?: string }) =>
      apiFetch<WebmailSettingsWrapped>('/api/v1/admin/webmail-settings', {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['webmail-settings'] });
    },
  });
}
