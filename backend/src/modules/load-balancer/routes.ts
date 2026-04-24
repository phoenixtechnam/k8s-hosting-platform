import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requirePanel } from '../../middleware/auth.js';
import { updateLoadBalancerSchema } from '@k8s-hosting/api-contracts';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import {
  getLoadBalancerStatus,
  updateLoadBalancerSettings,
} from './service.js';

export async function loadBalancerRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requirePanel('admin'));
  app.addHook('onRequest', requireRole('super_admin', 'admin'));

  // GET /api/v1/admin/load-balancer — current settings + HA gate.
  app.get('/admin/load-balancer', {
    schema: {
      tags: ['LoadBalancer'],
      summary: 'Get LB settings and HA gate status',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const status = await getLoadBalancerStatus(app.db);
    return success(status);
  });

  // PATCH /api/v1/admin/load-balancer — flip enabled, change provider, update config.
  //
  // Body validated by updateLoadBalancerSchema — rejects any
  // provider outside the enum, caps config JSON at 32 KB serialised,
  // blocks __proto__ / constructor / prototype keys.
  app.patch('/admin/load-balancer', {
    schema: {
      tags: ['LoadBalancer'],
      summary: 'Update LB settings (gated on cluster HA state)',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const parsed = updateLoadBalancerSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${first.message} (${first.path.join('.')})`,
        400,
        { field: first.path.join('.') },
      );
    }
    await updateLoadBalancerSettings(app.db, parsed.data);
    const status = await getLoadBalancerStatus(app.db);
    return success(status);
  });
}
