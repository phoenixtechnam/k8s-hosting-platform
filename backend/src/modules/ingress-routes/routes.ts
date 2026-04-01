import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { authenticate, requireRole, requireClientAccess } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { clients, domains } from '../../db/schema.js';
import {
  createRoute,
  updateRoute,
  deleteRoute,
  listRoutesForDomain,
  getIngressSettings,
  updateIngressSettings,
} from './service.js';
import { reconcileIngress } from '../domains/k8s-ingress.js';
import { provisionCertificate } from '../ssl-certs/cert-manager.js';
import { isAutoTlsEnabled } from '../tls-settings/service.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { createIngressRouteSchema, updateIngressRouteSchema } from '@k8s-hosting/api-contracts';

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

  // ─── Client-scoped routes ─────────────────────────────────────────────────

  // GET /api/v1/clients/:clientId/domains/:domainId/routes
  app.get('/clients/:clientId/domains/:domainId/routes', {
    onRequest: [authenticate, requireRole('super_admin', 'admin', 'support', 'client_admin', 'client_user'), requireClientAccess()],
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
    onRequest: [authenticate, requireRole('super_admin', 'admin', 'client_admin'), requireClientAccess()],
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

    // Provision TLS certificate if auto-TLS enabled and workload assigned
    if (parsed.data.deployment_id) {
      const k8s = getK8s();
      if (k8s) {
        try {
          const autoTls = await isAutoTlsEnabled(app.db);
          if (autoTls) {
            const [domain] = await app.db.select().from(domains).where(eq(domains.id, domainId));
            const [client] = await app.db.select().from(clients).where(eq(clients.id, clientId));
            if (domain && client?.kubernetesNamespace) {
              await provisionCertificate(app.db, k8s, {
                domainName: parsed.data.hostname,
                namespace: client.kubernetesNamespace,
                dnsMode: domain.dnsMode,
                hasDnsServer: domain.dnsMode === 'primary',
              });
            }
          }
        } catch {
          // Cert provisioning failure is non-blocking — cert-manager annotation fallback
        }
      }
    }

    reply.status(201).send(success(route));
  });

  // PATCH /api/v1/clients/:clientId/domains/:domainId/routes/:routeId
  app.patch('/clients/:clientId/domains/:domainId/routes/:routeId', {
    onRequest: [authenticate, requireRole('super_admin', 'admin', 'client_admin'), requireClientAccess()],
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
    onRequest: [authenticate, requireRole('super_admin', 'admin', 'client_admin'), requireClientAccess()],
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
