import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { authenticate, requireRole, requireClientAccess } from '../../middleware/auth.js';
import { users } from '../../db/schema.js';
import { createClientSchema, updateClientSchema } from './schema.js';

/**
 * Phase 1: local Zod schema for the POST /clients/:clientId/users
 * body. Phase 2 will move this to @k8s-hosting/api-contracts as
 * `createSubUserSchema`.
 */
const createSubUserBodySchema = z.object({
  email: z.string().email('email must be a valid email address'),
  full_name: z.string().min(1, 'full_name is required').max(255),
  password: z.string().min(8, 'password must be at least 8 characters').max(255),
});
import * as service from './service.js';
import {
  listSubUsers,
  createSubUser,
  deleteSubUser,
  makeDrizzleSubUsersDb,
  getEffectiveMaxSubUsers,
} from './sub-users-service.js';
import { bulkUpdateClientStatus, bulkDeleteClients } from './bulk.js';
import { success, paginated } from '../../shared/response.js';
import { parsePaginationParams } from '../../shared/pagination.js';
import { ApiError } from '../../shared/errors.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { provisioningTasks } from '../../db/schema.js';
import { runProvisionNamespace, PROVISION_STEPS, buildStepsLog } from '../k8s-provisioner/service.js';

export async function clientRoutes(app: FastifyInstance): Promise<void> {
  // Lazy-init K8s clients (undefined if no kubeconfig available)
  const getK8s = () => {
    try {
      const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
      return createK8sClients(kubeconfigPath);
    } catch {
      return undefined;
    }
  };

  // Phase 1: the previous version applied
  // `requireRole('super_admin','admin')` as a plugin-wide hook
  // which short-circuited the permissive per-route hooks on the
  // sub-user routes (GET /clients/:clientId/users and friends).
  // That produced the "Failed to load users" 403 in the client
  // panel. We now install only `authenticate` plugin-wide, and
  // each route declares its own role list in `onRequest`.
  app.addHook('onRequest', authenticate);

  // POST /api/v1/clients
  app.post('/clients', {
    onRequest: [requireRole('super_admin', 'admin')],
    schema: {
      tags: ['Clients'],
      summary: 'Create a new client',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['company_name', 'company_email', 'plan_id', 'region_id'],
        properties: {
          company_name: { type: 'string', minLength: 1, maxLength: 255 },
          company_email: { type: 'string', format: 'email' },
          contact_email: { type: 'string', format: 'email' },
          plan_id: { type: 'string', format: 'uuid' },
          region_id: { type: 'string', format: 'uuid' },
          subscription_expires_at: { type: 'string', format: 'date-time' },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                companyName: { type: 'string' },
                companyEmail: { type: 'string' },
                status: { type: 'string' },
                createdAt: { type: 'string' },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const parsed = createClientSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ApiError(
        'MISSING_REQUIRED_FIELD',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    const result = await service.createClient(app.db, parsed.data, request.user.sub);
    const { _generatedPassword, _clientUserId, ...client } = result;

    // Auto-provision: trigger namespace provisioning in the background
    try {
      const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
      const k8sClients = createK8sClients(kubeconfigPath);
      if (k8sClients) {
        const taskId = crypto.randomUUID();
        await app.db.insert(provisioningTasks).values({
          id: taskId,
          clientId: client.id,
          type: 'provision_namespace',
          status: 'pending',
          totalSteps: PROVISION_STEPS.length,
          completedSteps: 0,
          stepsLog: buildStepsLog(PROVISION_STEPS),
          startedBy: request.user!.sub,
        });
        runProvisionNamespace(app.db, k8sClients, taskId, client.id, {}).catch((err) => {
          app.log.error({ err, taskId, clientId: client.id }, 'Auto-provisioning failed');
        });
      }
    } catch {
      // K8s not available — skip auto-provisioning
    }

    reply.status(201).send(success({
      ...client,
      clientUser: {
        id: _clientUserId,
        email: parsed.data.company_email,
        generatedPassword: _generatedPassword,
      },
    }));
  });

  // GET /api/v1/clients
  app.get('/clients', {
    onRequest: [requireRole('super_admin', 'admin')],
    schema: {
      tags: ['Clients'],
      summary: 'List clients with cursor-based pagination',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          cursor: { type: 'string', description: 'Opaque pagination cursor' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          search: { type: 'string', description: 'Search by company name or email' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  companyName: { type: 'string' },
                  companyEmail: { type: 'string' },
                  contactEmail: { type: ['string', 'null'] },
                  kubernetesNamespace: { type: 'string' },
                  planId: { type: 'string' },
                  regionId: { type: 'string' },
                  status: { type: 'string' },
                  createdBy: { type: ['string', 'null'] },
                  subscriptionExpiresAt: { type: ['string', 'null'] },
                  createdAt: { type: 'string' },
                  updatedAt: { type: 'string' },
                },
              },
            },
            pagination: {
              type: 'object',
              properties: {
                total_count: { type: 'integer' },
                cursor: { type: ['string', 'null'] },
                has_more: { type: 'boolean' },
                page_size: { type: 'integer' },
              },
            },
          },
        },
      },
    },
  }, async (request) => {
    const query = request.query as Record<string, unknown>;
    const paginationParams = parsePaginationParams(query);
    const search = typeof query.search === 'string' ? query.search : undefined;

    const result = await service.listClients(app.db, { ...paginationParams, search });
    return paginated(result.data, result.pagination);
  });

  // GET /api/v1/clients/:id
  app.get('/clients/:id', {
    onRequest: [requireRole('super_admin', 'admin')],
  }, async (request) => {
    const { id } = request.params as { id: string };
    const client = await service.getClientById(app.db, id);
    return success(client);
  });

  // PATCH /api/v1/clients/:id
  app.patch('/clients/:id', {
    onRequest: [requireRole('super_admin', 'admin')],
  }, async (request) => {
    const { id } = request.params as { id: string };
    const parsed = updateClientSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    const updated = await service.updateClient(app.db, id, parsed.data);
    return success(updated);
  });

  // DELETE /api/v1/clients/:id
  app.delete('/clients/:id', {
    onRequest: [requireRole('super_admin', 'admin')],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await service.deleteClient(app.db, id, getK8s());
    return reply.status(204).send();
  });

  // ─── Impersonation ──────────────────────────────────────────────────────────

  // POST /api/v1/admin/impersonate/:clientId
  app.post('/admin/impersonate/:clientId', {
    onRequest: [requireRole('super_admin', 'admin', 'support')],
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };

    // Verify client exists
    await service.getClientById(app.db, clientId);

    // Find the client_admin user for this client
    const [clientUser] = await app.db
      .select()
      .from(users)
      .where(
        and(
          eq(users.clientId, clientId),
          eq(users.roleName, 'client_admin'),
          eq(users.status, 'active'),
        ),
      )
      .limit(1);

    if (!clientUser) {
      throw new ApiError('NO_CLIENT_USER', 'No active client_admin user found for this client', 404);
    }

    // Issue a short-lived impersonation JWT
    const token = app.jwt.sign({
      sub: clientUser.id,
      role: 'client_admin',
      panel: 'client',
      clientId,
      impersonatedBy: request.user.sub,
      exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour
      iat: Math.floor(Date.now() / 1000),
      jti: crypto.randomUUID(),
    });

    return success({
      token,
      user: {
        id: clientUser.id,
        email: clientUser.email,
        fullName: clientUser.fullName,
        role: 'client_admin',
        panel: 'client',
        clientId,
      },
      impersonatedBy: request.user.sub,
      expiresIn: 3600,
    });
  });

  // ─── Client Sub-Users ───────────────────────────────────────────────────────

  // GET /api/v1/clients/:clientId/users — readable by the client themselves
  // (client_admin + client_user) plus staff roles. Scoped via
  // requireClientAccess() so client-panel tokens can only see their
  // own team.
  app.get('/clients/:clientId/users', {
    onRequest: [
      requireRole('super_admin', 'admin', 'support', 'client_admin', 'client_user'),
      requireClientAccess(),
    ],
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };
    const clientUsers = await listSubUsers(makeDrizzleSubUsersDb(app.db), clientId);
    return success(clientUsers);
  });

  // POST /api/v1/clients/:clientId/users — create a sub-user.
  // Only client_admin + staff can mutate the team.
  app.post('/clients/:clientId/users', {
    onRequest: [
      requireRole('super_admin', 'admin', 'client_admin'),
      requireClientAccess(),
    ],
  }, async (request, reply) => {
    const { clientId } = request.params as { clientId: string };

    const parsed = createSubUserBodySchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ApiError(
        firstError.path.length > 0 ? 'INVALID_FIELD_VALUE' : 'MISSING_REQUIRED_FIELD',
        `Validation error: ${firstError.message}${firstError.path.length > 0 ? ` (${firstError.path.join('.')})` : ''}`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    // Verify client exists (preserves CLIENT_NOT_FOUND behavior)
    await service.getClientById(app.db, clientId);

    const maxSubUsers = await getEffectiveMaxSubUsers(app.db, clientId);
    const created = await createSubUser(
      makeDrizzleSubUsersDb(app.db),
      clientId,
      parsed.data,
      { maxSubUsers },
    );

    reply.status(201).send(success(created));
  });

  // DELETE /api/v1/clients/:clientId/users/:userId
  app.delete('/clients/:clientId/users/:userId', {
    onRequest: [
      requireRole('super_admin', 'admin', 'client_admin'),
      requireClientAccess(),
    ],
  }, async (request, reply) => {
    const { clientId, userId } = request.params as { clientId: string; userId: string };
    await deleteSubUser(makeDrizzleSubUsersDb(app.db), clientId, userId);
    reply.status(204).send();
  });

  // ─── Bulk Operations ────────────────────────────────────────────────────────

  // POST /api/v1/admin/clients/bulk
  app.post('/admin/clients/bulk', {
    onRequest: [requireRole('super_admin', 'admin')],
  }, async (request) => {
    const body = request.body as { client_ids?: string[]; action?: string };

    if (!Array.isArray(body.client_ids) || !body.action) {
      throw new ApiError('MISSING_REQUIRED_FIELD', 'client_ids (array) and action are required', 400);
    }

    if (body.action !== 'suspend' && body.action !== 'reactivate') {
      throw new ApiError('INVALID_FIELD_VALUE', "action must be 'suspend' or 'reactivate'", 400, { field: 'action' });
    }

    const result = await bulkUpdateClientStatus(app.db, body.client_ids, body.action);
    return success(result);
  });

  // DELETE /api/v1/admin/clients/bulk
  app.delete('/admin/clients/bulk', {
    onRequest: [requireRole('super_admin')],
  }, async (request, reply) => {
    const body = request.body as { client_ids?: string[] };

    if (!Array.isArray(body.client_ids) || body.client_ids.length === 0) {
      throw new ApiError('MISSING_REQUIRED_FIELD', 'client_ids (non-empty array) is required', 400);
    }

    const result = await bulkDeleteClients(app.db, body.client_ids, getK8s());
    return success(result);
  });
}
