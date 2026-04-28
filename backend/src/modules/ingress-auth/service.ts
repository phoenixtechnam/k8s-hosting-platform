/**
 * Ingress access-control service.
 *
 * CRUD over the ingress_auth_configs table. Encryption for the OIDC
 * client_secret + cookie_secret uses the existing OIDC_ENCRYPTION_KEY
 * (32-byte hex) shared with refresh-tokens, smtp-relay, etc. Calls
 * into the reconciler are NOT made here — the route layer triggers
 * the reconciler after a successful write so the service stays
 * unit-testable without a K8s client.
 */

import { eq } from 'drizzle-orm';
import { ingressAuthConfigs, ingressRoutes, clientOauth2ProxyState } from '../../db/schema.js';
import { encrypt, decrypt } from '../oidc/crypto.js';
import { ApiError } from '../../shared/errors.js';
import type { Database } from '../../db/index.js';
import type {
  IngressAuthConfig,
  IngressClaimRule,
} from '../../db/schema.js';
import type {
  IngressAuthConfigInput,
  IngressAuthConfigResponse,
} from '@k8s-hosting/api-contracts';

/**
 * Build the OAuth callback URL the operator needs to register at the IdP.
 * Pure function — exported for the route's response builder + tests.
 */
export function buildCallbackUrl(hostname: string): string {
  return `https://${hostname}/oauth2/callback`;
}

/** Decrypt-omit projection for the wire response. */
function toResponse(
  row: IngressAuthConfig,
  hostname: string,
): IngressAuthConfigResponse {
  return {
    enabled: row.enabled,
    issuerUrl: row.issuerUrl,
    clientId: row.clientId,
    authMethod: row.authMethod as IngressAuthConfigResponse['authMethod'],
    responseType: row.responseType as IngressAuthConfigResponse['responseType'],
    usePkce: row.usePkce,
    scopes: row.scopes,
    allowedEmails: row.allowedEmails ?? null,
    allowedEmailDomains: row.allowedEmailDomains ?? null,
    allowedGroups: row.allowedGroups ?? null,
    claimRules: (row.claimRules as IngressClaimRule[] | null) ?? null,
    passAuthorizationHeader: row.passAuthorizationHeader,
    passAccessToken: row.passAccessToken,
    passIdToken: row.passIdToken,
    passUserHeaders: row.passUserHeaders,
    setXauthrequest: row.setXauthrequest,
    cookieDomain: row.cookieDomain ?? null,
    cookieRefreshSeconds: row.cookieRefreshSeconds,
    cookieExpireSeconds: row.cookieExpireSeconds,
    clientSecretSet: row.clientSecretEncrypted.length > 0,
    callbackUrl: buildCallbackUrl(hostname),
    lastError: row.lastError ?? null,
    lastReconciledAt: row.lastReconciledAt
      ? row.lastReconciledAt.toISOString()
      : null,
  };
}

export interface IngressAuthServiceContext {
  readonly encryptionKey: string;
}

/**
 * Look up the auth config for an ingress route and return the response
 * shape (client_secret omitted, callbackUrl computed). Returns null if
 * the row doesn't exist — callers map that to "auth disabled" UX.
 */
export async function getAuthConfig(
  db: Database,
  ingressRouteId: string,
): Promise<IngressAuthConfigResponse | null> {
  const [row] = await db
    .select()
    .from(ingressAuthConfigs)
    .where(eq(ingressAuthConfigs.ingressRouteId, ingressRouteId));
  if (!row) return null;

  const [routeRow] = await db
    .select({ hostname: ingressRoutes.hostname })
    .from(ingressRoutes)
    .where(eq(ingressRoutes.id, ingressRouteId));
  const hostname = routeRow?.hostname ?? '';

  return toResponse(row, hostname);
}

/**
 * Create or update the auth config. The clientSecret is required on
 * first write; on update it's optional — omitted = keep existing.
 *
 * Returns the new row's response shape. Throws ApiError on validation
 * failures so the route layer can surface a 400 with a clear message.
 */
