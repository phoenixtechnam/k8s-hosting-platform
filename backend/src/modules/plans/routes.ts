import { eq, and } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { hostingPlans, clients } from '../../db/schema.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { createCacheMiddleware } from '../../middleware/cache.js';

export async function planRoutes(app: FastifyInstance) {
  // GET /api/v1/plans — public, no auth
  app.get('/plans', { preHandler: createCacheMiddleware(300_000) }, async () => {
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
      maxMailboxes: (body.max_mailboxes as number) ?? 50,
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
    if (body.max_mailboxes !== undefined) updateValues.maxMailboxes = body.max_mailboxes;
    if (body.features !== undefined) updateValues.features = body.features;
    if (body.status !== undefined) updateValues.status = body.status;

    if (Object.keys(updateValues).length > 0) {
      await app.db.update(hostingPlans).set(updateValues).where(eq(hostingPlans.id, id));
    }

    const [updated] = await app.db.select().from(hostingPlans).where(eq(hostingPlans.id, id));

    // Cascade K8s ResourceQuota to all provisioned clients on this plan
    // (only those without per-client overrides — overrides take precedence)
    if (body.cpu_limit !== undefined || body.memory_limit !== undefined || body.storage_limit !== undefined) {
      try {
        const { createK8sClients } = await import('../k8s-provisioner/k8s-client.js');
        const { applyResourceQuota } = await import('../k8s-provisioner/service.js');
        const k8s = createK8sClients((app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined);

        // Find all provisioned clients on this plan without resource overrides
        const affectedClients = await app.db.select().from(clients)
          .where(and(
            eq(clients.planId, id),
            eq(clients.provisioningStatus, 'provisioned'),
          ));

        for (const client of affectedClients) {
          try {
            await applyResourceQuota(k8s, client.kubernetesNamespace, {
              cpu: String(client.cpuLimitOverride ?? updated.cpuLimit),
              memory: String(client.memoryLimitOverride ?? updated.memoryLimit),
              storage: String(client.storageLimitOverride ?? updated.storageLimit),
            });
          } catch (err) {
            console.warn(`[plans] Failed to sync quota for client ${client.id}:`, err instanceof Error ? err.message : String(err));
          }
        }

        console.log(`[plans] Synced ResourceQuota for ${affectedClients.length} clients on plan ${id}`);
      } catch (err) {
        console.warn('[plans] Failed to cascade quota update:', err instanceof Error ? err.message : String(err));
      }
    }

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
