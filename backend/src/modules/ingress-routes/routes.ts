import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requireClientAccess } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import {
  createRoute,
  updateRoute,
  deleteRoute,
  listRoutesForDomain,
  getIngressSettings,
  updateIngressSettings,
} from './service.js';
import { createIngressRouteSchema, updateIngressRouteSchema } from '@k8s-hosting/api-contracts';

export async function ingressRouteRoutes(app: FastifyInstance): Promise<void> {
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

    const route = await createRoute(app.db, domainId, clientId, parsed.data.hostname, parsed.data.workload_id);
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
    const { routeId } = request.params as { routeId: string };
    const parsed = updateIngressRouteSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', parsed.error.errors[0].message, 400);
    }

    const updated = await updateRoute(app.db, routeId, {
      workloadId: parsed.data.workload_id,
      tlsMode: parsed.data.tls_mode,
      nodeHostname: parsed.data.node_hostname,
    });
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
    const { routeId } = request.params as { routeId: string };
    await deleteRoute(app.db, routeId);
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
