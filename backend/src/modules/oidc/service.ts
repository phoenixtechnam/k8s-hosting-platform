import { eq, and } from 'drizzle-orm';
import crypto from 'crypto';
import { oidcSettings, users } from '../../db/schema.js';
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
  readonly backchannel_logout_session_supported?: boolean;
}

interface JwksKey {
  readonly kty: string;
  readonly kid: string;
  readonly use?: string;
  readonly n?: string;
  readonly e?: string;
  readonly crv?: string;
  readonly x?: string;
  readonly y?: string;
}

interface Jwks {
  readonly keys: readonly JwksKey[];
}

export async function fetchDiscovery(issuerUrl: string): Promise<OidcDiscovery> {
  const url = `${issuerUrl.replace(/\/$/, '')}/.well-known/openid-configuration`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });

  if (!res.ok) {
    throw new ApiError('OIDC_DISCOVERY_FAILED', `Failed to fetch OIDC discovery: ${res.status} ${res.statusText}`, 502);
  }

  return res.json() as Promise<OidcDiscovery>;
}

export async function fetchJwks(jwksUri: string): Promise<Jwks> {
  const res = await fetch(jwksUri, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    throw new ApiError('OIDC_JWKS_FAILED', `Failed to fetch JWKS: ${res.status}`, 502);
  }
  return res.json() as Promise<Jwks>;
}

// ─── Settings CRUD ───────────────────────────────────────────────────────────