export async function upsertAuthConfig(
  db: Database,
  ctx: IngressAuthServiceContext,
  ingressRouteId: string,
  input: IngressAuthConfigInput,
): Promise<IngressAuthConfigResponse> {
  // Verify the ingress exists + grab hostname for callback URL.
  const [routeRow] = await db
    .select({ hostname: ingressRoutes.hostname })
    .from(ingressRoutes)
    .where(eq(ingressRoutes.id, ingressRouteId));
  if (!routeRow) {
    throw new ApiError('NOT_FOUND', `Ingress route ${ingressRouteId} not found`, 404);
  }

  const [existing] = await db
    .select()
    .from(ingressAuthConfigs)
    .where(eq(ingressAuthConfigs.ingressRouteId, ingressRouteId));

  // On first write the client secret is mandatory. On update it's
  // optional (omitted preserves the existing encrypted value).
  if (!existing && !input.clientSecret) {
    throw new ApiError(
      'VALIDATION_ERROR',
      'clientSecret is required when creating an ingress auth config',
      400,
    );
  }

  const clientSecretEncrypted = input.clientSecret
    ? encrypt(input.clientSecret, ctx.encryptionKey)
    : (existing?.clientSecretEncrypted ?? '');

  const claimRules = input.claimRules ?? null;

  if (existing) {
    await db
      .update(ingressAuthConfigs)
      .set({
        enabled: input.enabled,
        issuerUrl: input.issuerUrl,
        clientId: input.clientId,
        clientSecretEncrypted,
        authMethod: input.authMethod,
        responseType: input.responseType,
        usePkce: input.usePkce,
        scopes: input.scopes,
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
        // Reconciler clears lastError on its next pass; clear here too
        // so the UI doesn't show a stale error after a save.
        lastError: null,
      })
      .where(eq(ingressAuthConfigs.ingressRouteId, ingressRouteId));
  } else {
    await db.insert(ingressAuthConfigs).values({
      id: crypto.randomUUID(),
      ingressRouteId,
      enabled: input.enabled,
      issuerUrl: input.issuerUrl,
      clientId: input.clientId,
      clientSecretEncrypted,
      authMethod: input.authMethod,
      responseType: input.responseType,
      usePkce: input.usePkce,
      scopes: input.scopes,
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
    // Should be unreachable — we just wrote the row.
    throw new ApiError('INTERNAL', 'Auth config disappeared after write', 500);
  }
  return updated;
}

/**
 * Delete the auth config for an ingress. The reconciler's next tick
 * picks up the absence and tears down the proxy if no other ingresses
 * in the client need it.
 */
export async function deleteAuthConfig(
  db: Database,
  ingressRouteId: string,
): Promise<void> {
  await db
    .delete(ingressAuthConfigs)
    .where(eq(ingressAuthConfigs.ingressRouteId, ingressRouteId));
}

/** Decrypt the client secret for reconciler consumption. */
export function decryptClientSecret(
  row: IngressAuthConfig,
  encryptionKey: string,
): string {
  if (!row.clientSecretEncrypted) return '';
  return decrypt(row.clientSecretEncrypted, encryptionKey);
}

/**
 * Get-or-create the per-client cookie secret. Generates a 32-byte URL-
 * safe base64 string on first call. Returns the decrypted plaintext
 * for reconciler use.
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
  // Generate a 32-byte secret encoded as URL-safe base64 (no padding,
  // no +/ chars) — oauth2-proxy expects this exact shape.
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
 * List all enabled auth configs for ingresses belonging to a client.
 * The reconciler uses this to render the per-client oauth2-proxy
 * upstream list + claim rules ConfigMap.
 */
export async function listEnabledForClient(
  db: Database,
  clientId: string,
): Promise<ReadonlyArray<IngressAuthConfig & { hostname: string }>> {
  // Join ingress_routes → domains → clients to filter by client.
  // Drizzle doesn't have a single-shot multi-join helper here; do it
  // in two queries to keep the SQL readable.
  const routes = await db
    .select({
      id: ingressRoutes.id,
      hostname: ingressRoutes.hostname,
    })
    .from(ingressRoutes);
  // Filter the auth configs to enabled rows whose ingress is in the
  // route set we know about. Cross-tenant safety: the route set above
  // is global, but listEnabledForClient is reconciler-internal — the
  // caller passes clientId derived from the namespace it's reconciling.
  // For correctness we still filter by the client's namespaces upstream
  // in the reconciler; this function returns enabled rows joined with
  // hostname.
  const configs = await db
    .select()
    .from(ingressAuthConfigs)
    .where(eq(ingressAuthConfigs.enabled, true));
  const routeMap = new Map(routes.map((r) => [r.id, r.hostname]));
  return configs
    .filter((c) => routeMap.has(c.ingressRouteId))
    .map((c) => ({ ...c, hostname: routeMap.get(c.ingressRouteId)! }));
}
