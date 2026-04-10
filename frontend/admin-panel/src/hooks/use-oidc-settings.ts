import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

// ─── Provider Types ──────────────────────────────────────────────────────────

export interface OidcProvider {
  readonly id: string;
  readonly displayName: string;
  readonly issuerUrl: string;
  readonly clientId: string;
  readonly panelScope: 'admin' | 'client';
  readonly enabled: boolean;
  readonly backchannelLogoutEnabled: boolean;
  readonly displayOrder: number;
  readonly discoveryMetadata: Record<string, unknown> | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OidcGlobalSettings {
  readonly disableLocalAuthAdmin: boolean;
  readonly disableLocalAuthClient: boolean;
  readonly hasBreakGlassSecret: boolean;
  readonly proxyProtectAdmin: boolean;
  readonly proxyProtectClient: boolean;
  readonly breakGlassPath: string | null;
}

export interface OidcTestResult {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly jwks_uri: string;
  readonly backchannel_logout_supported: boolean;
  readonly keys_count: number;
  readonly status: string;
}

// ─── Provider Hooks ──────────────────────────────────────────────────────────

export function useOidcProviders() {
  return useQuery({
    queryKey: ['oidc-providers'],
    queryFn: () => apiFetch<{ data: readonly OidcProvider[] }>('/api/v1/admin/oidc/providers'),
  });
}

interface CreateProviderInput {
  readonly display_name: string;
  readonly issuer_url: string;
  readonly client_id: string;
  readonly client_secret: string;
  readonly panel_scope: 'admin' | 'client';
  readonly enabled?: boolean;
  readonly backchannel_logout_enabled?: boolean;
}

export function useCreateOidcProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateProviderInput) =>
      apiFetch<{ data: OidcProvider }>('/api/v1/admin/oidc/providers', {
        method: 'POST', body: JSON.stringify(input),
      }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['oidc-providers'] }); },
  });
}

export function useUpdateOidcProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: Partial<CreateProviderInput> & { id: string }) =>
      apiFetch<{ data: OidcProvider }>(`/api/v1/admin/oidc/providers/${id}`, {
        method: 'PATCH', body: JSON.stringify(input),
      }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['oidc-providers'] }); },
  });
}

export function useDeleteOidcProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/api/v1/admin/oidc/providers/${id}`, { method: 'DELETE' }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['oidc-providers'] }); },
  });
}

export function useTestOidcProvider() {
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ data: OidcTestResult }>(`/api/v1/admin/oidc/providers/${id}/test`, { method: 'POST' }),
  });
}

// ─── Global Settings Hooks ───────────────────────────────────────────────────

export function useOidcGlobalSettings() {
  return useQuery({
    queryKey: ['oidc-global-settings'],
    queryFn: () => apiFetch<{ data: OidcGlobalSettings }>('/api/v1/admin/oidc/settings'),
  });
}

interface SaveGlobalSettingsInput {
  readonly disable_local_auth_admin?: boolean;
  readonly disable_local_auth_client?: boolean;
  readonly break_glass_secret?: string;
  readonly proxy_protect_admin?: boolean;
  readonly proxy_protect_client?: boolean;
}

export function useSaveOidcGlobalSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveGlobalSettingsInput) =>
      apiFetch<{ data: OidcGlobalSettings }>('/api/v1/admin/oidc/settings', {
        method: 'PUT', body: JSON.stringify(input),
      }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['oidc-global-settings'] }); },
  });
}

export function useRegenerateBreakGlass() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ data: { breakGlassPath: string } }>('/api/v1/admin/oidc/regenerate-break-glass', {
        method: 'POST',
      }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['oidc-global-settings'] }); },
  });
}

export function useRegenerateCookieSecret() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ data: { regenerated: boolean } }>('/api/v1/admin/oidc/regenerate-cookie-secret', {
        method: 'POST',
      }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['oidc-global-settings'] }); },
  });
}
