/**
 * Per-ingress OAuth2/OIDC access control — API contract.
 *
 * Each tenant ingress can opt into OIDC-gated access via a single
 * config row keyed on `ingressRouteId`. The platform manages a
 * per-client oauth2-proxy + claim-validator behind the scenes.
 */
import { z } from 'zod';

export const oidcAuthMethodSchema = z.enum([
  'client_secret_basic',
  'client_secret_post',
]);
export type OidcAuthMethod = z.infer<typeof oidcAuthMethodSchema>;

export const oidcResponseTypeSchema = z.enum([
  'code',
  'id_token',
  'code_id_token',
]);
export type OidcResponseType = z.infer<typeof oidcResponseTypeSchema>;

export const claimOperatorSchema = z.enum([
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'in',
  'not_in',
  'exists',
  'regex',
]);
export type ClaimOperator = z.infer<typeof claimOperatorSchema>;

/**
 * Single claim-validation rule. All rules on an ingress are evaluated
 * with AND semantics by the claim-validator sidecar after oauth2-proxy
 * has validated the OIDC session.
 *
 * - `equals` / `not_equals`: string equality (case-sensitive)
 * - `contains` / `not_contains`: substring for strings, element-of for arrays
 * - `in` / `not_in`: claim value matches one of the supplied values
 * - `exists`: claim is present (any value); `value` ignored
 * - `regex`: ECMAScript regex match
 */
export const claimRuleSchema = z.object({
  claim: z.string().min(1),
  operator: claimOperatorSchema,
  value: z.union([z.string(), z.array(z.string())]).optional(),
});
export type ClaimRule = z.infer<typeof claimRuleSchema>;

/**
 * Per-client reusable OIDC provider config.
 *
 * Stored in client_oidc_providers; referenced by zero or more
 * ingress_auth_configs.providerId. Operators manage these via the
 * /clients/:cid/oidc-providers endpoints.
 */
export const oidcProviderInputSchema = z.object({
  name: z.string().min(1).max(120),
  issuerUrl: z.string().url(),
  oauthClientId: z.string().min(1),
  /** Plaintext. Required on create; optional on update (omitted = keep). */
  oauthClientSecret: z.string().min(1).optional(),
  authMethod: oidcAuthMethodSchema.default('client_secret_basic'),
  responseType: oidcResponseTypeSchema.default('code'),
  usePkce: z.boolean().default(true),
  defaultScopes: z.string().default('openid profile email'),
});
export type OidcProviderInput = z.infer<typeof oidcProviderInputSchema>;

export const oidcProviderResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  issuerUrl: z.string(),
  oauthClientId: z.string(),
  secretSet: z.boolean(),
  authMethod: oidcAuthMethodSchema,
  responseType: oidcResponseTypeSchema,
  usePkce: z.boolean(),
  defaultScopes: z.string(),
  /** Number of ingress_auth_configs referencing this provider. */
  consumerCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type OidcProviderResponse = z.infer<typeof oidcProviderResponseSchema>;

/**
 * Per-ingress access policy. Two write paths:
 *   - providerId: pick an existing provider for this client (preferred)
 *   - inline OIDC fields: auto-create a provider on first write
 *
 * The inline path preserves the v1 UX where operators type credentials
 * directly into the ingress form. After provider rows accumulate the
 * UI prefers the dropdown.
 */
export const ingressAuthConfigSchema = z.object({
  enabled: z.boolean(),
  /** Preferred path: pick an existing provider. */
  providerId: z.string().optional(),
  /** Compat shim: inline OIDC fields auto-create a provider. */
  issuerUrl: z.string().url().optional(),
  clientId: z.string().min(1).optional(),
  clientSecret: z.string().min(1).optional(),
  authMethod: oidcAuthMethodSchema.optional(),
  responseType: oidcResponseTypeSchema.optional(),
  usePkce: z.boolean().optional(),
  /** Per-ingress scope override; null/omitted = inherit provider default. */
  scopes: z.string().optional(),
  /**
   * Optional fixed redirect URL after a successful login. When set,
   * every login lands on this URL instead of the original request URI.
   * Useful for forwarding into an app's own OIDC callback or a static
   * post-login landing page.
   */
  postLoginRedirectUrl: z.string().url().nullable().optional(),
  allowedEmails: z.string().nullable().optional(),
  allowedEmailDomains: z.string().nullable().optional(),
  allowedGroups: z.string().nullable().optional(),
  claimRules: z.array(claimRuleSchema).nullable().optional(),
  passAuthorizationHeader: z.boolean().default(true),
  passAccessToken: z.boolean().default(true),
  passIdToken: z.boolean().default(true),
  passUserHeaders: z.boolean().default(true),
  setXauthrequest: z.boolean().default(true),
  cookieDomain: z.string().nullable().optional(),
  cookieRefreshSeconds: z.number().int().positive().default(3600),
  cookieExpireSeconds: z.number().int().positive().default(86400),
});
export type IngressAuthConfigInput = z.infer<typeof ingressAuthConfigSchema>;

/**
 * Server-rendered response. Provider fields are flattened from the
 * joined provider row (issuer, clientId, etc.) for one-shot rendering.
 * Client secret presence is exposed via secretSet on the provider
 * shape; the secret itself is never returned.
 */
export const ingressAuthConfigResponseSchema = z.object({
  enabled: z.boolean(),
  providerId: z.string(),
  providerName: z.string(),
  issuerUrl: z.string(),
  clientId: z.string(),
  clientSecretSet: z.boolean(),
  authMethod: oidcAuthMethodSchema,
  responseType: oidcResponseTypeSchema,
  usePkce: z.boolean(),
  /** Effective scopes (override OR provider default). */
  scopes: z.string(),
  /** Per-ingress override; null = inheriting from provider. */
  scopesOverride: z.string().nullable(),
  postLoginRedirectUrl: z.string().nullable(),
  allowedEmails: z.string().nullable(),
  allowedEmailDomains: z.string().nullable(),
  allowedGroups: z.string().nullable(),
  claimRules: z.array(claimRuleSchema).nullable(),
  passAuthorizationHeader: z.boolean(),
  passAccessToken: z.boolean(),
  passIdToken: z.boolean(),
  passUserHeaders: z.boolean(),
  setXauthrequest: z.boolean(),
  cookieDomain: z.string().nullable(),
  cookieRefreshSeconds: z.number().int(),
  cookieExpireSeconds: z.number().int(),
  /** OAuth callback URL the operator must register at the IdP. */
  callbackUrl: z.string(),
  lastError: z.string().nullable(),
  lastReconciledAt: z.string().nullable(),
});
export type IngressAuthConfigResponse = z.infer<
  typeof ingressAuthConfigResponseSchema
>;

export const ingressAuthTestResponseSchema = z.object({
  ok: z.boolean(),
  issuerReachable: z.boolean(),
  authorizationEndpoint: z.string().nullable(),
  tokenEndpoint: z.string().nullable(),
  jwksUri: z.string().nullable(),
  error: z.string().nullable(),
});
export type IngressAuthTestResponse = z.infer<
  typeof ingressAuthTestResponseSchema
>;
