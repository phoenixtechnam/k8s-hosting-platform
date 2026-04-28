/**
 * Ingress access-control service (provider-split version).
 *
 * Ingress configs reference a `client_oidc_providers` row via
 * provider_id. Read responses flatten the joined provider so the
 * UI doesn't need to compose two requests. Write inputs accept
 * either:
 *   - `providerId` (preferred — picks an existing provider), OR
 *   - inline OIDC fields (compat shim — auto-creates a provider
 *     for the client on first write).
 *
 * The shim preserves the v1 UX where the operator types issuer/
 * client/secret directly into the ingress form. After a few
 * provider rows accumulate, the UI surfaces a dropdown so they
 * can be reused.
 */

import { eq, and } from 'drizzle-orm';
import {
  ingressAuthConfigs,
  ingressRoutes,
  domains,
  clientOauth2ProxyState,
  clientOidcProviders,
} from '../../db/schema.js';
import { encrypt, decrypt } from '../oidc/crypto.js';
import { ApiError } from '../../shared/errors.js';
import {
  createProvider,
  type ProviderInput,
} from './providers-service.js';
import type { Database } from '../../db/index.js';
import type {
  ClientOidcProvider,
  IngressAuthConfig,
  IngressClaimRule,
} from '../../db/schema.js';

export interface IngressAuthConfigInput {
  readonly enabled: boolean;
  /** Preferred path: pick an existing provider. */
  readonly providerId?: string;
  /** Compat shim: inline OIDC fields auto-create a provider. */
  readonly issuerUrl?: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly authMethod?: 'client_secret_basic' | 'client_secret_post';
  readonly responseType?: 'code' | 'id_token' | 'code_id_token';
  readonly usePkce?: boolean;
  /** Per-ingress override of the provider's default_scopes. */
  readonly scopes?: string;
  readonly postLoginRedirectUrl?: string | null;
  readonly allowedEmails?: string | null;
  readonly allowedEmailDomains?: string | null;
  readonly allowedGroups?: string | null;
  readonly claimRules?: ReadonlyArray<IngressClaimRule> | null;
  readonly passAuthorizationHeader: boolean;
  readonly passAccessToken: boolean;
  readonly passIdToken: boolean;
  readonly passUserHeaders: boolean;
  readonly setXauthrequest: boolean;
  readonly cookieDomain?: string | null;
  readonly cookieRefreshSeconds: number;
  readonly cookieExpireSeconds: number;
}

export interface IngressAuthConfigResponse {
  readonly enabled: boolean;
  readonly providerId: string;
  readonly providerName: string;
  /** Issuer + client_id flattened from the joined provider. */
  readonly issuerUrl: string;
  readonly clientId: string;
  readonly clientSecretSet: boolean;
  readonly authMethod: 'client_secret_basic' | 'client_secret_post';
  readonly responseType: 'code' | 'id_token' | 'code_id_token';
  readonly usePkce: boolean;
  readonly scopes: string;
  readonly scopesOverride: string | null;
  readonly postLoginRedirectUrl: string | null;
  readonly allowedEmails: string | null;
  readonly allowedEmailDomains: string | null;
  readonly allowedGroups: string | null;
  readonly claimRules: ReadonlyArray<IngressClaimRule> | null;
  readonly passAuthorizationHeader: boolean;
  readonly passAccessToken: boolean;
  readonly passIdToken: boolean;
  readonly passUserHeaders: boolean;
  readonly setXauthrequest: boolean;
  readonly cookieDomain: string | null;
  readonly cookieRefreshSeconds: number;
  readonly cookieExpireSeconds: number;
  readonly callbackUrl: string;
  readonly lastError: string | null;
  readonly lastReconciledAt: string | null;
}

export interface IngressAuthServiceContext {
  readonly encryptionKey: string;
}

export function buildCallbackUrl(hostname: string): string {
  return `https://${hostname}/oauth2/callback`;
}

function buildResponse(
  cfg: IngressAuthConfig,
  provider: ClientOidcProvider,
  hostname: string,
): IngressAuthConfigResponse {
  return {
    enabled: cfg.enabled,
    providerId: provider.id,
    providerName: provider.name,
    issuerUrl: provider.issuerUrl,
    clientId: provider.oauthClientId,
    clientSecretSet: provider.oauthClientSecretEncrypted.length > 0,
    authMethod: provider.authMethod as IngressAuthConfigResponse['authMethod'],
    responseType: provider.responseType as IngressAuthConfigResponse['responseType'],
    usePkce: provider.usePkce,
    scopes: cfg.scopesOverride ?? provider.defaultScopes,
    scopesOverride: cfg.scopesOverride ?? null,
    postLoginRedirectUrl: cfg.postLoginRedirectUrl ?? null,
    allowedEmails: cfg.allowedEmails ?? null,
    allowedEmailDomains: cfg.allowedEmailDomains ?? null,
    allowedGroups: cfg.allowedGroups ?? null,
    claimRules: (cfg.claimRules as IngressClaimRule[] | null) ?? null,
    passAuthorizationHeader: cfg.passAuthorizationHeader,
    passAccessToken: cfg.passAccessToken,
    passIdToken: cfg.passIdToken,
    passUserHeaders: cfg.passUserHeaders,
    setXauthrequest: cfg.setXauthrequest,
    cookieDomain: cfg.cookieDomain ?? null,
    cookieRefreshSeconds: cfg.cookieRefreshSeconds,
    cookieExpireSeconds: cfg.cookieExpireSeconds,
    callbackUrl: buildCallbackUrl(hostname),
    lastError: cfg.lastError ?? null,
    lastReconciledAt: cfg.lastReconciledAt ? cfg.lastReconciledAt.toISOString() : null,
  };
}

