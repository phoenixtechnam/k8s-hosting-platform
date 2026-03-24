import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { updateSubscriptionSchema } from './schema.js';
import * as service from './service.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';

export async function subscriptionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('admin', 'billing'));

  // GET /api/v1/clients/:id/subscription
  app.get('/clients/:id/subscription', async (request) => {
    const { id } = request.params as { id: string };
    const subscription = await service.getSubscription(app.db, id);
    return success(subscription);
  });

  // PATCH /api/v1/clients/:id/subscription
  app.patch('/clients/:id/subscription', async (request) => {
    const { id } = request.params as { id: string };
    const parsed = updateSubscriptionSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }
    const updated = await service.updateSubscription(app.db, id, parsed.data);
    return success(updated);
  });
}
