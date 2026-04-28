/**
 * HTTP routes for per-ingress OAuth2/OIDC access control.
 *
 *   GET    /api/v1/clients/:cid/ingress-routes/:rid/auth
 *   PATCH  /api/v1/clients/:cid/ingress-routes/:rid/auth
 *   DELETE /api/v1/clients/:cid/ingress-routes/:rid/auth
 *   POST   /api/v1/clients/:cid/ingress-routes/:rid/auth/test
 *
 * Auth: client_admin / super_admin / admin. Cross-tenant safety —
 * every handler verifies the route belongs to a domain that belongs
 * to the requested clientId.
 */

import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { ApiError } from '../../shared/errors.js';
import { success } from '../../shared/response.js';
import {
  ingressAuthConfigSchema,
  type IngressAuthTestResponse,
} from '@k8s-hosting/api-contracts';
import { ingressRoutes, domains, clients } from '../../db/schema.js';
import {
  getAuthConfig,
  upsertAuthConfig,
  deleteAuthConfig,
} from './service.js';
import { reconcileClient } from './reconciler.js';
import { createK8sClients, type K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { ZodError } from 'zod';

function zodMessage(err: ZodError): string {
  return err.issues
    .map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
}

/**
 * Confirms the ingress route belongs to a domain owned by `clientId`.
 * Throws 404 on mismatch — the handler treats this as "route not found
 * within your client" rather than 403, to avoid leaking ownership.
 */
async function assertRouteBelongsToClient(
  app: FastifyInstance,
  clientId: string,
  routeId: string,
): Promise<{ namespace: string }> {
  const rows = await app.db
    .select({ ns: clients.kubernetesNamespace })
    .from(ingressRoutes)
    .innerJoin(domains, eq(domains.id, ingressRoutes.domainId))
    .innerJoin(clients, eq(clients.id, domains.clientId))
    .where(and(eq(ingressRoutes.id, routeId), eq(clients.id, clientId)));
  const ns = rows[0]?.ns;
  if (!ns) {
    throw new ApiError('NOT_FOUND', `Ingress route ${routeId} not found for client`, 404);
  }
  return { namespace: ns };
}

export async function ingressAuthRoutes(app: FastifyInstance): Promise<void> {
  const encryptionKey = app.config?.OIDC_ENCRYPTION_KEY
    ?? process.env.OIDC_ENCRYPTION_KEY
    ?? '0'.repeat(64);

  // Lazily-resolved K8s client — allows the route module to register
  // even when no in-cluster config is loadable (vitest, local dev).
  let k8s: K8sClients | undefined;
  try {
    const kp = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    k8s = createK8sClients(kp);
  } catch (err) {
    app.log.warn({ err }, 'ingress-auth: k8s client unavailable — reconciler disabled');
  }

  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin', 'admin', 'client_admin'));

  // GET — return current config (decrypted-omit) or null.
  app.get('/clients/:cid/ingress-routes/:rid/auth', async (request) => {
    const { cid, rid } = request.params as { cid: string; rid: string };
    await assertRouteBelongsToClient(app, cid, rid);
    const cfg = await getAuthConfig(app.db, rid);
    return success(cfg);
  });

  // PATCH — upsert + reconcile.
  app.patch('/clients/:cid/ingress-routes/:rid/auth', async (request) => {
    const { cid, rid } = request.params as { cid: string; rid: string };
    await assertRouteBelongsToClient(app, cid, rid);
    const parsed = ingressAuthConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', zodMessage(parsed.error), 400);
    }
    const cfg = await upsertAuthConfig(app.db, { encryptionKey }, rid, parsed.data);
    if (k8s) {
      // Fire and await — surfaces reconcile errors to the caller so
      // the UI sees "saved but proxy update failed" rather than a
      // silent inconsistency.
      const outcome = await reconcileClient(
        { db: app.db, k8s, encryptionKey },
        cid,
      );
      if (outcome.error) {
        throw new ApiError(
          'RECONCILE_FAILED',
          `Config saved but proxy reconcile failed: ${outcome.error}. The next scheduler tick will retry.`,
          502,
        );
      }
    }
    return success(cfg);
  });

  // DELETE — disable + reconcile (tears down the proxy when last).
  app.delete('/clients/:cid/ingress-routes/:rid/auth', async (request) => {
    const { cid, rid } = request.params as { cid: string; rid: string };
    await assertRouteBelongsToClient(app, cid, rid);
    await deleteAuthConfig(app.db, rid);
    if (k8s) {
      await reconcileClient({ db: app.db, k8s, encryptionKey }, cid);
    }
    return success({ deleted: true });
  });

  // POST .../test — fetch the OIDC discovery document server-side and
  // validate that authorization_endpoint + token_endpoint are present.
  // Doesn't persist anything. Returns a typed response shape so the UI
  // can render the result without re-fetching.
  app.post('/clients/:cid/ingress-routes/:rid/auth/test', async (request) => {
    const { cid, rid } = request.params as { cid: string; rid: string };
    await assertRouteBelongsToClient(app, cid, rid);
    const body = request.body as { issuerUrl?: string };
    const issuerUrl = (body?.issuerUrl ?? '').trim();
    if (!/^https?:\/\//.test(issuerUrl)) {
      const result: IngressAuthTestResponse = {
        ok: false,
        issuerReachable: false,
        authorizationEndpoint: null,
        tokenEndpoint: null,
        jwksUri: null,
        error: 'issuerUrl must be a valid http(s) URL',
      };
      return success(result);
    }
    // Trim trailing slash and append discovery path.
    const url = issuerUrl.replace(/\/$/, '') + '/.well-known/openid-configuration';
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5_000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) {
        const result: IngressAuthTestResponse = {
          ok: false,
          issuerReachable: true,
          authorizationEndpoint: null,
          tokenEndpoint: null,
          jwksUri: null,
          error: `discovery returned HTTP ${res.status}`,
        };
        return success(result);
      }
      const j = (await res.json()) as Record<string, unknown>;
      const auth = typeof j.authorization_endpoint === 'string' ? j.authorization_endpoint : null;
      const token = typeof j.token_endpoint === 'string' ? j.token_endpoint : null;
      const jwks = typeof j.jwks_uri === 'string' ? j.jwks_uri : null;
      const result: IngressAuthTestResponse = {
        ok: Boolean(auth && token),
        issuerReachable: true,
        authorizationEndpoint: auth,
        tokenEndpoint: token,
        jwksUri: jwks,
        error: auth && token ? null : 'discovery missing authorization_endpoint or token_endpoint',
      };
      return success(result);
    } catch (err) {
      const result: IngressAuthTestResponse = {
        ok: false,
        issuerReachable: false,
        authorizationEndpoint: null,
        tokenEndpoint: null,
        jwksUri: null,
        error: err instanceof Error ? err.message : 'network error',
      };
      return success(result);
    }
  });
}
