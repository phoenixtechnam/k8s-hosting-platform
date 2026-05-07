import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { updatePlatformUrlsSchema } from '@k8s-hosting/api-contracts';
import type { ZodError } from 'zod';
import * as service from './service.js';

function zodMessage(err: ZodError): string {
  return err.issues
    .map((i) => {
      const path = i.path.length > 0 ? `${i.path.join('.')}: ` : '';
      return `${path}${i.message}`;
    })
    .join('; ');
}

export async function platformUrlsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin', 'admin'));

  // GET /api/v1/admin/platform-urls — resolved URLs + apex + defaults.
  // Consumed by the admin panel on every page load that needs to embed
  // Longhorn / Stalwart / webmail. TanStack Query caches the response so
  // the network cost is one call per session + invalidation on PATCH.
  app.get('/admin/platform-urls', async () => {
    const result = await service.getPlatformUrls(app.db);
    return success(result);
  });

  // PATCH /api/v1/admin/platform-urls
  //
  // Body: { longhornUrl?: string | null, stalwartAdminUrl?: ..., ... }
  //   - undefined → field unchanged
  //   - null      → reset to default (row deleted, apex-derived value used)
  //   - string    → set (URL/FQDN validated by Zod before the service
  //                 touches the DB)
  app.patch('/admin/platform-urls', async (request) => {
    const parsed = updatePlatformUrlsSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', zodMessage(parsed.error), 400);
    }
    // 2026-05-07: same install-time-only constraint as the
    // /admin/webmail-settings endpoint — Stalwart's Bootstrap
    // singleton locks serverHostname post-install, and silently
    // accepting a runtime rename here would leave the cluster
    // half-migrated. Reject with a clear pointer to the rename
    // runbook.
    if (parsed.data.mailServerHostname !== undefined) {
      throw new ApiError(
        'MAIL_HOSTNAME_IMMUTABLE',
        'Mail server hostname is fixed at install time. See the rename runbook for the snapshot+rebootstrap maintenance procedure.',
        400,
        { field: 'mailServerHostname' },
      );
    }
    await service.updatePlatformUrls(app.db, parsed.data);
    const result = await service.getPlatformUrls(app.db);
    return success(result);
  });
}