export async function getAuthConfig(
  db: Database,
  ingressRouteId: string,
): Promise<IngressAuthConfigResponse | null> {
  const rows = await db
    .select({ cfg: ingressAuthConfigs, provider: clientOidcProviders, hostname: ingressRoutes.hostname })
    .from(ingressAuthConfigs)
    .innerJoin(clientOidcProviders, eq(clientOidcProviders.id, ingressAuthConfigs.providerId))
    .innerJoin(ingressRoutes, eq(ingressRoutes.id, ingressAuthConfigs.ingressRouteId))
    .where(eq(ingressAuthConfigs.ingressRouteId, ingressRouteId));
  const row = rows[0];
  if (!row) return null;
  return buildResponse(row.cfg, row.provider, row.hostname);
}

/**
 * Resolve the provider to use for an upsert. Three paths:
 *   1. input.providerId set → use it (verify ownership)
 *   2. existing config → keep its provider; optionally rotate its
 *      secret/issuer/etc. via the inline fields
 *   3. new config + inline fields → auto-create a provider
 */
async function resolveOrCreateProvider(
  db: Database,
  ctx: IngressAuthServiceContext,
  clientId: string,
  hostname: string,
  existing: IngressAuthConfig | undefined,
  input: IngressAuthConfigInput,
): Promise<string> {
  // Path 1: explicit providerId
  if (input.providerId) {
    const [p] = await db
      .select()
      .from(clientOidcProviders)
      .where(and(eq(clientOidcProviders.id, input.providerId), eq(clientOidcProviders.clientId, clientId)));
    if (!p) {
      throw new ApiError('NOT_FOUND', `Provider ${input.providerId} not found for this client`, 404);
    }
    return p.id;
  }
  // Path 2: keep existing provider; optionally update inline fields on it
  if (existing) {
    const updates: Partial<typeof clientOidcProviders.$inferInsert> = {};
    if (input.issuerUrl !== undefined) updates.issuerUrl = input.issuerUrl;
    if (input.clientId !== undefined) updates.oauthClientId = input.clientId;
    if (input.clientSecret) updates.oauthClientSecretEncrypted = encrypt(input.clientSecret, ctx.encryptionKey);
    if (input.authMethod !== undefined) updates.authMethod = input.authMethod;
    if (input.responseType !== undefined) updates.responseType = input.responseType;
    if (input.usePkce !== undefined) updates.usePkce = input.usePkce;
    if (Object.keys(updates).length > 0) {
      await db
        .update(clientOidcProviders)
        .set(updates)
        .where(eq(clientOidcProviders.id, existing.providerId));
    }
    return existing.providerId;
  }
  // Path 3: auto-create from inline fields
  if (!input.issuerUrl || !input.clientId || !input.clientSecret) {
    throw new ApiError(
      'VALIDATION_ERROR',
      'When creating an ingress auth config without providerId, issuerUrl + clientId + clientSecret are required.',
      400,
    );
  }
  const provider: ProviderInput = {
    name: `Auto-created for ${hostname}`,
    issuerUrl: input.issuerUrl,
    oauthClientId: input.clientId,
    oauthClientSecret: input.clientSecret,
    authMethod: input.authMethod,
    responseType: input.responseType,
    usePkce: input.usePkce,
    defaultScopes: input.scopes,
  };
  const created = await createProvider(db, ctx, clientId, provider);
  return created.id;
}

