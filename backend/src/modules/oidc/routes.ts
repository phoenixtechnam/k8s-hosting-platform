import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import * as service from './service.js';
import type { SaveProviderInput, SaveGlobalSettingsInput } from './service.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { syncProxyIngressAnnotations, syncOAuth2ProxySecret } from './ingress-proxy-manager.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';

// In-memory PKCE state store (Phase 1). Replace with Redis in production.
const pkceStore = new Map<string, { codeVerifier: string; frontendRedirect: string; providerId: string; expiresAt: number }>();
const MAX_PKCE_ENTRIES = 1000;

export async function oidcRoutes(app: FastifyInstance): Promise<void> {
  // Prune expired entries every 5 minutes; cap size to prevent DoS.
  const pkceCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, val] of pkceStore) {
      if (val.expiresAt < now) pkceStore.delete(key);
    }
    // Hard cap — if store exceeds limit, drop oldest entries
    if (pkceStore.size > MAX_PKCE_ENTRIES) {
      const excess = pkceStore.size - MAX_PKCE_ENTRIES;
      let deleted = 0;
      for (const key of pkceStore.keys()) {
        if (deleted >= excess) break;
        pkceStore.delete(key);
        deleted++;
      }
    }
  }, 300_000);
  app.addHook('onClose', () => clearInterval(pkceCleanupTimer));
  const resolveEncryptionKey = (): string => {
    const k = app.config?.OIDC_ENCRYPTION_KEY ?? process.env.OIDC_ENCRYPTION_KEY;
    if (k && k.length >= 32) return k;
    if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') return '0'.repeat(64);
    throw new Error('OIDC_ENCRYPTION_KEY is required (oidc routes)');
  };
  const encryptionKey = resolveEncryptionKey();

  // ─── Public: Auth status (login page) ──────────────────────────────────────

  app.get('/auth/oidc/status', async (request) => {
    const query = request.query as { panel?: string };
    const panel = (query.panel === 'client' ? 'client' : 'admin') as 'admin' | 'client';
    const status = await service.getAuthStatus(app.db, panel);
    return success(status);
  });

  // ─── Public: Authorization redirect (per provider) ─────────────────────────

  app.get('/auth/oidc/authorize/:providerId', async (request, reply) => {
    const { providerId } = request.params as { providerId: string };
    const query = request.query as { redirect_uri?: string };
    const frontendCallback = query.redirect_uri;
    if (!frontendCallback) throw new ApiError('MISSING_REDIRECT_URI', 'redirect_uri is required', 400);

    const state = crypto.randomUUID();
    const { codeVerifier, codeChallenge } = service.generatePkce();

    pkceStore.set(state, { codeVerifier, frontendRedirect: frontendCallback, providerId, expiresAt: Date.now() + 600_000 });

    const host = request.headers.host ?? request.hostname;
    const backendCallback = `${request.protocol}://${host}/api/v1/auth/oidc/callback`;

    const authUrl = await service.buildAuthorizationUrl(app.db, providerId, backendCallback, state, codeChallenge);
    return reply.redirect(authUrl);
  });

  // ─── Public: OIDC callback ─────────────────────────────────────────────────

  app.get('/auth/oidc/callback', async (request, reply) => {
    const query = request.query as { code?: string; state?: string; error?: string; error_description?: string };

    if (query.error) {
      const pkce = query.state ? pkceStore.get(query.state) : undefined;
      if (pkce) pkceStore.delete(query.state!);
      const redirect = pkce?.frontendRedirect ?? '/login';
      return reply.redirect(`${redirect}?error=${encodeURIComponent(query.error_description ?? query.error)}`);
    }

    if (!query.code || !query.state) throw new ApiError('OIDC_CALLBACK_INVALID', 'Missing code or state', 400);

    const pkce = pkceStore.get(query.state);
    if (!pkce) throw new ApiError('OIDC_STATE_INVALID', 'Invalid or expired state', 400);
    pkceStore.delete(query.state);

    const host = request.headers.host ?? request.hostname;
    const callbackUrl = `${request.protocol}://${host}/api/v1/auth/oidc/callback`;

    const { idToken, provider } = await service.exchangeCodeForTokens(
      app.db, pkce.providerId, query.code, callbackUrl, pkce.codeVerifier, encryptionKey,
    );

    let user: Awaited<ReturnType<typeof service.findOrCreateOidcUser>>;
    try {
      user = await service.findOrCreateOidcUser(app.db, idToken, provider);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'OIDC_USER_NOT_FOUND') {
        const frontendRedirect = pkce.frontendRedirect;
        const sep = frontendRedirect.includes('?') ? '&' : '?';
        return reply.redirect(
          `${frontendRedirect}${sep}error=oidc_user_not_found&message=${encodeURIComponent(err.message)}`,
        );
      }
      throw err;
    }

    const jwtPayload: Record<string, unknown> = {
      sub: user.id, role: user.roleName, panel: user.panel ?? 'admin',
      exp: Math.floor(Date.now() / 1000) + 86400, iat: Math.floor(Date.now() / 1000),
      jti: crypto.randomUUID(),
    };
    if (user.clientId) jwtPayload.clientId = user.clientId;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const token = app.jwt.sign(jwtPayload as any);

    const frontendRedirect = pkce.frontendRedirect;
    const separator = frontendRedirect.includes('?') ? '&' : '?';
    const userJson = encodeURIComponent(JSON.stringify({
      id: user.id, email: user.email, fullName: user.fullName,
      role: user.roleName, panel: user.panel ?? 'admin', clientId: user.clientId ?? null,
    }));

    return reply.redirect(`${frontendRedirect}${separator}token=${token}&user=${userJson}`);
  });

  // ─── Public: Backchannel logout ────────────────────────────────────────────

  app.post('/auth/oidc/backchannel-logout', async (request, reply) => {
    const body = request.body as { logout_token?: string } | string;
    let logoutToken: string;
    if (typeof body === 'string') {
      logoutToken = new URLSearchParams(body).get('logout_token') ?? '';
    } else {
      logoutToken = body?.logout_token ?? '';
    }
    if (!logoutToken) throw new ApiError('MISSING_LOGOUT_TOKEN', 'logout_token is required', 400);

    const result = await service.handleBackchannelLogout(app.db, logoutToken);
    app.log.info({ loggedOutUsers: result.loggedOutUsers }, 'Backchannel logout processed');
    return reply.status(200).send();
  });

  // ─── Public: Break-glass emergency login ───────────────────────────────────

  app.post('/auth/break-glass', {
    config: { rateLimit: { max: 3, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const body = request.body as { email?: string; password?: string; break_glass_secret?: string };
    if (!body.email || !body.password || !body.break_glass_secret) {
      throw new ApiError('MISSING_REQUIRED_FIELD', 'email, password, and break_glass_secret are required', 400);
    }

    const user = await service.breakGlassLogin(app.db, body.email, body.password, body.break_glass_secret);

    const jwtPayload: Record<string, unknown> = {
      sub: user.id, role: user.role, panel: 'admin',
      exp: Math.floor(Date.now() / 1000) + 86400,
      iat: Math.floor(Date.now() / 1000), jti: crypto.randomUUID(),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const token = app.jwt.sign(jwtPayload as any);

    return reply.send(success({ token, user, breakGlass: true }));
  });

  // ─── Admin: Provider CRUD ──────────────────────────────────────────────────

  app.get('/admin/oidc/providers', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
  }, async () => success(await service.listProviders(app.db)));

  app.post('/admin/oidc/providers', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
  }, async (request, reply) => {
    const input = request.body as unknown as SaveProviderInput;
    if (!input.display_name || !input.issuer_url || !input.client_id || !input.client_secret || !input.panel_scope) {
      throw new ApiError('MISSING_REQUIRED_FIELD', 'display_name, issuer_url, client_id, client_secret, and panel_scope are required', 400);
    }
    const provider = await service.createProvider(app.db, input, encryptionKey);
    reply.status(201).send(success(provider));
  });

  app.patch('/admin/oidc/providers/:id', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
  }, async (request) => {
    const { id } = request.params as { id: string };
    const input = request.body as unknown as Partial<SaveProviderInput>;
    const updated = await service.updateProvider(app.db, id, input, encryptionKey);
    return success(updated);
  });

  app.delete('/admin/oidc/providers/:id', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await service.deleteProvider(app.db, id);
    reply.status(204).send();
  });

  app.post('/admin/oidc/providers/:id/test', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
  }, async (request) => {
    const { id } = request.params as { id: string };
    const result = await service.testProviderConnection(app.db, id);
    return success(result);
  });

  // ─── Admin: Global Auth Settings ───────────────────────────────────────────

  app.get('/admin/oidc/settings', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
  }, async () => success(await service.getGlobalSettings(app.db)));

  app.put('/admin/oidc/settings', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
  }, async (request) => {
    const input = request.body as unknown as SaveGlobalSettingsInput;
    const settings = await service.saveGlobalSettings(app.db, input, encryptionKey);

    // Sync K8s Ingress annotations + cookie secret when proxy settings change
    try {
      const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
      const k8s = createK8sClients(kubeconfigPath);
      await syncProxyIngressAnnotations(app.db, k8s, {
        protectAdminViaProxy: settings.protectAdminViaProxy,
        protectClientViaProxy: settings.protectClientViaProxy,
        breakGlassPath: settings.breakGlassPath,
      });

      // Sync cookie secret to K8s Secret if proxy is enabled
      if (settings.protectAdminViaProxy || settings.protectClientViaProxy) {
        const cookieSecret = await service.getDecryptedCookieSecret(app.db, encryptionKey);
        if (cookieSecret) {
          await syncOAuth2ProxySecret(k8s, cookieSecret);
        }
      }

      // Also reconcile spec.rules so the /oauth2 path rule is added/removed
      // on each protected panel host. syncProxyIngressAnnotations only
      // touches metadata.annotations — without this call, enabling
      // protection 302s the browser to /oauth2/start which nginx-ingress
      // has no path rule for, falling through to the panel backend and
      // producing a 404.
      const { getSettings } = await import('../system-settings/service.js');
      const { reconcileIngressHosts } = await import('../system-settings/ingress-reconciler.js');
      const sysSettings = await getSettings(app.db);
      const cfg = app.config as Record<string, unknown>;
      const tlsSecretName = (cfg.PLATFORM_TLS_SECRET_NAME as string | undefined)?.trim() || 'platform-tls';
      const clusterIssuerName = cfg.CLUSTER_ISSUER_NAME as string | undefined;
      await reconcileIngressHosts(
        {
          adminPanelUrl: sysSettings.adminPanelUrl ?? null,
          clientPanelUrl: sysSettings.clientPanelUrl ?? null,
          tlsSecretName,
          protectAdminViaProxy: settings.protectAdminViaProxy,
          protectClientViaProxy: settings.protectClientViaProxy,
        },
        undefined,
        { kubeconfigPath, clusterIssuerName },
      );
    } catch (err) {
      app.log.warn({ err }, 'Failed to sync OAuth2 proxy Ingress annotations — K8s may be unavailable');
    }

    return success(settings);
  });

  // ─── Admin: Regenerate Break-Glass Path ───────────────────────────────────

  app.post('/admin/oidc/regenerate-break-glass', {
    onRequest: [authenticate, requireRole('super_admin')],
  }, async (_request) => {
    const newPath = await service.regenerateBreakGlassPath(app.db);

    // Update K8s Ingress with the new break-glass path
    try {
      const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
      const k8s = createK8sClients(kubeconfigPath);
      const settings = await service.getGlobalSettings(app.db);
      await syncProxyIngressAnnotations(app.db, k8s, {
        protectAdminViaProxy: settings.protectAdminViaProxy,
        protectClientViaProxy: settings.protectClientViaProxy,
        breakGlassPath: newPath,
      });
    } catch (err) {
      app.log.warn({ err }, 'Failed to sync OAuth2 proxy Ingress annotations after break-glass regeneration');
    }

    return success({ breakGlassPath: newPath });
  });

  // ─── Admin: Regenerate Cookie Secret ──────────────────────────────────────

  app.post('/admin/oidc/regenerate-cookie-secret', {
    onRequest: [authenticate, requireRole('super_admin')],
  }, async (_request) => {
    const newSecret = await service.regenerateCookieSecret(app.db, encryptionKey);

    // Update the K8s oauth2-proxy Secret and restart the proxy pod
    try {
      const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
      const k8s = createK8sClients(kubeconfigPath);
      await syncOAuth2ProxySecret(k8s, newSecret);

      // Rollout restart oauth2-proxy so it picks up the new secret
      await k8s.apps.patchNamespacedDeployment({
        name: 'oauth2-proxy',
        namespace: process.env.PLATFORM_NAMESPACE ?? 'platform',
        body: {
          spec: {
            template: {
              metadata: {
                annotations: { 'kubectl.kubernetes.io/restartedAt': new Date().toISOString() },
              },
            },
          },
        },
      });
    } catch (err) {
      app.log.warn({ err }, 'Failed to sync cookie secret to K8s — K8s may be unavailable');
    }

    return success({ regenerated: true });
  });
}
