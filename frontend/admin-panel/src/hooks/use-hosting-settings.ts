import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { HostingSettingsResponse } from '@/types/api';

function basePath(clientId: string, domainId: string) {
  return `/api/v1/clients/${clientId}/domains/${domainId}/hosting-settings`;
}

export function useHostingSettings(clientId: string | undefined, domainId: string | undefined) {
  return useQuery({
    queryKey: ['hosting-settings', clientId, domainId],
    queryFn: () => apiFetch<{ data: HostingSettingsResponse }>(basePath(clientId!, domainId!)),
    enabled: Boolean(clientId && domainId),
  });
}

interface UpdateHostingSettingsInput {
  readonly redirect_www?: boolean;
  readonly redirect_https?: boolean;
  readonly forward_external?: string | null;
  readonly webroot_path?: string;
  readonly hosting_enabled?: boolean;
}

export function useUpdateHostingSettings(clientId: string | undefined, domainId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: UpdateHostingSettingsInput) =>
      apiFetch<{ data: HostingSettingsResponse }>(basePath(clientId!, domainId!), {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['hosting-settings', clientId, domainId] });
    },
  });
}
