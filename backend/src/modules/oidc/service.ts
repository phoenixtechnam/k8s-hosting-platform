import { eq, and, asc } from 'drizzle-orm';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { oidcProviders, oidcGlobalSettings, users, clients } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { encrypt, decrypt } from './crypto.js';
import type { Database } from '../../db/index.js';

// ─── OIDC Discovery ──────────────────────────────────────────────────────────

interface OidcDiscovery {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly userinfo_endpoint?: string;
  readonly jwks_uri: string;
  readonly end_session_endpoint?: string;
  readonly backchannel_logout_supported?: boolean;
}

interface Jwks { readonly keys: readonly Record<string, unknown>[]; }

export async function fetchDiscovery(issuerUrl: string): Promise<OidcDiscovery> {
  const url = `${issuerUrl.replace(/\/$/, '')}/.well-known/openid-configuration`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    throw new ApiError('OIDC_DISCOVERY_FAILED', `Failed to fetch OIDC discovery: ${res.status} ${res.statusText}`, 502);
  }
  return res.json() as Promise<OidcDiscovery>;
}

async function fetchJwks(jwksUri: string): Promise<Jwks> {
  const res = await fetch(jwksUri, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new ApiError('OIDC_JWKS_FAILED', `Failed to fetch JWKS: ${res.status}`, 502);
  return res.json() as Promise<Jwks>;
}

// ─── Global Settings ─────────────────────────────────────────────────────────

export async function getGlobalSettings(db: Database) {
  const rows = await db.select().from(oidcGlobalSettings);
  if (rows.length === 0) return { disableLocalAuthAdmin: false, disableLocalAuthClient: false, hasBreakGlassSecret: false };
  const row = rows[0];
  return {
    disableLocalAuthAdmin: Boolean(row.disableLocalAuthAdmin),
    disableLocalAuthClient: Boolean(row.disableLocalAuthClient),
    hasBreakGlassSecret: Boolean(row.breakGlassSecretHash),
  };
}

export interface SaveGlobalSettingsInput {
  readonly disable_local_auth_admin?: boolean;
  readonly disable_local_auth_client?: boolean;
  readonly break_glass_secret?: string;
}

export async function saveGlobalSettings(db: Database, input: SaveGlobalSettingsInput) {
  const rows = await db.select().from(oidcGlobalSettings);

  const updateValues: Record<string, unknown> = {};
  if (input.disable_local_auth_admin !== undefined) updateValues.disableLocalAuthAdmin = input.disable_local_auth_admin ? 1 : 0;
  if (input.disable_local_auth_client !== undefined) updateValues.disableLocalAuthClient = input.disable_local_auth_client ? 1 : 0;
  if (input.break_glass_secret) updateValues.breakGlassSecretHash = await bcrypt.hash(input.break_glass_secret, 12);

  // Validate: can't disable admin local auth without a break-glass secret
  if (input.disable_local_auth_admin) {
    const hasSecret = input.break_glass_secret || rows[0]?.breakGlassSecretHash;
    if (!hasSecret) {
      throw new ApiError('BREAK_GLASS_REQUIRED', 'You must set a break-glass secret before disabling admin local authentication', 400);
    }
    // Verify at least one admin-scoped provider is enabled
    const adminProviders = await db.select().from(oidcProviders).where(and(eq(oidcProviders.panelScope, 'admin'), eq(oidcProviders.enabled, 1)));
    if (adminProviders.length === 0) {
      throw new ApiError('NO_ADMIN_PROVIDER', 'At least one enabled admin OIDC provider is required before disabling local auth', 400);
    }
  }

  if (rows.length > 0) {
    await db.update(oidcGlobalSettings).set(updateValues).where(eq(oidcGlobalSettings.id, rows[0].id));
  } else {
    await db.insert(oidcGlobalSettings).values({ id: crypto.randomUUID(), ...updateValues } as typeof oidcGlobalSettings.$inferInsert);
  }

  return getGlobalSettings(db);
}

// ─── Provider CRUD ───────────────────────────────────────────────────────────

export async function listProviders(db: Database) {
  const providers = await db.select().from(oidcProviders).orderBy(asc(oidcProviders.displayOrder));
  return providers.map((p) => ({
    id: p.id,
    displayName: p.displayName,
    issuerUrl: p.issuerUrl,
    clientId: p.clientId,
    panelScope: p.panelScope,
    enabled: Boolean(p.enabled),
    backchannelLogoutEnabled: Boolean(p.backchannelLogoutEnabled),
    displayOrder: p.displayOrder,
    discoveryMetadata: p.discoveryMetadata,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }));
}

export async function getProviderById(db: Database, id: string) {
  const [provider] = await db.select().from(oidcProviders).where(eq(oidcProviders.id, id));
  if (!provider) throw new ApiError('OIDC_PROVIDER_NOT_FOUND', `OIDC provider '${id}' not found`, 404);
  return provider;
}

export interface SaveProviderInput {
  readonly display_name: string;
  readonly issuer_url: string;
  readonly client_id: string;
  readonly client_secret: string;
  readonly panel_scope: 'admin' | 'client';
  readonly enabled?: boolean;
  readonly backchannel_logout_enabled?: boolean;
  readonly display_order?: number;
}

export async function createProvider(db: Database, input: SaveProviderInput, encryptionKey: string) {
  const discovery = await fetchDiscovery(input.issuer_url);
  const encryptedSecret = encrypt(input.client_secret, encryptionKey);
  const id = crypto.randomUUID();

  await db.insert(oidcProviders).values({
    id,
    displayName: input.display_name,
    issuerUrl: input.issuer_url,
    clientId: input.client_id,
    clientSecretEncrypted: encryptedSecret,
    panelScope: input.panel_scope,
    enabled: input.enabled ? 1 : 0,
    backchannelLogoutEnabled: input.backchannel_logout_enabled ? 1 : 0,
    discoveryMetadata: discovery as unknown as Record<string, unknown>,
    displayOrder: input.display_order ?? 0,
  });

  return getProviderById(db, id);
}

export async function updateProvider(db: Database, id: string, input: Partial<SaveProviderInput>, encryptionKey: string) {
  await getProviderById(db, id);

  const updateValues: Record<string, unknown> = {};
  if (input.display_name !== undefined) updateValues.displayName = input.display_name;
  if (input.issuer_url !== undefined) updateValues.issuerUrl = input.issuer_url;
  if (input.client_id !== undefined) updateValues.clientId = input.client_id;
  if (input.client_secret) updateValues.clientSecretEncrypted = encrypt(input.client_secret, encryptionKey);
  if (input.panel_scope !== undefined) updateValues.panelScope = input.panel_scope;
  if (input.enabled !== undefined) updateValues.enabled = input.enabled ? 1 : 0;
  if (input.backchannel_logout_enabled !== undefined) updateValues.backchannelLogoutEnabled = input.backchannel_logout_enabled ? 1 : 0;
  if (input.display_order !== undefined) updateValues.displayOrder = input.display_order;

  // Re-fetch discovery if issuer URL changed
  if (input.issuer_url) {
    const discovery = await fetchDiscovery(input.issuer_url);
    updateValues.discoveryMetadata = discovery as unknown as Record<string, unknown>;
  }

  if (Object.keys(updateValues).length > 0) {
    await db.update(oidcProviders).set(updateValues).where(eq(oidcProviders.id, id));
  }

  return getProviderById(db, id);
}

export async function deleteProvider(db: Database, id: string) {
  await getProviderById(db, id);
  await db.delete(oidcProviders).where(eq(oidcProviders.id, id));
}

export async function testProviderConnection(db: Database, id: string) {
  const provider = await getProviderById(db, id);
  const discovery = await fetchDiscovery(provider.issuerUrl);
  const jwks = await fetchJwks(discovery.jwks_uri);
  return {
    issuer: discovery.issuer,
    authorization_endpoint: discovery.authorization_endpoint,
    token_endpoint: discovery.token_endpoint,
    jwks_uri: discovery.jwks_uri,
    backchannel_logout_supported: discovery.backchannel_logout_supported ?? false,
    keys_count: jwks.keys.length,
    status: 'connected',
  };
}

// ─── PKCE ────────────────────────────────────────────────────────────────────

export function generatePkce(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

// ─── Authorization URL ───────────────────────────────────────────────────────

export async function buildAuthorizationUrl(
  db: Database,
  providerId: string,
  callbackUrl: string,
  state: string,
  codeChallenge: string,
): Promise<string> {
  const provider = await getProviderById(db, providerId);
  if (!provider.enabled) throw new ApiError('OIDC_NOT_ENABLED', 'This OIDC provider is not enabled', 400);

  let discovery = provider.discoveryMetadata as OidcDiscovery | null;
  if (!discovery?.authorization_endpoint) {
    discovery = await fetchDiscovery(provider.issuerUrl);
  }

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: provider.clientId,
    redirect_uri: callbackUrl,
    scope: 'openid email profile',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  return `${discovery.authorization_endpoint}?${params.toString()}`;
}

// ─── Token Exchange ──────────────────────────────────────────────────────────

interface TokenResponse {
  readonly access_token: string;
  readonly id_token: string;
  readonly token_type: string;
}

interface IdTokenClaims {
  readonly sub: string;
  readonly email?: string;
  readonly email_verified?: boolean;
  readonly name?: string;
  readonly preferred_username?: string;
  readonly iss: string;
  readonly aud: string | string[];
  readonly exp: number;
  readonly iat: number;
  readonly sid?: string;
}

export async function exchangeCodeForTokens(
  db: Database,
  providerId: string,
  code: string,
  callbackUrl: string,
  codeVerifier: string,
  encryptionKey: string,
): Promise<{ idToken: IdTokenClaims; rawIdToken: string; provider: typeof oidcProviders.$inferSelect }> {
  const provider = await getProviderById(db, providerId);
  const clientSecret = decrypt(provider.clientSecretEncrypted, encryptionKey);

  let discovery = provider.discoveryMetadata as OidcDiscovery | null;
  if (!discovery?.token_endpoint) {
    discovery = await fetchDiscovery(provider.issuerUrl);
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: callbackUrl,
    client_id: provider.clientId,
    client_secret: clientSecret,
    code_verifier: codeVerifier,
  });

  const res = await fetch(discovery.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => 'unknown');
    throw new ApiError('OIDC_TOKEN_EXCHANGE_FAILED', `Token exchange failed: ${res.status} — ${errBody}`, 502);
  }

  const tokens = await res.json() as TokenResponse;
  const idTokenParts = tokens.id_token.split('.');
  if (idTokenParts.length !== 3) throw new ApiError('OIDC_INVALID_TOKEN', 'Invalid ID token format', 502);

  const claims = JSON.parse(Buffer.from(idTokenParts[1], 'base64url').toString()) as IdTokenClaims;
  return { idToken: claims, rawIdToken: tokens.id_token, provider };
}

