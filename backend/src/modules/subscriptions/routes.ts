import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requireClientAccess } from '../../middleware/auth.js';
import { updateSubscriptionSchema } from './schema.js';
import * as service from './service.js';
import { suspendExpiredClients } from './expiry-checker.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';

export async function subscriptionRoutes(app: FastifyInstance): Promise<void> {
  // Round-4 Phase C: the previous incarnation applied
  // `requireRole('super_admin','admin','billing')` as a hook to
  // the whole plugin, which locked client_admin / client_user
  // out of viewing their own subscription info. The Settings page
  // in the client panel therefore showed an empty "—" placeholder.
  //
  // We now split the hooks per-route:
  //   GET .../subscription  → readable by client_admin + client_user
  //                           scoped to the authenticated client's id
  //                           via requireClientAccess()
  //   PATCH .../subscription → admin-only (billing role + above)
  //   POST /admin/check-expiry → admin-only
  app.addHook('onRequest', authenticate);

  // GET /api/v1/clients/:id/subscription — readable by the client
  // themselves (via requireClientAccess) plus staff roles.
  app.get('/clients/:id/subscription', {
    onRequest: [
      requireRole('super_admin', 'admin', 'billing', 'support', 'client_admin', 'client_user'),
      requireClientAccess(),
    ],
  }, async (request) => {
    const { id } = request.params as { id: string };
    const subscription = await service.getSubscription(app.db, id);
    return success(subscription);
  });

  // PATCH /api/v1/clients/:id/subscription — admin + billing only.
  app.patch('/clients/:id/subscription', {
    onRequest: [requireRole('super_admin', 'admin', 'billing')],
  }, async (request) => {
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

  // POST /api/v1/admin/check-expiry — manually trigger subscription expiry check
  app.post('/admin/check-expiry', {
    onRequest: [requireRole('super_admin', 'admin')],
  }, async () => {
    const suspendedCount = await suspendExpiredClients(app.db);
    return success({ suspended_count: suspendedCount });
  });
}
