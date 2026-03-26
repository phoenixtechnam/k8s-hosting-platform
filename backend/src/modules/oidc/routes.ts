import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import * as service from './service.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';

// In-memory PKCE state store (Phase 1). Replace with Redis in production.
const pkceStore = new Map<string, { codeVerifier: string; expiresAt: number }>();

// Clean expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of pkceStore) {
    if (val.expiresAt < now) pkceStore.delete(key);
  }
}, 300_000);

export async function oidcRoutes(app: FastifyInstance): Promise<void> {
  const encryptionKey = app.config?.OIDC_ENCRYPTION_KEY
    ?? process.env.OIDC_ENCRYPTION_KEY
    ?? '0'.repeat(64); // fallback for dev (32 bytes hex)

  // ─── Public: OIDC status (login page needs to know if SSO is enabled) ──────

  app.get('/auth/oidc/status', async () => {
    const settings = await service.getOidcSettings(app.db);
    return success({
      enabled: Boolean(settings?.enabled),
      disableLocalAuth: Boolean(settings?.enabled && settings?.disableLocalAuth),
    });
  });

  // ─── Public: Authorization redirect ────────────────────────────────────────

  app.get('/auth/oidc/authorize', async (request, reply) => {
    const query = request.query as { redirect_uri?: string };
    const frontendCallback = query.redirect_uri;
    if (!frontendCallback) {
      throw new ApiError('MISSING_REDIRECT_URI', 'redirect_uri query parameter is required', 400);
    }

    const state = crypto.randomUUID();
    const { codeVerifier, codeChallenge } = service.generatePkce();

    // Store PKCE verifier with 10 minute expiry
    pkceStore.set(state, { codeVerifier, expiresAt: Date.now() + 600_000 });

    // Build the backend callback URL using the full Host header (includes port)
    const host = request.headers.host ?? request.hostname;
    const backendCallback = `${request.protocol}://${host}/api/v1/auth/oidc/callback?frontend_redirect=${encodeURIComponent(frontendCallback)}&state=${state}`;

    const authUrl = await service.buildAuthorizationUrl(app.db, backendCallback, state, codeChallenge);

    return reply.redirect(authUrl);
  });

  // ─── Public: OIDC callback ─────────────────────────────────────────────────

  app.get('/auth/oidc/callback', async (request, reply) => {
    const query = request.query as {
      code?: string;
      state?: string;
      error?: string;
      error_description?: string;
      frontend_redirect?: string;
    };

    if (query.error) {
      const redirect = query.frontend_redirect ?? '/login';
      return reply.redirect(`${redirect}?error=${encodeURIComponent(query.error_description ?? query.error)}`);
    }

    if (!query.code || !query.state) {
      throw new ApiError('OIDC_CALLBACK_INVALID', 'Missing code or state parameter', 400);
    }

    // Retrieve PKCE verifier
    const pkce = pkceStore.get(query.state);
    if (!pkce) {
      throw new ApiError('OIDC_STATE_INVALID', 'Invalid or expired state parameter', 400);
    }
    pkceStore.delete(query.state);

    // Reconstruct the callback URL that was used for the authorization request
    const host = request.headers.host ?? request.hostname;
    const callbackUrl = `${request.protocol}://${host}/api/v1/auth/oidc/callback?frontend_redirect=${encodeURIComponent(query.frontend_redirect ?? '/login')}&state=${query.state}`;

    // Exchange code for tokens
    const { idToken } = await service.exchangeCodeForTokens(
      app.db,
      query.code,
      callbackUrl,
      pkce.codeVerifier,
      encryptionKey,
    );

    // Find or create user
    const user = await service.findOrCreateOidcUser(app.db, idToken);

    // Issue platform JWT
    const token = app.jwt.sign({
      sub: user.id,
      role: user.roleName as 'admin' | 'billing' | 'support' | 'read-only',
      exp: Math.floor(Date.now() / 1000) + 86400,
      iat: Math.floor(Date.now() / 1000),
    });

    // Redirect back to frontend with token
    const frontendRedirect = query.frontend_redirect ?? '/login';
    const separator = frontendRedirect.includes('?') ? '&' : '?';
    const userJson = encodeURIComponent(JSON.stringify({
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.roleName,
    }));

    return reply.redirect(`${frontendRedirect}${separator}token=${token}&user=${userJson}`);
  });

  // ─── Public: Backchannel logout ────────────────────────────────────────────

  app.post('/auth/oidc/backchannel-logout', {
    config: { rawBody: true },
  }, async (request, reply) => {
    const body = request.body as { logout_token?: string } | string;

    let logoutToken: string;
    if (typeof body === 'string') {
      // Form-encoded: logout_token=xxx
      const params = new URLSearchParams(body);
      logoutToken = params.get('logout_token') ?? '';
    } else {
      logoutToken = body?.logout_token ?? '';
    }

    if (!logoutToken) {
      throw new ApiError('MISSING_LOGOUT_TOKEN', 'logout_token is required', 400);
    }

    const result = await service.handleBackchannelLogout(app.db, logoutToken);
    app.log.info({ loggedOutUsers: result.loggedOutUsers }, 'Backchannel logout processed');

    // OIDC spec requires 200 OK response
    return reply.status(200).send();
  });

  // ─── Admin: OIDC Settings CRUD ─────────────────────────────────────────────

  app.get('/admin/oidc/settings', {
    onRequest: [authenticate, requireRole('admin')],
  }, async () => {
    const settings = await service.getOidcSettings(app.db);
    return success(settings);
  });

  app.put('/admin/oidc/settings', {
    onRequest: [authenticate, requireRole('admin')],
  }, async (request) => {
    const input = request.body as {
      issuer_url: string;
      client_id: string;
      client_secret: string;
      enabled?: boolean;
      disable_local_auth?: boolean;
      backchannel_logout_enabled?: boolean;
    };

    if (!input.issuer_url || !input.client_id || !input.client_secret) {
      throw new ApiError('MISSING_REQUIRED_FIELD', 'issuer_url, client_id, and client_secret are required', 400);
    }

    const settings = await service.saveOidcSettings(app.db, input, encryptionKey);
    return success(settings);
  });

  app.post('/admin/oidc/test', {
    onRequest: [authenticate, requireRole('admin')],
  }, async () => {
    const result = await service.testOidcConnection(app.db);
    return success(result);
  });
}
