import { eq, and } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { hostingPlans, clients } from '../../db/schema.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { createCacheMiddleware } from '../../middleware/cache.js';
import { createPlanSchema, updatePlanSchema } from '@k8s-hosting/api-contracts';

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
    const parsed = createPlanSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ApiError(
        'MISSING_REQUIRED_FIELD',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    const body = request.body as Record<string, unknown>;
    const id = crypto.randomUUID();
    await app.db.insert(hostingPlans).values({
      id,
      code: parsed.data.code,
      name: parsed.data.name,
      description: (body.description as string) ?? null,
      cpuLimit: parsed.data.cpu_limit,
      memoryLimit: parsed.data.memory_limit,
      storageLimit: parsed.data.storage_limit,
      monthlyPriceUsd: parsed.data.monthly_price_usd,
      maxSubUsers: (body.max_sub_users as number) ?? 3,
      maxMailboxes: (body.max_mailboxes as number) ?? 50,
      features: parsed.data.features ?? null,
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
    const parsed = updatePlanSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ApiError(
        'MISSING_REQUIRED_FIELD',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    const body = request.body as Record<string, unknown>;

    const [existing] = await app.db.select().from(hostingPlans).where(eq(hostingPlans.id, id));
    if (!existing) throw new ApiError('PLAN_NOT_FOUND', `Plan '${id}' not found`, 404);

    const updateValues: Record<string, unknown> = {};
    if (parsed.data.name !== undefined) updateValues.name = parsed.data.name;
    if (body.description !== undefined) updateValues.description = body.description;
    if (parsed.data.cpu_limit !== undefined) updateValues.cpuLimit = parsed.data.cpu_limit;
    if (parsed.data.memory_limit !== undefined) updateValues.memoryLimit = parsed.data.memory_limit;
    if (parsed.data.storage_limit !== undefined) updateValues.storageLimit = parsed.data.storage_limit;
    if (parsed.data.monthly_price_usd !== undefined) updateValues.monthlyPriceUsd = parsed.data.monthly_price_usd;
    if (body.max_sub_users !== undefined) updateValues.maxSubUsers = body.max_sub_users;
    if (body.max_mailboxes !== undefined) updateValues.maxMailboxes = body.max_mailboxes;
    if (parsed.data.features !== undefined) updateValues.features = parsed.data.features;
    if (body.status !== undefined) updateValues.status = body.status;

    if (Object.keys(updateValues).length > 0) {
      await app.db.update(hostingPlans).set(updateValues).where(eq(hostingPlans.id, id));
    }

    const [updated] = await app.db.select().from(hostingPlans).where(eq(hostingPlans.id, id));

    // Cascade K8s ResourceQuota to all provisioned clients on this plan
    // (only those without per-client overrides — overrides take precedence)
    if (parsed.data.cpu_limit !== undefined || parsed.data.memory_limit !== undefined || parsed.data.storage_limit !== undefined) {
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
