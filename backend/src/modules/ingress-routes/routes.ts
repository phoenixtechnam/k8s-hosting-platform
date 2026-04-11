import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { authenticate, requireRole, requireClientRoleByMethod, requireClientAccess } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { clients, domains, ingressRoutes } from '../../db/schema.js';
import {
  createRoute,
  updateRoute,
  deleteRoute,
  listRoutesForDomain,
  getIngressSettings,
  updateIngressSettings,
} from './service.js';
import {
  updateRedirectSettings,
  updateSecuritySettings,
  updateAdvancedSettings,
  listAuthUsers,
  createAuthUser,
  deleteAuthUser,
  toggleAuthUser,
  changeAuthUserPassword,
  listWafLogs,
  mapRouteToResponse,
} from './settings-service.js';
import { syncRouteAnnotations } from './annotation-sync.js';
import { reconcileIngress } from '../domains/k8s-ingress.js';
import { ensureDomainCertificate } from '../certificates/service.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import {
  createIngressRouteSchema,
  updateIngressRouteSchema,
  updateRedirectSettingsSchema,
  updateSecuritySettingsSchema,
  updateAdvancedSettingsSchema,
  createAuthUserSchema,
  toggleAuthUserSchema,
  changeAuthUserPasswordSchema,
} from '@k8s-hosting/api-contracts';

