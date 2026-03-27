import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import { authenticate, requireRole, requireClientAccess } from '../../middleware/auth.js';
import { users } from '../../db/schema.js';
import { createClientSchema, updateClientSchema } from './schema.js';
import * as service from './service.js';
import { success, paginated } from '../../shared/response.js';
import { parsePaginationParams } from '../../shared/pagination.js';
import { ApiError } from '../../shared/errors.js';

export async function clientRoutes(app: FastifyInstance): Promise<void> {
  // All client routes require auth + admin role
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin', 'admin'));

  // POST /api/v1/clients
  app.post('/clients', {
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
  app.get('/clients/:id', async (request) => {
    const { id } = request.params as { id: string };
    const client = await service.getClientById(app.db, id);
    return success(client);
  });

  // PATCH /api/v1/clients/:id
  app.patch('/clients/:id', async (request) => {
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
  app.delete('/clients/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await service.deleteClient(app.db, id);
    return reply.status(204).send();
  });

  // ─── Impersonation ──────────────────────────────────────────────────────────

  // POST /api/v1/admin/impersonate/:clientId
  app.post('/admin/impersonate/:clientId', {
    onRequest: [authenticate, requireRole('super_admin', 'admin', 'support')],
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

  // GET /api/v1/clients/:clientId/users
  app.get('/clients/:clientId/users', {
    onRequest: [authenticate, requireRole('super_admin', 'admin', 'support', 'client_admin'), requireClientAccess()],
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };
    const clientUsers = await app.db
      .select({
        id: users.id,
        email: users.email,
        fullName: users.fullName,
        roleName: users.roleName,
        status: users.status,
        createdAt: users.createdAt,
        lastLoginAt: users.lastLoginAt,
      })
      .from(users)
      .where(eq(users.clientId, clientId));
    return success(clientUsers);
  });

  // POST /api/v1/clients/:clientId/users
  app.post('/clients/:clientId/users', {
    onRequest: [authenticate, requireRole('super_admin', 'admin', 'client_admin'), requireClientAccess()],
  }, async (request, reply) => {
    const { clientId } = request.params as { clientId: string };
    const body = request.body as { email: string; full_name: string; password: string };

    if (!body.email || !body.full_name || !body.password) {
      throw new ApiError('MISSING_REQUIRED_FIELD', 'email, full_name, and password are required', 400);
    }

    // Check sub-user limit from hosting plan
    const client = await service.getClientById(app.db, clientId);
    const existingUsers = await app.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.clientId, clientId));

    // Plan limit check (default 3 if no plan)
    const maxUsers = 10; // Default. Would check client.planId → hostingPlans.maxSubUsers in production
    if (existingUsers.length >= maxUsers) {
      throw new ApiError('SUB_USER_LIMIT', `Maximum ${maxUsers} users allowed for this plan`, 403);
    }

    const passwordHash = await bcrypt.hash(body.password, 12);
    const userId = crypto.randomUUID();

    await app.db.insert(users).values({
      id: userId,
      email: body.email,
      passwordHash,
      fullName: body.full_name,
      roleName: 'client_user',
      panel: 'client',
      clientId,
      status: 'active',
      emailVerifiedAt: new Date(),
    });

    const [created] = await app.db.select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      roleName: users.roleName,
      status: users.status,
      createdAt: users.createdAt,
    }).from(users).where(eq(users.id, userId));

    reply.status(201).send(success(created));
  });

  // DELETE /api/v1/clients/:clientId/users/:userId
  app.delete('/clients/:clientId/users/:userId', {
    onRequest: [authenticate, requireRole('super_admin', 'admin', 'client_admin'), requireClientAccess()],
  }, async (request, reply) => {
    const { clientId, userId } = request.params as { clientId: string; userId: string };

    const [user] = await app.db
      .select()
      .from(users)
      .where(and(eq(users.id, userId), eq(users.clientId, clientId)));

    if (!user) {
      throw new ApiError('USER_NOT_FOUND', 'User not found', 404);
    }

    // Don't allow deleting the last client_admin
    if (user.roleName === 'client_admin') {
      const admins = await app.db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.clientId, clientId), eq(users.roleName, 'client_admin')));
      if (admins.length <= 1) {
        throw new ApiError('LAST_ADMIN', 'Cannot delete the last client admin', 403);
      }
    }

    await app.db.delete(users).where(eq(users.id, userId));
    reply.status(204).send();
  });
}
