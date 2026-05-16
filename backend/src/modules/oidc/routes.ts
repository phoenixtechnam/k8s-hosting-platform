import type { FastifyInstance } from 'fastify';
import { eq, lt } from 'drizzle-orm';
import { authenticate, requireRole } from '../../middleware/auth.js';
import * as service from './service.js';
import type { SaveProviderInput, SaveGlobalSettingsInput } from './service.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { syncProxyIngressAnnotations, syncOAuth2ProxySecret } from './ingress-proxy-manager.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { STRATEGIC_MERGE_PATCH } from '../../shared/k8s-patch.js';
import { oidcPkceState } from '../../db/schema.js';
import type { Database } from '../../db/index.js';

interface PkceEntry {
  codeVerifier: string;
  frontendRedirect: string;
  providerId: string;
  expiresAt: number;
}

// Postgres-backed PKCE state store. Previously this was an in-memory
// per-replica Map, which broke the OIDC flow whenever /authorize and
// /callback landed on different platform-api pods (the second pod had
// no record of the state). See migration 0086_oidc_pkce_state.sql.
const pkceStore = {
  async set(db: Database, state: string, entry: PkceEntry): Promise<void> {
    await db.insert(oidcPkceState).values({
      state,
      codeVerifier: entry.codeVerifier,
      frontendRedirect: entry.frontendRedirect,
      providerId: entry.providerId,
      expiresAt: new Date(entry.expiresAt),
    });
  },
  async get(db: Database, state: string): Promise<PkceEntry | undefined> {
    const [row] = await db.select().from(oidcPkceState).where(eq(oidcPkceState.state, state)).limit(1);
    if (!row) return undefined;
    if (row.expiresAt.getTime() < Date.now()) return undefined;
    return {
      codeVerifier: row.codeVerifier,
      frontendRedirect: row.frontendRedirect,
      providerId: row.providerId,
      expiresAt: row.expiresAt.getTime(),
    };
  },
  async delete(db: Database, state: string): Promise<void> {
    await db.delete(oidcPkceState).where(eq(oidcPkceState.state, state));
  },
  async pruneExpired(db: Database): Promise<void> {
    await db.delete(oidcPkceState).where(lt(oidcPkceState.expiresAt, new Date()));
  },
};

