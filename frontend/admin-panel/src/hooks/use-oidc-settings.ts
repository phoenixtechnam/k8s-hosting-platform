import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface OidcSettings {
  readonly id: string;
  readonly issuerUrl: string;
  readonly clientId: string;
  readonly enabled: boolean;
  readonly disableLocalAuth: boolean;
  readonly backchannelLogoutEnabled: boolean;
  readonly discoveryMetadata: Record<string, unknown> | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface OidcTestResult {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly jwks_uri: string;
  readonly end_session_endpoint: string | null;
  readonly backchannel_logout_supported: boolean;
  readonly keys_count: number;
  readonly status: string;
}

export function useOidcSettings() {
  return useQuery({
    queryKey: ['oidc-settings'],
    queryFn: () => apiFetch<{ data: OidcSettings | null }>('/api/v1/admin/oidc/settings'),
  });
}

interface SaveOidcInput {
  readonly issuer_url: string;
  readonly client_id: string;
  readonly client_secret: string;
  readonly enabled?: boolean;
  readonly disable_local_auth?: boolean;
  readonly backchannel_logout_enabled?: boolean;
}

export function useSaveOidcSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveOidcInput) =>
      apiFetch<{ data: OidcSettings }>('/api/v1/admin/oidc/settings', {
        method: 'PUT',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['oidc-settings'] });
    },
  });
}

export function useTestOidcConnection() {
  return useMutation({
    mutationFn: () =>
      apiFetch<{ data: OidcTestResult }>('/api/v1/admin/oidc/test', { method: 'POST' }),
  });
}