// ─── User Auto-Creation / Matching ───────────────────────────────────────────

export async function findOrCreateOidcUser(
  db: Database,
  claims: IdTokenClaims,
  panelScope: 'admin' | 'client',
): Promise<typeof users.$inferSelect> {
  // Match by OIDC subject + issuer
  const [existingByOidc] = await db.select().from(users)
    .where(and(eq(users.oidcIssuer, claims.iss), eq(users.oidcSubject, claims.sub)));

  if (existingByOidc) {
    await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, existingByOidc.id));
    return existingByOidc;
  }

  // Match by email
  const email = claims.email;
  if (email) {
    const [existingByEmail] = await db.select().from(users).where(eq(users.email, email));
    if (existingByEmail) {
      await db.update(users).set({
        oidcIssuer: claims.iss,
        oidcSubject: claims.sub,
        emailVerifiedAt: claims.email_verified ? new Date() : existingByEmail.emailVerifiedAt,
        lastLoginAt: new Date(),
      }).where(eq(users.id, existingByEmail.id));
      const [updated] = await db.select().from(users).where(eq(users.id, existingByEmail.id));
      return updated;
    }
  }

  // For client-scoped providers: match email to client account
  if (panelScope === 'client' && email) {
    const [matchingClient] = await db.select().from(clients)
      .where(eq(clients.companyEmail, email));

    if (matchingClient) {
      const id = crypto.randomUUID();
      await db.insert(users).values({
        id,
        email,
        fullName: claims.name ?? claims.preferred_username ?? 'Client User',
        passwordHash: null,
        roleName: 'client_admin',
        panel: 'client',
        clientId: matchingClient.id,
        status: 'active',
        oidcIssuer: claims.iss,
        oidcSubject: claims.sub,
        emailVerifiedAt: claims.email_verified ? new Date() : null,
        lastLoginAt: new Date(),
      });
      const [created] = await db.select().from(users).where(eq(users.id, id));
      return created;
    }

    // No client match — reject for now (self-service onboarding is Phase 2)
    throw new ApiError('NO_CLIENT_ACCOUNT', 'No hosting account found for your email. Contact your administrator.', 403);
  }

  // Admin-scoped: auto-create as read_only admin
  const id = crypto.randomUUID();
  await db.insert(users).values({
    id,
    email: email ?? `${claims.sub}@oidc`,
    fullName: claims.name ?? claims.preferred_username ?? 'OIDC User',
    passwordHash: null,
    roleName: 'read_only',
    panel: 'admin',
    status: 'active',
    oidcIssuer: claims.iss,
    oidcSubject: claims.sub,
    emailVerifiedAt: claims.email_verified ? new Date() : null,
    lastLoginAt: new Date(),
  });
  const [created] = await db.select().from(users).where(eq(users.id, id));
  return created;
}

