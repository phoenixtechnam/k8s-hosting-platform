import { z } from 'zod';
import { uuidField } from './shared.js';

// ─── CIDR validation helper ────────────────────────────────────────────────

const cidrPattern = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$|^[0-9a-fA-F:]+\/\d{1,3}$/;

function isValidCidrList(value: string): boolean {
  return value.split(',').every((cidr) => cidrPattern.test(cidr.trim()));
}

// ─── Response ───────────────────────────────────────────────────────────────

export const ingressRouteResponseSchema = z.object({
  id: uuidField,
  domainId: z.string(),
  hostname: z.string(),
  path: z.string(),
  deploymentId: z.string().nullable(),
  ingressCname: z.string(),
  nodeHostname: z.string().nullable(),
  isApex: z.number(),
  tlsMode: z.enum(['auto', 'custom', 'none']),
  status: z.string(),
  // Redirect settings
  forceHttps: z.number(),
  wwwRedirect: z.enum(['none', 'add-www', 'remove-www']),
  redirectUrl: z.string().nullable(),
  // Security settings
  ipAllowlist: z.string().nullable(),
  rateLimitRps: z.number().nullable(),
  rateLimitConnections: z.number().nullable(),
  rateLimitBurstMultiplier: z.string().nullable(),
  // WAF settings
  wafEnabled: z.number(),
  wafOwaspCrs: z.number(),
  wafAnomalyThreshold: z.number(),
  wafExcludedRules: z.string().nullable(),
  // Advanced settings
  customErrorCodes: z.string().nullable(),
  customErrorPath: z.string().nullable(),
  additionalHeaders: z.record(z.string(), z.string()).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// ─── Input ──────────────────────────────────────────────────────────────────

export const createIngressRouteSchema = z.object({
  hostname: z.string().min(1).max(255),
  path: z.string().min(1).max(255).optional(),
  deployment_id: uuidField.nullable().optional(),
});

export const updateIngressRouteSchema = z.object({
  deployment_id: uuidField.nullable().optional(),
  tls_mode: z.enum(['auto', 'custom', 'none']).optional(),
  node_hostname: z.string().max(255).nullable().optional(),
});

// ─── Route Settings Inputs ──────────────────────────────────────────────────

export const updateRedirectSettingsSchema = z.object({
  force_https: z.boolean().optional(),
  www_redirect: z.enum(['none', 'add-www', 'remove-www']).optional(),
  redirect_url: z.string().url().max(2048).nullable().optional(),
});

export const updateSecuritySettingsSchema = z.object({
  ip_allowlist: z.string().max(2000).nullable().optional().refine(
    (val) => val === null || val === undefined || isValidCidrList(val),
    { message: 'ip_allowlist must be comma-separated CIDRs (e.g. 10.0.0.0/8,192.168.0.0/16)' },
  ),
  rate_limit_rps: z.number().int().min(1).max(10000).nullable().optional(),
  rate_limit_connections: z.number().int().min(1).max(10000).nullable().optional(),
  rate_limit_burst_multiplier: z.number().min(1).max(10).nullable().optional(),
  waf_enabled: z.boolean().optional(),
  waf_owasp_crs: z.boolean().optional(),
  waf_anomaly_threshold: z.number().int().min(1).max(100).optional(),
  waf_excluded_rules: z.string().max(2000).nullable().optional(),
});

export const updateAdvancedSettingsSchema = z.object({
  custom_error_codes: z.string().max(255).nullable().optional(),
  custom_error_path: z.string().max(255).nullable().optional(),
  additional_headers: z.record(
    z.string().max(255).regex(/^[a-zA-Z0-9\-_]+$/, 'Header name must contain only alphanumeric characters, hyphens, and underscores'),
    z.string().max(4096).refine(
      (val) => !/[\n\r{}`]/.test(val),
      { message: 'Header value must not contain newlines, curly braces, or backticks' },
    ),
  ).refine(
    (val) => val === null || val === undefined || Object.keys(val).length <= 50,
    { message: 'Maximum 50 headers allowed' },
  ).nullable().optional(),
});

// ─── Protected Directories ──────────────────────────────────────────────────

export const routeProtectedDirResponseSchema = z.object({
  id: uuidField,
  routeId: z.string(),
  path: z.string(),
  realm: z.string(),
  enabled: z.boolean(),
  userCount: z.number(),
  createdAt: z.string(),
});

export const createRouteProtectedDirSchema = z.object({
  path: z.string().min(1).max(255)
    .regex(/^\//, 'Path must start with /')
    .refine((val) => !val.includes('..'), { message: 'Path must not contain ..' }),
  realm: z.string().min(1).max(255).optional(),
});

export const updateRouteProtectedDirSchema = z.object({
  path: z.string().min(1).max(255)
    .regex(/^\//, 'Path must start with /')
    .refine((val) => !val.includes('..'), { message: 'Path must not contain ..' })
    .optional(),
  realm: z.string().min(1).max(255).optional(),
  enabled: z.boolean().optional(),
});

// ─── Auth Users (scoped to protected directory) ─────────────────────────────

export const routeAuthUserResponseSchema = z.object({
  id: uuidField,
  dirId: z.string(),
  username: z.string(),
  enabled: z.boolean(),
  createdAt: z.string(),
});

export const createAuthUserSchema = z.object({
  username: z.string().min(1).max(255),
  password: z.string().min(8).max(128),
});

export const toggleAuthUserSchema = z.object({
  enabled: z.boolean(),
});

export const changeAuthUserPasswordSchema = z.object({
  password: z.string().min(8).max(128),
});

// ─── WAF Logs ───────────────────────────────────────────────────────────────

export const wafLogResponseSchema = z.object({
  id: z.string(),
  routeId: z.string(),
  clientId: z.string(),
  ruleId: z.string(),
  severity: z.string(),
  message: z.string(),
  requestUri: z.string().nullable(),
  requestMethod: z.string().nullable(),
  sourceIp: z.string().nullable(),
  matchedData: z.string().nullable(),
  createdAt: z.string(),
});

export const ingestWafLogSchema = z.object({
  ruleId: z.string().min(1).max(50),
  severity: z.string().min(1).max(20),
  message: z.string().min(1).max(4096),
  requestUri: z.string().max(2048).nullable().optional(),
  requestMethod: z.string().max(10).nullable().optional(),
  sourceIp: z.string().max(45).nullable().optional(),
  matchedData: z.string().max(4096).nullable().optional(),
});

// ─── Platform Ingress Settings ──────────────────────────────────────────────

export const ingressSettingsResponseSchema = z.object({
  ingressBaseDomain: z.string(),
  ingressDefaultIpv4: z.string(),
  ingressDefaultIpv6: z.string().nullable(),
});

export const updateIngressSettingsSchema = z.object({
  ingressBaseDomain: z.string().min(1).max(255).optional(),
  ingressDefaultIpv4: z.string().min(1).max(45).optional(),
  ingressDefaultIpv6: z.string().max(45).nullable().optional(),
});

// ─── Types ──────────────────────────────────────────────────────────────────

export type IngressRouteResponse = z.infer<typeof ingressRouteResponseSchema>;
export type CreateIngressRouteInput = z.infer<typeof createIngressRouteSchema>;
export type UpdateIngressRouteInput = z.infer<typeof updateIngressRouteSchema>;
export type UpdateRedirectSettingsInput = z.infer<typeof updateRedirectSettingsSchema>;
export type UpdateSecuritySettingsInput = z.infer<typeof updateSecuritySettingsSchema>;
export type UpdateAdvancedSettingsInput = z.infer<typeof updateAdvancedSettingsSchema>;
export type RouteProtectedDirResponse = z.infer<typeof routeProtectedDirResponseSchema>;
export type CreateRouteProtectedDirInput = z.infer<typeof createRouteProtectedDirSchema>;
export type UpdateRouteProtectedDirInput = z.infer<typeof updateRouteProtectedDirSchema>;
export type RouteAuthUserResponse = z.infer<typeof routeAuthUserResponseSchema>;
export type CreateAuthUserInput = z.infer<typeof createAuthUserSchema>;
export type ToggleAuthUserInput = z.infer<typeof toggleAuthUserSchema>;
export type ChangeAuthUserPasswordInput = z.infer<typeof changeAuthUserPasswordSchema>;
export type WafLogResponse = z.infer<typeof wafLogResponseSchema>;
export type IngestWafLogInput = z.infer<typeof ingestWafLogSchema>;
export type IngressSettingsResponse = z.infer<typeof ingressSettingsResponseSchema>;
export type UpdateIngressSettingsInput = z.infer<typeof updateIngressSettingsSchema>;
