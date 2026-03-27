import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../middleware/auth.js';
import { markNotificationsReadSchema } from '@k8s-hosting/api-contracts';
import * as service from './service.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';

export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);

  // GET /api/v1/notifications
  app.get('/notifications', async (request) => {
    const query = request.query as Record<string, unknown>;
    const limit = query.limit ? Math.min(Number(query.limit), 100) : 20;
    const unreadOnly = query.unread_only === 'true' || query.unread_only === '1';

    const data = await service.listNotifications(app.db, request.user!.sub, { limit, unreadOnly });
    return success(data);
  });

  // GET /api/v1/notifications/unread-count
  app.get('/notifications/unread-count', async (request) => {
    const count = await service.getUnreadCount(app.db, request.user!.sub);
    return success({ count });
  });

  // POST /api/v1/notifications/mark-read
  app.post('/notifications/mark-read', async (request) => {
    const parsed = markNotificationsReadSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    await service.markAsRead(app.db, request.user!.sub, parsed.data.ids);
    return success({ updated: parsed.data.ids.length });
  });

  // DELETE /api/v1/notifications/:id
  app.delete('/notifications/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await service.deleteNotification(app.db, request.user!.sub, id);
    reply.status(204).send();
  });
}
