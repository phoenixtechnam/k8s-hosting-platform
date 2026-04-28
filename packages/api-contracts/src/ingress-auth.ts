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

export const ingressAuthConfigSchema = z.object({
  enabled: z.boolean(),
  issuerUrl: z.string().url(),
  clientId: z.string().min(1),
  // On read responses this is OMITTED (never returned to the client).
  // On write requests it's required when the row is being created
  // and optional on update (omitted = keep existing).
  clientSecret: z.string().min(1).optional(),
  authMethod: oidcAuthMethodSchema.default('client_secret_basic'),
  responseType: oidcResponseTypeSchema.default('code'),
  usePkce: z.boolean().default(true),
  scopes: z.string().default('openid profile email'),
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
 * Server-rendered response. Client secret is replaced by a presence
 * marker so the UI can show "(secret set — clear to replace)".
 */
export const ingressAuthConfigResponseSchema = ingressAuthConfigSchema
  .omit({ clientSecret: true })
  .extend({
    clientSecretSet: z.boolean(),
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
