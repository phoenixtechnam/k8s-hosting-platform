import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface SystemSettings {
  readonly id: string;
  readonly platformName: string;
  readonly adminPanelUrl: string | null;
  readonly clientPanelUrl: string | null;
  readonly supportEmail: string | null;
  readonly supportUrl: string | null;
  readonly ingressBaseDomain: string | null;
  readonly mailHostname: string | null;
  readonly webmailUrl: string | null;
  readonly apiRateLimit: number;
  readonly updatedAt: string;
}

export function useSystemSettings() {
  return useQuery({
    queryKey: ['system-settings'],
    queryFn: () => apiFetch<{ data: SystemSettings }>('/api/v1/admin/system-settings'),
    staleTime: 60_000,
  });
}

export function useUpdateSystemSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Partial<SystemSettings>) =>
      apiFetch<{ data: SystemSettings }>('/api/v1/admin/system-settings', {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['system-settings'] });
    },
  });
}