// ─── Backchannel Logout ──────────────────────────────────────────────────────

interface LogoutTokenClaims {
  readonly sub?: string;
  readonly sid?: string;
  readonly iss: string;
  readonly events: Record<string, Record<string, never>>;
}

export function parseLogoutToken(logoutToken: string): LogoutTokenClaims {
  const parts = logoutToken.split('.');
  if (parts.length !== 3) throw new ApiError('INVALID_LOGOUT_TOKEN', 'Invalid logout token format', 400);
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as LogoutTokenClaims;
  if (!claims.events?.['http://schemas.openid.net/event/backchannel-logout']) {
    throw new ApiError('INVALID_LOGOUT_TOKEN', 'Not a backchannel logout token', 400);
  }
  if (!claims.sub && !claims.sid) throw new ApiError('INVALID_LOGOUT_TOKEN', 'Logout token must contain sub or sid', 400);
  return claims;
}

export async function handleBackchannelLogout(db: Database, logoutToken: string): Promise<{ loggedOutUsers: number }> {
  const claims = parseLogoutToken(logoutToken);
  if (!claims.sub) return { loggedOutUsers: 0 };

  const matchingUsers = await db.select().from(users)
    .where(and(eq(users.oidcIssuer, claims.iss), eq(users.oidcSubject, claims.sub)));

  for (const user of matchingUsers) {
    await db.update(users).set({ lastLoginAt: null }).where(eq(users.id, user.id));
  }
  return { loggedOutUsers: matchingUsers.length };
}

