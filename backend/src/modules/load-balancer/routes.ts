import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import {
  getLoadBalancerStatus,
  updateLoadBalancerSettings,
  type LoadBalancerSettings,
} from './service.js';

export async function loadBalancerRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
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
  // Body: { enabled?, provider?, config? }
  // Backend validates the HA gate when enabled=true is requested; a
  // stale UI toggle that doesn't know a server just went offline
  // gets a 409 here instead of a silently-broken LB.
  app.patch('/admin/load-balancer', {
    schema: {
      tags: ['LoadBalancer'],
      summary: 'Update LB settings (gated on cluster HA state)',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const body = (request.body ?? {}) as Partial<LoadBalancerSettings>;
    if (typeof body.enabled !== 'undefined' && typeof body.enabled !== 'boolean') {
      throw new ApiError('INVALID_FIELD_VALUE', 'enabled must be boolean', 400, { field: 'enabled' });
    }
    if (typeof body.provider !== 'undefined' && typeof body.provider !== 'string') {
      throw new ApiError('INVALID_FIELD_VALUE', 'provider must be string', 400, { field: 'provider' });
    }
    if (typeof body.config !== 'undefined' && (typeof body.config !== 'object' || body.config === null || Array.isArray(body.config))) {
      throw new ApiError('INVALID_FIELD_VALUE', 'config must be an object', 400, { field: 'config' });
    }
    await updateLoadBalancerSettings(app.db, body);
    const status = await getLoadBalancerStatus(app.db);
    return success(status);
  });
}
