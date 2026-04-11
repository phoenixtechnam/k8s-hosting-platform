import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RouteRedirectSettings {
  readonly forceHttps: boolean;
  readonly wwwRedirect: 'none' | 'add-www' | 'remove-www';
  readonly customRedirectUrl: string | null;
}

export interface RouteSecuritySettings {
  readonly basicAuthEnabled: boolean;
  readonly basicAuthRealm: string;
  readonly ipAllowlist: string | null;
  readonly rateLimitRps: number | null;
  readonly rateLimitConnections: number | null;
  readonly rateLimitBurst: number | null;
  readonly wafEnabled: boolean;
  readonly wafOwaspCoreRules: boolean;
  readonly wafAnomalyThreshold: number;
  readonly wafExcludedRuleIds: string | null;
}

export interface RouteAdvancedSettings {
  readonly customErrorCodes: string | null;
  readonly customErrorPagesPath: string | null;
  readonly proxyHeaders: readonly { readonly name: string; readonly value: string }[];
}

export interface RouteDetailResponse {
  readonly id: string;
  readonly domainId: string;
  readonly hostname: string;
  readonly deploymentId: string | null;
  readonly ingressCname: string;
  readonly nodeHostname: string | null;
  readonly isApex: number;
  readonly tlsMode: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly forceHttps: boolean;
  readonly wwwRedirect: 'none' | 'add-www' | 'remove-www';
  readonly customRedirectUrl: string | null;
  readonly basicAuthEnabled: boolean;
  readonly basicAuthRealm: string;
  readonly ipAllowlist: string | null;
  readonly rateLimitRps: number | null;
  readonly rateLimitConnections: number | null;
  readonly rateLimitBurst: number | null;
  readonly wafEnabled: boolean;
  readonly wafOwaspCoreRules: boolean;
  readonly wafAnomalyThreshold: number;
  readonly wafExcludedRuleIds: string | null;
  readonly customErrorCodes: string | null;
  readonly customErrorPagesPath: string | null;
  readonly proxyHeaders: readonly { readonly name: string; readonly value: string }[];
}

export interface RouteAuthUser {
  readonly id: string;
  readonly routeId: string;
  readonly username: string;
  readonly enabled: boolean;
  readonly createdAt: string;
}

export interface WafLogEntry {
  readonly id: string;
  readonly routeId: string;
  readonly timestamp: string;
  readonly ruleId: string;
  readonly action: 'BLOCKED' | 'LOGGED';
  readonly method: string;
  readonly path: string;
  readonly matchMessage: string;
  readonly clientIp: string;
  readonly severity: 'CRITICAL' | 'WARNING' | 'INFO';
}

// ─── Route Detail ───────────────────────────────────────────────────────────

function routeBasePath(clientId: string, routeId: string) {
  return `/api/v1/clients/${clientId}/routes/${routeId}`;
}

export function useRouteDetail(clientId: string | undefined, routeId: string | undefined) {
  return useQuery({
    queryKey: ['route-detail', clientId, routeId],
    queryFn: () =>
      apiFetch<{ data: RouteDetailResponse }>(routeBasePath(clientId!, routeId!)),
    enabled: Boolean(clientId && routeId),
  });
}

// ─── Redirect Settings ──────────────────────────────────────────────────────

export function useUpdateRouteRedirects(clientId: string | undefined, routeId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      readonly force_https?: boolean;
      readonly www_redirect?: 'none' | 'add-www' | 'remove-www';
      readonly custom_redirect_url?: string | null;
    }) =>
      apiFetch<{ data: RouteDetailResponse }>(
        `${routeBasePath(clientId!, routeId!)}/redirects`,
        { method: 'PATCH', body: JSON.stringify(input) },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['route-detail', clientId, routeId] });
    },
  });
}

// ─── Security Settings ──────────────────────────────────────────────────────

export function useUpdateRouteSecurity(clientId: string | undefined, routeId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      readonly basic_auth_enabled?: boolean;
      readonly basic_auth_realm?: string;
      readonly ip_allowlist?: string | null;
      readonly rate_limit_rps?: number | null;
      readonly rate_limit_connections?: number | null;
      readonly rate_limit_burst?: number | null;
      readonly waf_enabled?: boolean;
      readonly waf_owasp_core_rules?: boolean;
      readonly waf_anomaly_threshold?: number;
      readonly waf_excluded_rule_ids?: string | null;
    }) =>
      apiFetch<{ data: RouteDetailResponse }>(
        `${routeBasePath(clientId!, routeId!)}/security`,
        { method: 'PATCH', body: JSON.stringify(input) },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['route-detail', clientId, routeId] });
    },
  });
}

// ─── Advanced Settings ──────────────────────────────────────────────────────

export function useUpdateRouteAdvanced(clientId: string | undefined, routeId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      readonly custom_error_codes?: string | null;
      readonly custom_error_pages_path?: string | null;
      readonly proxy_headers?: readonly { readonly name: string; readonly value: string }[];
    }) =>
      apiFetch<{ data: RouteDetailResponse }>(
        `${routeBasePath(clientId!, routeId!)}/advanced`,
        { method: 'PATCH', body: JSON.stringify(input) },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['route-detail', clientId, routeId] });
    },
  });
}

// ─── Auth Users ─────────────────────────────────────────────────────────────

export function useRouteAuthUsers(clientId: string | undefined, routeId: string | undefined) {
  return useQuery({
    queryKey: ['route-auth-users', clientId, routeId],
    queryFn: () =>
      apiFetch<{ data: readonly RouteAuthUser[] }>(
        `${routeBasePath(clientId!, routeId!)}/auth-users`,
      ),
    enabled: Boolean(clientId && routeId),
  });
}

export function useCreateRouteAuthUser(clientId: string | undefined, routeId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { readonly username: string; readonly password: string }) =>
      apiFetch<{ data: RouteAuthUser }>(
        `${routeBasePath(clientId!, routeId!)}/auth-users`,
        { method: 'POST', body: JSON.stringify(input) },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['route-auth-users', clientId, routeId] });
    },
  });
}

export function useDeleteRouteAuthUser(clientId: string | undefined, routeId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (userId: string) =>
      apiFetch<void>(
        `${routeBasePath(clientId!, routeId!)}/auth-users/${userId}`,
        { method: 'DELETE' },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['route-auth-users', clientId, routeId] });
    },
  });
}

export function useToggleRouteAuthUser(clientId: string | undefined, routeId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ userId, enabled }: { readonly userId: string; readonly enabled: boolean }) =>
      apiFetch<{ data: RouteAuthUser }>(
        `${routeBasePath(clientId!, routeId!)}/auth-users/${userId}/toggle`,
        { method: 'POST', body: JSON.stringify({ enabled }) },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['route-auth-users', clientId, routeId] });
    },
  });
}

// ─── WAF Logs ───────────────────────────────────────────────────────────────

export function useRouteWafLogs(clientId: string | undefined, routeId: string | undefined) {
  return useQuery({
    queryKey: ['route-waf-logs', clientId, routeId],
    queryFn: () =>
      apiFetch<{ data: readonly WafLogEntry[] }>(
        `${routeBasePath(clientId!, routeId!)}/waf-logs`,
      ),
    enabled: Boolean(clientId && routeId),
  });
}