// ─── Auth Status Checks ──────────────────────────────────────────────────────

export async function isLocalAuthDisabled(db: Database, panel: 'admin' | 'client' = 'admin'): Promise<boolean> {
  const settings = await getGlobalSettings(db);
  return panel === 'admin' ? settings.disableLocalAuthAdmin : settings.disableLocalAuthClient;
}

export async function getAuthStatus(db: Database, panel: 'admin' | 'client') {
  const globalSettings = await getGlobalSettings(db);
  const providers = await db.select().from(oidcProviders)
    .where(and(eq(oidcProviders.panelScope, panel), eq(oidcProviders.enabled, 1)))
    .orderBy(asc(oidcProviders.displayOrder));

  const localAuthDisabled = panel === 'admin' ? globalSettings.disableLocalAuthAdmin : globalSettings.disableLocalAuthClient;

  return {
    localAuthEnabled: !localAuthDisabled,
    providers: providers.map((p) => ({
      id: p.id,
      displayName: p.displayName,
      issuerUrl: p.issuerUrl,
    })),
  };
}

// ─── Break-Glass Login ───────────────────────────────────────────────────────

export async function breakGlassLogin(db: Database, email: string, password: string, secret: string) {
  // Verify break-glass secret
  const rows = await db.select().from(oidcGlobalSettings);
  if (rows.length === 0 || !rows[0].breakGlassSecretHash) {
    throw new ApiError('BREAK_GLASS_NOT_CONFIGURED', 'Break-glass emergency login is not configured', 403);
  }

  const secretValid = await bcrypt.compare(secret, rows[0].breakGlassSecretHash);
  if (!secretValid) {
    throw new ApiError('INVALID_BREAK_GLASS', 'Invalid break-glass secret', 403);
  }

  // Now verify email+password as normal
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user || !user.passwordHash || user.panel !== 'admin') {
    throw new ApiError('INVALID_TOKEN', 'Invalid credentials', 401);
  }

  const passwordValid = await bcrypt.compare(password, user.passwordHash);
  if (!passwordValid) {
    throw new ApiError('INVALID_TOKEN', 'Invalid credentials', 401);
  }

  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));

  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.roleName,
    panel: user.panel,
    clientId: user.clientId,
  };
}