export async function getOidcSettings(db: Database) {
  const rows = await db.select().from(oidcSettings);
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    id: row.id,
    issuerUrl: row.issuerUrl,
    clientId: row.clientId,
    enabled: Boolean(row.enabled),
    disableLocalAuth: Boolean(row.disableLocalAuth),
    backchannelLogoutEnabled: Boolean(row.backchannelLogoutEnabled),
    discoveryMetadata: row.discoveryMetadata,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

interface SaveOidcSettingsInput {
  readonly issuer_url: string;
  readonly client_id: string;
  readonly client_secret: string;
  readonly enabled?: boolean;
  readonly disable_local_auth?: boolean;
  readonly backchannel_logout_enabled?: boolean;
}

export async function saveOidcSettings(db: Database, input: SaveOidcSettingsInput, encryptionKey: string) {
  // Validate discovery endpoint before saving
  const discovery = await fetchDiscovery(input.issuer_url);

  const encryptedSecret = encrypt(input.client_secret, encryptionKey);

  const rows = await db.select().from(oidcSettings);
  if (rows.length > 0) {
    await db.update(oidcSettings).set({
      issuerUrl: input.issuer_url,
      clientId: input.client_id,
      clientSecretEncrypted: encryptedSecret,
      enabled: input.enabled ? 1 : 0,
      disableLocalAuth: input.disable_local_auth ? 1 : 0,
      backchannelLogoutEnabled: input.backchannel_logout_enabled ? 1 : 0,
      discoveryMetadata: discovery as unknown as Record<string, unknown>,
    }).where(eq(oidcSettings.id, rows[0].id));
  } else {
    const id = crypto.randomUUID();
    await db.insert(oidcSettings).values({
      id,
      issuerUrl: input.issuer_url,
      clientId: input.client_id,
      clientSecretEncrypted: encryptedSecret,
      enabled: input.enabled ? 1 : 0,
      disableLocalAuth: input.disable_local_auth ? 1 : 0,
      backchannelLogoutEnabled: input.backchannel_logout_enabled ? 1 : 0,
      discoveryMetadata: discovery as unknown as Record<string, unknown>,
    });
  }

  return getOidcSettings(db);
}

export async function testOidcConnection(db: Database) {
  const settings = await getOidcSettings(db);
  if (!settings) {
    throw new ApiError('OIDC_NOT_CONFIGURED', 'OIDC settings have not been configured', 400);
  }

  const discovery = await fetchDiscovery(settings.issuerUrl);
  const jwks = await fetchJwks(discovery.jwks_uri);

  return {
    issuer: discovery.issuer,
    authorization_endpoint: discovery.authorization_endpoint,
    token_endpoint: discovery.token_endpoint,
    jwks_uri: discovery.jwks_uri,
    end_session_endpoint: discovery.end_session_endpoint ?? null,
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
  callbackUrl: string,
  state: string,
  codeChallenge: string,
): Promise<string> {
  const settings = await getOidcSettings(db);
  if (!settings?.enabled) {
    throw new ApiError('OIDC_NOT_ENABLED', 'OIDC is not enabled', 400);
  }

  // Prefer cached metadata, fall back to live fetch
  let discovery = settings.discoveryMetadata as OidcDiscovery | null;
  if (!discovery?.authorization_endpoint) {
    try {
      discovery = await fetchDiscovery(settings.issuerUrl);
    } catch {
      throw new ApiError('OIDC_NO_DISCOVERY', 'OIDC discovery metadata not available. Check the issuer URL is reachable from the server.', 500);
    }
  }

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: settings.clientId,
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
  readonly expires_in?: number;
  readonly refresh_token?: string;
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
  readonly sid?: string; // session ID for backchannel logout
}

export async function exchangeCodeForTokens(
  db: Database,
  code: string,
  callbackUrl: string,
  codeVerifier: string,
  encryptionKey: string,
): Promise<{ idToken: IdTokenClaims; rawIdToken: string }> {
  const rows = await db.select().from(oidcSettings);
  if (rows.length === 0 || !rows[0].enabled) {
    throw new ApiError('OIDC_NOT_ENABLED', 'OIDC is not enabled', 400);
  }

  const row = rows[0];
  const clientSecret = decrypt(row.clientSecretEncrypted, encryptionKey);
  const discovery = row.discoveryMetadata as OidcDiscovery | null;

  if (!discovery?.token_endpoint) {
    throw new ApiError('OIDC_NO_DISCOVERY', 'Token endpoint not available', 500);
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: callbackUrl,
    client_id: row.clientId,
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

  // Decode ID token (validation will be done separately via JWKS)
  const idTokenParts = tokens.id_token.split('.');
  if (idTokenParts.length !== 3) {
    throw new ApiError('OIDC_INVALID_TOKEN', 'Invalid ID token format', 502);
  }

  const claims = JSON.parse(Buffer.from(idTokenParts[1], 'base64url').toString()) as IdTokenClaims;

  return { idToken: claims, rawIdToken: tokens.id_token };
}

// ─── User Auto-Creation / Matching ───────────────────────────────────────────

export async function findOrCreateOidcUser(
  db: Database,
  claims: IdTokenClaims,
): Promise<typeof users.$inferSelect> {
  // Try to match by OIDC subject + issuer
  const [existingByOidc] = await db
    .select()
    .from(users)
    .where(and(eq(users.oidcIssuer, claims.iss), eq(users.oidcSubject, claims.sub)));

  if (existingByOidc) {
    // Update last login
    await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, existingByOidc.id));
    return existingByOidc;
  }

  // Try to match by email (link existing account)
  const email = claims.email;
  if (email) {
    const [existingByEmail] = await db
      .select()
      .from(users)
      .where(eq(users.email, email));

    if (existingByEmail) {
      // Link OIDC identity to existing account
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

  // Auto-create new user
  const id = crypto.randomUUID();
  await db.insert(users).values({
    id,
    email: email ?? `${claims.sub}@oidc`,
    fullName: claims.name ?? claims.preferred_username ?? 'OIDC User',
    passwordHash: null,
    roleName: 'read-only', // New OIDC users get read-only by default
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
  if (parts.length !== 3) {
    throw new ApiError('INVALID_LOGOUT_TOKEN', 'Invalid logout token format', 400);
  }

  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as LogoutTokenClaims;

  // Verify it's a logout token (must have the backchannel-logout event)
  if (!claims.events?.['http://schemas.openid.net/event/backchannel-logout']) {
    throw new ApiError('INVALID_LOGOUT_TOKEN', 'Not a backchannel logout token', 400);
  }

  if (!claims.sub && !claims.sid) {
    throw new ApiError('INVALID_LOGOUT_TOKEN', 'Logout token must contain sub or sid', 400);
  }

  return claims;
}

export async function handleBackchannelLogout(
  db: Database,
  logoutToken: string,
): Promise<{ loggedOutUsers: number }> {
  const claims = parseLogoutToken(logoutToken);

  if (!claims.sub) {
    // sid-only logout not supported without session tracking
    return { loggedOutUsers: 0 };
  }

  // Find user by OIDC subject and mark as needing re-auth
  const matchingUsers = await db
    .select()
    .from(users)
    .where(and(eq(users.oidcIssuer, claims.iss), eq(users.oidcSubject, claims.sub)));

  // In a production system, we'd revoke all active tokens for these users via Redis.
  // For now, we update lastLoginAt to null to signal session invalidation.
  for (const user of matchingUsers) {
    await db.update(users).set({ lastLoginAt: null }).where(eq(users.id, user.id));
  }

  return { loggedOutUsers: matchingUsers.length };
}

// ─── Check if local auth is disabled ─────────────────────────────────────────

export async function isLocalAuthDisabled(db: Database): Promise<boolean> {
  const settings = await getOidcSettings(db);
  return Boolean(settings?.enabled && settings?.disableLocalAuth);
}