export async function ingressRouteRoutes(app: FastifyInstance): Promise<void> {
  const getK8s = () => {
    try {
      const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
      return createK8sClients(kubeconfigPath);
    } catch {
      return undefined;
    }
  };

  const triggerReconcile = async (clientId: string) => {
    const k8s = getK8s();
    if (!k8s) return;
    const [client] = await app.db.select().from(clients).where(eq(clients.id, clientId));
    if (client?.kubernetesNamespace) {
      try {
        await reconcileIngress(app.db, k8s, clientId, client.kubernetesNamespace);
      } catch {
        // Non-blocking
      }
    }
  };

  const triggerAnnotationSync = async (routeId: string, clientId: string) => {
    const k8s = getK8s();
    if (!k8s) return;
    try {
      await syncRouteAnnotations(app.db, k8s, routeId, clientId);
      await triggerReconcile(clientId);
    } catch {
      // Non-blocking — annotation sync failure should not break the settings update
    }
  };

  // ─── Client-scoped routes ─────────────────────────────────────────────────

  // GET /api/v1/clients/:clientId/domains/:domainId/routes
  app.get('/clients/:clientId/domains/:domainId/routes', {
    onRequest: [authenticate, requireClientRoleByMethod(), requireClientAccess()],
    schema: {
      tags: ['Ingress Routes'],
      summary: 'List ingress routes for a domain',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { domainId } = request.params as { domainId: string };
    const routes = await listRoutesForDomain(app.db, domainId);
    return success(routes);
  });

  // POST /api/v1/clients/:clientId/domains/:domainId/routes
  app.post('/clients/:clientId/domains/:domainId/routes', {
    onRequest: [authenticate, requireClientRoleByMethod(), requireClientAccess()],
    schema: {
      tags: ['Ingress Routes'],
      summary: 'Create an ingress route for a hostname under this domain',
      security: [{ bearerAuth: [] }],
    },
  }, async (request, reply) => {
    const { clientId, domainId } = request.params as { clientId: string; domainId: string };
    const parsed = createIngressRouteSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', parsed.error.errors[0].message, 400);
    }

    const route = await createRoute(app.db, domainId, clientId, parsed.data.hostname, parsed.data.deployment_id);
    await triggerReconcile(clientId);

    // Phase 2c: delegate cert provisioning to the central certificates
    // module. It picks the right ClusterIssuer based on the domain's
    // dnsMode + DNS provider, issues a wildcard when possible, and
    // writes a single Certificate CR per domain (not per-route).
    if (parsed.data.deployment_id) {
      const k8s = getK8s();
      if (k8s) {
        try {
          await ensureDomainCertificate(app.db, k8s, domainId, app.log);
        } catch (err) {
          // Non-blocking — cert-manager may still issue via Ingress annotation fallback,
          // and the error is already logged in the certificates service.
          app.log.warn({ err, domainId }, 'ingress-routes: ensureDomainCertificate failed (non-blocking)');
        }
      }
    }

    reply.status(201).send(success(route));
  });

  // PATCH /api/v1/clients/:clientId/domains/:domainId/routes/:routeId
  app.patch('/clients/:clientId/domains/:domainId/routes/:routeId', {
    onRequest: [authenticate, requireClientRoleByMethod(), requireClientAccess()],
    schema: {
      tags: ['Ingress Routes'],
      summary: 'Update an ingress route (assign workload, change TLS mode)',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { clientId, routeId } = request.params as { clientId: string; routeId: string };
    const parsed = updateIngressRouteSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', parsed.error.errors[0].message, 400);
    }

    const updated = await updateRoute(app.db, routeId, {
      deploymentId: parsed.data.deployment_id,
      tlsMode: parsed.data.tls_mode,
      nodeHostname: parsed.data.node_hostname,
    });
    await triggerReconcile(clientId);
    return success(updated);
  });

  // DELETE /api/v1/clients/:clientId/domains/:domainId/routes/:routeId
  app.delete('/clients/:clientId/domains/:domainId/routes/:routeId', {
    onRequest: [authenticate, requireClientRoleByMethod(), requireClientAccess()],
    schema: {
      tags: ['Ingress Routes'],
      summary: 'Delete an ingress route',
      security: [{ bearerAuth: [] }],
    },
  }, async (request, reply) => {
    const { clientId, routeId } = request.params as { clientId: string; routeId: string };
    await deleteRoute(app.db, routeId);
    await triggerReconcile(clientId);
    reply.status(204).send();
  });

  // ─── Route-level Settings ─────────────────────────────────────────────────

  // GET /api/v1/clients/:clientId/routes/:routeId — single route detail
  app.get('/clients/:clientId/routes/:routeId', {
    onRequest: [authenticate, requireClientRoleByMethod(), requireClientAccess()],
    schema: {
      tags: ['Ingress Routes'],
      summary: 'Get a single ingress route with all settings',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { clientId, routeId } = request.params as { clientId: string; routeId: string };
    const [route] = await app.db.select().from(ingressRoutes).where(eq(ingressRoutes.id, routeId));
    if (!route) throw new ApiError('ROUTE_NOT_FOUND', 'Ingress route not found', 404);
    // Verify ownership via domain → client
    const [domain] = await app.db.select().from(domains).where(and(eq(domains.id, route.domainId), eq(domains.clientId, clientId)));
    if (!domain) throw new ApiError('ROUTE_NOT_FOUND', 'Ingress route not found', 404);
    return success(mapRouteToResponse(route));
  });

  // PATCH /api/v1/clients/:clientId/routes/:routeId/redirects
  app.patch('/clients/:clientId/routes/:routeId/redirects', {
    onRequest: [authenticate, requireClientRoleByMethod(), requireClientAccess()],
    schema: {
      tags: ['Ingress Route Settings'],
      summary: 'Update redirect settings for a route',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { clientId, routeId } = request.params as { clientId: string; routeId: string };
    const parsed = updateRedirectSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', parsed.error.errors[0].message, 400);
    }

    const updated = await updateRedirectSettings(app.db, routeId, clientId, parsed.data);
    await triggerAnnotationSync(routeId, clientId);
    return success(updated);
  });

  // PATCH /api/v1/clients/:clientId/routes/:routeId/security
  app.patch('/clients/:clientId/routes/:routeId/security', {
    onRequest: [authenticate, requireClientRoleByMethod(), requireClientAccess()],
    schema: {
      tags: ['Ingress Route Settings'],
      summary: 'Update security settings for a route',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { clientId, routeId } = request.params as { clientId: string; routeId: string };
    const parsed = updateSecuritySettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', parsed.error.errors[0].message, 400);
    }

    const updated = await updateSecuritySettings(app.db, routeId, clientId, parsed.data);
    await triggerAnnotationSync(routeId, clientId);
    return success(updated);
  });

  // PATCH /api/v1/clients/:clientId/routes/:routeId/advanced
  app.patch('/clients/:clientId/routes/:routeId/advanced', {
    onRequest: [authenticate, requireClientRoleByMethod(), requireClientAccess()],
    schema: {
      tags: ['Ingress Route Settings'],
      summary: 'Update advanced settings for a route',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { clientId, routeId } = request.params as { clientId: string; routeId: string };
    const parsed = updateAdvancedSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', parsed.error.errors[0].message, 400);
    }

    const updated = await updateAdvancedSettings(app.db, routeId, clientId, parsed.data);
    await triggerAnnotationSync(routeId, clientId);
    return success(updated);
  });

  // ─── Auth Users ───────────────────────────────────────────────────────────

  // GET /api/v1/clients/:clientId/routes/:routeId/auth-users
  app.get('/clients/:clientId/routes/:routeId/auth-users', {
    onRequest: [authenticate, requireClientRoleByMethod(), requireClientAccess()],
    schema: {
      tags: ['Ingress Route Auth'],
      summary: 'List basic-auth users for a route',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { routeId } = request.params as { routeId: string };
    const users = await listAuthUsers(app.db, routeId);
    return success(users);
  });

  // POST /api/v1/clients/:clientId/routes/:routeId/auth-users
  app.post('/clients/:clientId/routes/:routeId/auth-users', {
    onRequest: [authenticate, requireClientRoleByMethod(), requireClientAccess()],
    schema: {
      tags: ['Ingress Route Auth'],
      summary: 'Create a basic-auth user for a route',
      security: [{ bearerAuth: [] }],
    },
  }, async (request, reply) => {
    const { clientId, routeId } = request.params as { clientId: string; routeId: string };
    const parsed = createAuthUserSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', parsed.error.errors[0].message, 400);
    }

    const user = await createAuthUser(app.db, routeId, parsed.data.username, parsed.data.password);
    await triggerAnnotationSync(routeId, clientId);
    reply.status(201).send(success(user));
  });

  // DELETE /api/v1/clients/:clientId/routes/:routeId/auth-users/:userId
  app.delete('/clients/:clientId/routes/:routeId/auth-users/:userId', {
    onRequest: [authenticate, requireClientRoleByMethod(), requireClientAccess()],
    schema: {
      tags: ['Ingress Route Auth'],
      summary: 'Delete a basic-auth user from a route',
      security: [{ bearerAuth: [] }],
    },
  }, async (request, reply) => {
    const { clientId, routeId, userId } = request.params as { clientId: string; routeId: string; userId: string };
    await deleteAuthUser(app.db, routeId, userId);
    await triggerAnnotationSync(routeId, clientId);
    reply.status(204).send();
  });

  // POST /api/v1/clients/:clientId/routes/:routeId/auth-users/:userId/toggle
  app.post('/clients/:clientId/routes/:routeId/auth-users/:userId/toggle', {
    onRequest: [authenticate, requireClientRoleByMethod(), requireClientAccess()],
    schema: {
      tags: ['Ingress Route Auth'],
      summary: 'Enable/disable a basic-auth user',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { clientId, routeId, userId } = request.params as { clientId: string; routeId: string; userId: string };
    const parsed = toggleAuthUserSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', parsed.error.errors[0].message, 400);
    }

    await toggleAuthUser(app.db, routeId, userId, parsed.data.enabled);
    await triggerAnnotationSync(routeId, clientId);
    return success({ message: 'User toggled' });
  });

  // POST /api/v1/clients/:clientId/routes/:routeId/auth-users/:userId/change-password
  app.post('/clients/:clientId/routes/:routeId/auth-users/:userId/change-password', {
    onRequest: [authenticate, requireClientRoleByMethod(), requireClientAccess()],
    schema: {
      tags: ['Ingress Route Auth'],
      summary: 'Change password for a basic-auth user',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { clientId, routeId, userId } = request.params as { clientId: string; routeId: string; userId: string };
    const parsed = changeAuthUserPasswordSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', parsed.error.errors[0].message, 400);
    }

    await changeAuthUserPassword(app.db, routeId, userId, parsed.data.password);
    await triggerAnnotationSync(routeId, clientId);
    return success({ message: 'Password changed' });
  });

  // ─── WAF Logs ─────────────────────────────────────────────────────────────

  // GET /api/v1/clients/:clientId/routes/:routeId/waf-logs
  app.get('/clients/:clientId/routes/:routeId/waf-logs', {
    onRequest: [authenticate, requireClientRoleByMethod(), requireClientAccess()],
    schema: {
      tags: ['Ingress Route WAF'],
      summary: 'List WAF logs for a route',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { routeId } = request.params as { routeId: string };
    const query = request.query as { limit?: string };
    const limit = query.limit ? Math.min(Number(query.limit), 100) : 50;
    const logs = await listWafLogs(app.db, routeId, limit);
    return success(logs);
  });

  // ─── Admin: Ingress Settings ──────────────────────────────────────────────

  app.get('/admin/ingress-settings', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
    schema: {
      tags: ['Ingress Settings'],
      summary: 'Get platform ingress routing settings',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    return success(await getIngressSettings(app.db));
  });

  app.patch('/admin/ingress-settings', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
    schema: {
      tags: ['Ingress Settings'],
      summary: 'Update platform ingress routing settings',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const body = request.body as {
      ingressBaseDomain?: string;
      ingressDefaultIpv4?: string;
      ingressDefaultIpv6?: string | null;
    };
    return success(await updateIngressSettings(app.db, body));
  });
}
