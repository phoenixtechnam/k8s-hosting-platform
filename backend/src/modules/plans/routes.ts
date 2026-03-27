import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { hostingPlans } from '../../db/schema.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';

export async function planRoutes(app: FastifyInstance) {
  // GET /api/v1/plans — public, no auth
  app.get('/plans', async () => {
    const rows = await app.db.select().from(hostingPlans);
    return { data: rows };
  });

  // POST /api/v1/admin/plans
  app.post('/admin/plans', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
  }, async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    if (!body.code || !body.name || !body.cpu_limit || !body.memory_limit || !body.storage_limit || !body.monthly_price_usd) {
      throw new ApiError('MISSING_REQUIRED_FIELD', 'code, name, cpu_limit, memory_limit, storage_limit, monthly_price_usd are required', 400);
    }

    const id = crypto.randomUUID();
    await app.db.insert(hostingPlans).values({
      id,
      code: body.code as string,
      name: body.name as string,
      description: (body.description as string) ?? null,
      cpuLimit: String(body.cpu_limit),
      memoryLimit: String(body.memory_limit),
      storageLimit: String(body.storage_limit),
      monthlyPriceUsd: String(body.monthly_price_usd),
      maxSubUsers: (body.max_sub_users as number) ?? 3,
      features: (body.features as Record<string, unknown>) ?? null,
      status: 'active',
    });

    const [created] = await app.db.select().from(hostingPlans).where(eq(hostingPlans.id, id));
    reply.status(201).send(success(created));
  });

  // PATCH /api/v1/admin/plans/:id
  app.patch('/admin/plans/:id', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
  }, async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, unknown>;

    const [existing] = await app.db.select().from(hostingPlans).where(eq(hostingPlans.id, id));
    if (!existing) throw new ApiError('PLAN_NOT_FOUND', `Plan '${id}' not found`, 404);

    const updateValues: Record<string, unknown> = {};
    if (body.name !== undefined) updateValues.name = body.name;
    if (body.description !== undefined) updateValues.description = body.description;
    if (body.cpu_limit !== undefined) updateValues.cpuLimit = String(body.cpu_limit);
    if (body.memory_limit !== undefined) updateValues.memoryLimit = String(body.memory_limit);
    if (body.storage_limit !== undefined) updateValues.storageLimit = String(body.storage_limit);
    if (body.monthly_price_usd !== undefined) updateValues.monthlyPriceUsd = String(body.monthly_price_usd);
    if (body.max_sub_users !== undefined) updateValues.maxSubUsers = body.max_sub_users;
    if (body.features !== undefined) updateValues.features = body.features;
    if (body.status !== undefined) updateValues.status = body.status;

    if (Object.keys(updateValues).length > 0) {
      await app.db.update(hostingPlans).set(updateValues).where(eq(hostingPlans.id, id));
    }

    const [updated] = await app.db.select().from(hostingPlans).where(eq(hostingPlans.id, id));
    return success(updated);
  });

  // DELETE /api/v1/admin/plans/:id — soft delete (set to deprecated)
  app.delete('/admin/plans/:id', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const [existing] = await app.db.select().from(hostingPlans).where(eq(hostingPlans.id, id));
    if (!existing) throw new ApiError('PLAN_NOT_FOUND', `Plan '${id}' not found`, 404);

    await app.db.update(hostingPlans).set({ status: 'deprecated' }).where(eq(hostingPlans.id, id));
    reply.status(204).send();
  });
}
