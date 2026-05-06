/**
 * Manual DKIM rotation route.
 *
 * Endpoint:
 *   POST /api/v1/clients/:clientId/email-domains/:domainId/dkim/rotate
 *
 * Auth: client_admin (the owner of the client) OR platform admin.
 * Audit: each rotation logs to the existing audit_log via the
 * standard request lifecycle hook.
 *
 * Idempotency: NOT idempotent — re-running creates a NEW DkimSignature
 * row each time. The client-panel UI requires a confirmation modal
 * to prevent accidental fan-out.
 */

import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { emailDomains, domains } from '../../db/schema.js';
import { rotateDkimKey, DkimRotationError } from './rotate.js';

interface RouteParams {
  readonly clientId: string;
  readonly domainId: string;
}

export async function emailDkimRotateRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: RouteParams }>(
    '/clients/:clientId/email-domains/:domainId/dkim/rotate',
    {
      onRequest: [authenticate, requireRole('super_admin', 'admin', 'client_admin', 'support')],
    },
    async (request, reply) => {
      const { clientId, domainId } = request.params;

      // Authorization: client_admin must own the client. The
      // requireRole middleware lets all four through; we narrow with
      // an explicit check here so client_admin from client A can't
      // rotate keys for client B.
      const userClientId = (request.user as { clientId?: string } | undefined)?.clientId;
      const userRole = (request.user as { role?: string } | undefined)?.role;
      if (userRole === 'client_admin' && userClientId !== clientId) {
        throw new ApiError(
          'FORBIDDEN',
          'You can only rotate DKIM keys for your own client',
          403,
        );
      }

      // Verify the email-domain belongs to this client (via its parent
      // domain). Otherwise an admin could mis-target a domain by ID.
      const [row] = await app.db
        .select({
          edId: emailDomains.id,
          domainName: domains.domainName,
          parentClientId: domains.clientId,
        })
        .from(emailDomains)
        .innerJoin(domains, eq(domains.id, emailDomains.domainId))
        .where(and(eq(emailDomains.id, domainId), eq(domains.clientId, clientId)));

      if (!row) {
        throw new ApiError(
          'EMAIL_DOMAIN_NOT_FOUND',
          `Email domain '${domainId}' not found for client '${clientId}'`,
          404,
        );
      }

      const encryptionKey = process.env.ENCRYPTION_KEY;
      if (!encryptionKey) {
        throw new ApiError(
          'INTERNAL_SERVER_ERROR',
          'ENCRYPTION_KEY env var is not set',
          500,
        );
      }

      try {
        const result = await rotateDkimKey(app.db, domainId, encryptionKey);
        return success(result);
      } catch (err) {
        if (err instanceof DkimRotationError) {
          throw new ApiError(
            err.code,
            err.message,
            err.code === 'EMAIL_DOMAIN_NOT_FOUND' ? 404 :
              err.code === 'EMAIL_DOMAIN_NOT_PROVISIONED' ? 409 :
                502,
          );
        }
        throw err;
      }
    },
  );
}