export async function oidcRoutes(app: FastifyInstance): Promise<void> {
  // Periodically prune expired PKCE rows (DB-side TTL). Single-row
  // entries are tiny (< 200 B), so this matters mostly for hygiene
  // and keeping the index small. 5-minute cadence matches the
  // previous in-memory cleanup.
  const pkceCleanupTimer = setInterval(() => {
    void pkceStore.pruneExpired(app.db).catch((err) => {
      app.log.warn({ err }, 'oidc-pkce: prune failed');
    });
  }, 300_000);
  app.addHook('onClose', () => clearInterval(pkceCleanupTimer));
  const resolveEncryptionKey = (): string => {
    const k = app.config?.PLATFORM_ENCRYPTION_KEY ?? process.env.PLATFORM_ENCRYPTION_KEY;
    if (k && k.length >= 32) return k;
    if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') return '0'.repeat(64);
    throw new Error('PLATFORM_ENCRYPTION_KEY is required (oidc routes)');
  };
  const encryptionKey = resolveEncryptionKey();

  // ─── Public: Auth status (login page) ──────────────────────────────────────

  app.get('/auth/oidc/status', async (request) => {
    const query = request.query as { panel?: string };
    const panel = (query.panel === 'tenant' ? 'tenant' : 'admin') as 'admin' | 'tenant';
    const status = await service.getAuthStatus(app.db, panel);
    return success(status);
  });

  // ─── Public: Authorization redirect (per provider) ─────────────────────────

  // Resolve the public scheme behind nginx-ingress. Fastify's
  // `request.protocol` is unreliable here in Fastify v5 — even with
  // `trustProxy: true`, it returned 'http' on staging. Read
  // X-Forwarded-Proto directly (set by nginx-ingress to the actual
  // tenant scheme via $pass_access_scheme) and fall back to
  // request.protocol only if the header is missing. Surfaced by
  // integration-oidc-dex.sh: Dex's static tenant only allows https://
  // redirect_uris, so an http:// scheme produces "Unregistered
  // redirect_uri" and the entire auth flow breaks.
  const resolveScheme = (request: { headers: Record<string, string | string[] | undefined>; protocol: string; log?: { info: (obj: object, msg: string) => void } }): string => {
    const xfp = request.headers['x-forwarded-proto'];
    const value = Array.isArray(xfp) ? xfp[0] : xfp;
    let resolved: string;
    if (typeof value === 'string' && value.length > 0) {
      // X-Forwarded-Proto can be a comma-separated list across multiple proxies.
      resolved = value.split(',')[0].trim().toLowerCase();
    } else {
      resolved = request.protocol;
    }
    // Defensive: when running behind nginx-ingress on a public host, the
    // platform's admin/client panels always serve over HTTPS. If the
    // header is missing AND `request.protocol` falls back to "http"
    // (Fastify v5 quirk), force HTTPS for any non-localhost host so the
    // OIDC redirect_uri Dex sees matches the registered staticTenant.
    if (resolved !== 'https') {
      const host = (request.headers.host as string | undefined) ?? '';
      const isLocal = host.startsWith('localhost') || host.startsWith('127.0.0.1') || host.startsWith('[::1]');
      if (!isLocal && host.length > 0) {
        request.log?.info({ host, xfp: value, fallback_protocol: request.protocol }, 'oidc-redirect: forcing https for non-local host');
        resolved = 'https';
      }
    }
    return resolved;
  };

  app.get('/auth/oidc/authorize/:providerId', async (request, reply) => {
    const { providerId } = request.params as { providerId: string };
    const query = request.query as { redirect_uri?: string };
    const frontendCallback = query.redirect_uri;
    if (!frontendCallback) throw new ApiError('MISSING_REDIRECT_URI', 'redirect_uri is required', 400);

    const state = crypto.randomUUID();
    const { codeVerifier, codeChallenge } = service.generatePkce();

    await pkceStore.set(app.db, state, { codeVerifier, frontendRedirect: frontendCallback, providerId, expiresAt: Date.now() + 600_000 });

    const host = request.headers.host ?? request.hostname;
    const backendCallback = `${resolveScheme(request)}://${host}/api/v1/auth/oidc/callback`;

    const authUrl = await service.buildAuthorizationUrl(app.db, providerId, backendCallback, state, codeChallenge);
    return reply.redirect(authUrl);
  });

  // ─── Public: OIDC callback ─────────────────────────────────────────────────

  app.get('/auth/oidc/callback', async (request, reply) => {
    const query = request.query as { code?: string; state?: string; error?: string; error_description?: string };

    if (query.error) {
      const pkce = query.state ? await pkceStore.get(app.db, query.state) : undefined;
      if (pkce) await pkceStore.delete(app.db, query.state!);
      const redirect = pkce?.frontendRedirect ?? '/login';
      return reply.redirect(`${redirect}?error=${encodeURIComponent(query.error_description ?? query.error)}`);
    }

    if (!query.code || !query.state) throw new ApiError('OIDC_CALLBACK_INVALID', 'Missing code or state', 400);

    const pkce = await pkceStore.get(app.db, query.state);
    if (!pkce) throw new ApiError('OIDC_STATE_INVALID', 'Invalid or expired state', 400);
    await pkceStore.delete(app.db, query.state);

    const host = request.headers.host ?? request.hostname;
    const callbackUrl = `${resolveScheme(request)}://${host}/api/v1/auth/oidc/callback`;

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
    if (user.tenantId) jwtPayload.tenantId = user.tenantId;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const token = app.jwt.sign(jwtPayload as any);

    const frontendRedirect = pkce.frontendRedirect;
    const separator = frontendRedirect.includes('?') ? '&' : '?';
    const userJson = encodeURIComponent(JSON.stringify({
      id: user.id, email: user.email, fullName: user.fullName,
      role: user.roleName, panel: user.panel ?? 'admin', tenantId: user.tenantId ?? null,
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
      // Resolve adminHost from system_settings.adminPanelUrl so the
      // break-glass IngressRoute can build `Host(\`admin.example.com\`)`
      // match expressions. The platform-ingress reconciler already does
      // the same extraction; the duplication keeps proxy-manager
      // independent of cross-module reconciler state.
      const { getSettings } = await import('../system-settings/service.js');
      const { reconcileIngressHosts, extractHost } = await import('../system-settings/ingress-reconciler.js');
      const sysSettings = await getSettings(app.db);
      const adminHost = extractHost(sysSettings.adminPanelUrl);
      await syncProxyIngressAnnotations(app.db, k8s, {
        protectAdminViaProxy: settings.protectAdminViaProxy,
        protectTenantViaProxy: settings.protectTenantViaProxy,
        breakGlassPath: settings.breakGlassPath,
        adminHost,
      });

      // Sync cookie secret to K8s Secret if proxy is enabled
      if (settings.protectAdminViaProxy || settings.protectTenantViaProxy) {
        const cookieSecret = await service.getDecryptedCookieSecret(app.db, encryptionKey);
        if (cookieSecret) {
          await syncOAuth2ProxySecret(k8s, cookieSecret);
        }
      }

      // Re-reconcile the platform-ingress so the /oauth2 priority route
      // + ForwardAuth Middleware reference are added/removed on each
      // protected panel host. Without this call, enabling protection
      // would create the ForwardAuth Middleware (above) but no route
      // would reference it — producing a still-unprotected admin panel.
      const cfg = app.config as Record<string, unknown>;
      const tlsSecretName = (cfg.PLATFORM_TLS_SECRET_NAME as string | undefined)?.trim() || 'platform-tls';
      const clusterIssuerName = cfg.CLUSTER_ISSUER_NAME as string | undefined;
      await reconcileIngressHosts(
        {
          adminPanelUrl: sysSettings.adminPanelUrl ?? null,
          tenantPanelUrl: sysSettings.tenantPanelUrl ?? null,
          tlsSecretName,
          protectAdminViaProxy: settings.protectAdminViaProxy,
          protectTenantViaProxy: settings.protectTenantViaProxy,
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
      const { getSettings } = await import('../system-settings/service.js');
      const { extractHost } = await import('../system-settings/ingress-reconciler.js');
      const sysSettings = await getSettings(app.db);
      const adminHost = extractHost(sysSettings.adminPanelUrl);
      await syncProxyIngressAnnotations(app.db, k8s, {
        protectAdminViaProxy: settings.protectAdminViaProxy,
        protectTenantViaProxy: settings.protectTenantViaProxy,
        breakGlassPath: newPath,
        adminHost,
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
      }, STRATEGIC_MERGE_PATCH);
    } catch (err) {
      app.log.warn({ err }, 'Failed to sync cookie secret to K8s — K8s may be unavailable');
    }

    return success({ regenerated: true });
  });
}