export async function upsertAuthConfig(
  db: Database,
  ctx: IngressAuthServiceContext,
  ingressRouteId: string,
  input: IngressAuthConfigInput,
): Promise<IngressAuthConfigResponse> {
  // Resolve hostname + clientId for callback URL + provider scoping.
  const routeRows = await db
    .select({ hostname: ingressRoutes.hostname, clientId: domains.clientId })
    .from(ingressRoutes)
    .innerJoin(domains, eq(domains.id, ingressRoutes.domainId))
    .where(eq(ingressRoutes.id, ingressRouteId));
  const route = routeRows[0];
  if (!route) {
    throw new ApiError('NOT_FOUND', `Ingress route ${ingressRouteId} not found`, 404);
  }

  const [existing] = await db
    .select()
    .from(ingressAuthConfigs)
    .where(eq(ingressAuthConfigs.ingressRouteId, ingressRouteId));

  const providerId = await resolveOrCreateProvider(db, ctx, route.clientId, route.hostname, existing, input);

  const claimRules = input.claimRules ?? null;
  // scopesOverride is set ONLY when the operator explicitly passed
  // input.scopes AND it differs from the provider's default. Reading
  // the provider would require an extra query; keep it simple — write
  // whatever the operator sent.
  const scopesOverride = input.scopes ?? null;

  if (existing) {
    await db
      .update(ingressAuthConfigs)
      .set({
        enabled: input.enabled,
        providerId,
        scopesOverride,
        postLoginRedirectUrl: input.postLoginRedirectUrl ?? null,
        allowedEmails: input.allowedEmails ?? null,
        allowedEmailDomains: input.allowedEmailDomains ?? null,
        allowedGroups: input.allowedGroups ?? null,
        claimRules,
        passAuthorizationHeader: input.passAuthorizationHeader,
        passAccessToken: input.passAccessToken,
        passIdToken: input.passIdToken,
        passUserHeaders: input.passUserHeaders,
        setXauthrequest: input.setXauthrequest,
        cookieDomain: input.cookieDomain ?? null,
        cookieRefreshSeconds: input.cookieRefreshSeconds,
        cookieExpireSeconds: input.cookieExpireSeconds,
        lastError: null,
      })
      .where(eq(ingressAuthConfigs.ingressRouteId, ingressRouteId));
  } else {
    await db.insert(ingressAuthConfigs).values({
      id: crypto.randomUUID(),
      ingressRouteId,
      enabled: input.enabled,
      providerId,
      scopesOverride,
      postLoginRedirectUrl: input.postLoginRedirectUrl ?? null,
      allowedEmails: input.allowedEmails ?? null,
      allowedEmailDomains: input.allowedEmailDomains ?? null,
      allowedGroups: input.allowedGroups ?? null,
      claimRules,
      passAuthorizationHeader: input.passAuthorizationHeader,
      passAccessToken: input.passAccessToken,
      passIdToken: input.passIdToken,
      passUserHeaders: input.passUserHeaders,
      setXauthrequest: input.setXauthrequest,
      cookieDomain: input.cookieDomain ?? null,
      cookieRefreshSeconds: input.cookieRefreshSeconds,
      cookieExpireSeconds: input.cookieExpireSeconds,
    });
  }

  const updated = await getAuthConfig(db, ingressRouteId);
  if (!updated) {
    throw new ApiError('INTERNAL', 'Auth config disappeared after write', 500);
  }
  return updated;
}

export async function deleteAuthConfig(
  db: Database,
  ingressRouteId: string,
): Promise<void> {
  await db
    .delete(ingressAuthConfigs)
    .where(eq(ingressAuthConfigs.ingressRouteId, ingressRouteId));
}

/**
 * Per-client-namespace cookie-secret used by oauth2-proxy. Generates
 * + encrypts on first call. Returns plaintext for reconciler use.
 */
export async function getOrCreateClientCookieSecret(
  db: Database,
  encryptionKey: string,
  clientId: string,
): Promise<string> {
  const [existing] = await db
    .select()
    .from(clientOauth2ProxyState)
    .where(eq(clientOauth2ProxyState.clientId, clientId));
  if (existing) {
    return decrypt(existing.cookieSecretEncrypted, encryptionKey);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const cookieSecret = Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  await db
    .insert(clientOauth2ProxyState)
    .values({
      clientId,
      cookieSecretEncrypted: encrypt(cookieSecret, encryptionKey),
      provisioned: false,
    })
    .onConflictDoNothing();
  return cookieSecret;
}

/**
 * Reconciler-facing: list all enabled configs for a client, with the
 * resolved provider already joined. Matches the per-client iteration
 * the reconciler does to render oauth2_proxy.cfg.
 */
export interface EnabledIngressAuthRow {
  readonly cfg: IngressAuthConfig;
  readonly provider: ClientOidcProvider;
  readonly hostname: string;
}

export async function listEnabledForClient(
  db: Database,
  clientId: string,
): Promise<ReadonlyArray<EnabledIngressAuthRow>> {
  const rows = await db
    .select({
      cfg: ingressAuthConfigs,
      provider: clientOidcProviders,
      hostname: ingressRoutes.hostname,
    })
    .from(ingressAuthConfigs)
    .innerJoin(clientOidcProviders, eq(clientOidcProviders.id, ingressAuthConfigs.providerId))
    .innerJoin(ingressRoutes, eq(ingressRoutes.id, ingressAuthConfigs.ingressRouteId))
    .innerJoin(domains, eq(domains.id, ingressRoutes.domainId))
    .where(and(eq(ingressAuthConfigs.enabled, true), eq(domains.clientId, clientId)));
  return rows.map((r) => ({ cfg: r.cfg, provider: r.provider, hostname: r.hostname }));
}
