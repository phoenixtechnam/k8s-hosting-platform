import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requireClientAccess } from '../../middleware/auth.js';
import { createMailboxSchema, updateMailboxSchema, mailboxAccessSchema } from '@k8s-hosting/api-contracts';
import { mailboxes } from '../../db/schema.js';
import * as service from './service.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import type { JwtPayload } from '../../middleware/auth.js';

export async function mailboxRoutes(app: FastifyInstance): Promise<void> {
  // ─── Client-scoped mailbox CRUD ───

  app.register(async (clientScope) => {
    clientScope.addHook('onRequest', authenticate);
    clientScope.addHook('onRequest', requireClientAccess());

    // POST /api/v1/clients/:clientId/email/domains/:emailDomainId/mailboxes
    clientScope.post('/clients/:clientId/email/domains/:emailDomainId/mailboxes', {
      onRequest: [requireRole('super_admin', 'admin', 'client_admin')],
    }, async (request, reply) => {
      const { clientId, emailDomainId } = request.params as { clientId: string; emailDomainId: string };
      const parsed = createMailboxSchema.safeParse(request.body);
      if (!parsed.success) {
        const firstError = parsed.error.errors[0];
        throw new ApiError(
          'MISSING_REQUIRED_FIELD',
          `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
          400,
          { field: firstError.path.join('.') },
        );
      }

      const created = await service.createMailbox(app.db, clientId, emailDomainId, parsed.data);
      reply.status(201).send(success(created));
    });

    // GET /api/v1/clients/:clientId/mailboxes
    clientScope.get('/clients/:clientId/mailboxes', {
      onRequest: [requireRole('super_admin', 'admin', 'support', 'client_admin', 'client_user')],
    }, async (request) => {
      const { clientId } = request.params as { clientId: string };
      const query = request.query as Record<string, unknown>;
      const emailDomainId = typeof query.email_domain_id === 'string' ? query.email_domain_id : undefined;

      const data = await service.listMailboxes(app.db, clientId, emailDomainId);
      return success(data);
    });

    // GET /api/v1/clients/:clientId/mailboxes/:id
    clientScope.get('/clients/:clientId/mailboxes/:id', {
      onRequest: [requireRole('super_admin', 'admin', 'support', 'client_admin')],
    }, async (request) => {
      const { clientId, id } = request.params as { clientId: string; id: string };
      const record = await service.getMailbox(app.db, clientId, id);
      return success(record);
    });

    // PATCH /api/v1/clients/:clientId/mailboxes/:id
    clientScope.patch('/clients/:clientId/mailboxes/:id', {
      onRequest: [requireRole('super_admin', 'admin', 'client_admin')],
    }, async (request) => {
      const { clientId, id } = request.params as { clientId: string; id: string };
      const parsed = updateMailboxSchema.safeParse(request.body);
      if (!parsed.success) {
        const firstError = parsed.error.errors[0];
        throw new ApiError(
          'MISSING_REQUIRED_FIELD',
          `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
          400,
          { field: firstError.path.join('.') },
        );
      }

      const updated = await service.updateMailbox(app.db, clientId, id, parsed.data);
      return success(updated);
    });

    // DELETE /api/v1/clients/:clientId/mailboxes/:id
    clientScope.delete('/clients/:clientId/mailboxes/:id', {
      onRequest: [requireRole('super_admin', 'admin', 'client_admin')],
    }, async (request, reply) => {
      const { clientId, id } = request.params as { clientId: string; id: string };
      await service.deleteMailbox(app.db, clientId, id);
      reply.status(204).send();
    });

    // ─── Access management ───

    // GET /api/v1/clients/:clientId/mailboxes/:id/access
    clientScope.get('/clients/:clientId/mailboxes/:id/access', {
      onRequest: [requireRole('super_admin', 'admin', 'client_admin')],
    }, async (request) => {
      const { clientId, id } = request.params as { clientId: string; id: string };
      // Verify mailbox belongs to client
      await service.getMailbox(app.db, clientId, id);
      const rows = await service.listMailboxAccess(app.db, id);
      return success(rows);
    });

    // POST /api/v1/clients/:clientId/mailboxes/:id/access
    clientScope.post('/clients/:clientId/mailboxes/:id/access', {
      onRequest: [requireRole('super_admin', 'admin', 'client_admin')],
    }, async (request, reply) => {
      const { clientId, id } = request.params as { clientId: string; id: string };
      const parsed = mailboxAccessSchema.safeParse(request.body);
      if (!parsed.success) {
        const firstError = parsed.error.errors[0];
        throw new ApiError(
          'MISSING_REQUIRED_FIELD',
          `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
          400,
          { field: firstError.path.join('.') },
        );
      }

      // Verify mailbox belongs to client
      await service.getMailbox(app.db, clientId, id);
      const created = await service.grantMailboxAccess(app.db, id, parsed.data.user_id, parsed.data.access_level);
      reply.status(201).send(success(created));
    });

    // DELETE /api/v1/clients/:clientId/mailboxes/:id/access/:userId
    clientScope.delete('/clients/:clientId/mailboxes/:id/access/:userId', {
      onRequest: [requireRole('super_admin', 'admin', 'client_admin')],
    }, async (request, reply) => {
      const { clientId, id, userId } = request.params as { clientId: string; id: string; userId: string };
      // Verify mailbox belongs to client
      await service.getMailbox(app.db, clientId, id);
      await service.revokeMailboxAccess(app.db, id, userId);
      reply.status(204).send();
    });
  });

  // ─── Webmail SSO (authenticated user, no client param) ───

  app.register(async (webmailScope) => {
    webmailScope.addHook('onRequest', authenticate);

    // POST /api/v1/email/webmail-token
    webmailScope.post('/email/webmail-token', async (request) => {
      const user = request.user as JwtPayload;
      const body = request.body as { mailbox_id?: string };

      if (!body.mailbox_id) {
        throw new ApiError('MISSING_REQUIRED_FIELD', 'Required field missing: mailbox_id', 400, { field: 'mailbox_id' });
      }

      const result = await service.generateWebmailToken(app, app.db, user.sub, body.mailbox_id);
      return success(result);
    });

    // GET /api/v1/email/accessible-mailboxes
    webmailScope.get('/email/accessible-mailboxes', async (request) => {
      const user = request.user as JwtPayload;

      if (!user.clientId) {
        throw new ApiError('CLIENT_REQUIRED', 'User must belong to a client to access mailboxes', 400);
      }

      const data = await service.getAccessibleMailboxes(app.db, user.sub, user.clientId);
      return success(data);
    });
  });

  // ─── Admin routes ───

  app.register(async (adminScope) => {
    adminScope.addHook('onRequest', authenticate);
    adminScope.addHook('onRequest', requireRole('super_admin', 'admin'));

    // GET /api/v1/admin/email/mailboxes
    adminScope.get('/admin/email/mailboxes', async () => {
      const rows = await app.db
        .select({
          id: mailboxes.id,
          emailDomainId: mailboxes.emailDomainId,
          clientId: mailboxes.clientId,
          localPart: mailboxes.localPart,
          fullAddress: mailboxes.fullAddress,
          displayName: mailboxes.displayName,
          quotaMb: mailboxes.quotaMb,
          usedMb: mailboxes.usedMb,
          status: mailboxes.status,
          mailboxType: mailboxes.mailboxType,
          autoReply: mailboxes.autoReply,
          createdAt: mailboxes.createdAt,
          updatedAt: mailboxes.updatedAt,
        })
        .from(mailboxes);

      return success(rows);
    });
  });
}
