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

interface UpdateWebmailSettingsInput {
  readonly defaultWebmailUrl?: string;
  readonly mailServerHostname?: string;
  readonly emailSendRateLimitDefault?: number | null;
}

export function useUpdateWebmailSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateWebmailSettingsInput) =>
      apiFetch<WebmailSettingsWrapped>('/api/v1/admin/webmail-settings', {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['webmail-settings'] });
    },
  });
}
