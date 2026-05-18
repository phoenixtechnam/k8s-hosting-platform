import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { WebmailSettingsResponse } from '@k8s-hosting/api-contracts';

interface WebmailSettingsWrapped {
  readonly data: WebmailSettingsResponse;
}

// 2026-05-18: engine flips now run through the task-center. When the
// PATCH payload contains `defaultWebmailEngine`, the backend kicks off
// a 5-step background task and returns `taskId` alongside the updated
// settings. The frontend opens MailTaskProgressModal so the operator
// sees IR-flip → Pod-scale → wait-ready → URL-verify in real time.
interface UpdateWebmailSettingsWrapped {
  readonly data: WebmailSettingsResponse & { readonly taskId?: string };
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
  readonly defaultWebmailEngine?: 'roundcube' | 'bulwark';
  // 2026-05-18: feature-visibility toggles. All default to false
  // (hidden) on a fresh install. Flipping any of these triggers a
  // rolling restart of the webmail Deployments so the
  // webmail-feature-css initContainer (Bulwark) / wrapper script
  // (Roundcube) picks up the new ConfigMap content.
  readonly webmailShowContacts?: boolean;
  readonly webmailShowCalendar?: boolean;
  readonly webmailShowFiles?: boolean;
}

export function useUpdateWebmailSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateWebmailSettingsInput) =>
      apiFetch<UpdateWebmailSettingsWrapped>('/api/v1/admin/webmail-settings', {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['webmail-settings'] });
      // Bump the task-center chip immediately when the engine-flip task is
      // emitted — otherwise the operator waits up to 30s for the next poll.
      queryClient.invalidateQueries({ queryKey: ['task-center', 'me'] });
    },
  });
}
