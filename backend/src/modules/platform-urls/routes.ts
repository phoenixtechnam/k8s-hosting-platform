import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { updatePlatformUrlsSchema } from '@k8s-hosting/api-contracts';
import type { ZodError } from 'zod';
import * as service from './service.js';
import {
  applyMailServerHostnameToStalwart,
  withMailHostnameLock,
} from '../webmail-settings/service.js';
import { auditLogs } from '../../db/schema.js';
import crypto from 'node:crypto';

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
    // 2026-05-09: mailServerHostname is editable post-bootstrap via
    // SystemSettings.defaultHostname. Push to Stalwart first; if
    // Stalwart accepts, persist to platform_urls. If Stalwart rejects
    // (validation / missing Domain / network), fail loudly without
    // updating the DB row — see the matching comment block in
    // backend/src/modules/webmail-settings/routes.ts for the full
    // rationale + operator-side caveats (cert SAN, DNS, rDNS).
    // Hostname change is serialized via the advisory lock so two
    // concurrent PATCHes can't apply different hostnames in
    // interleaved order (Stalwart-A → Stalwart-B → DB-B → DB-A).
    let stalwartHostnameUpdate:
      | { defaultDomainId: string; previousHostname: string }
      | undefined;
    const result = await withMailHostnameLock(app.db, async () => {
      if (
        parsed.data.mailServerHostname !== undefined &&
        parsed.data.mailServerHostname !== null
      ) {
        try {
          const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as
            | string
            | undefined;
          stalwartHostnameUpdate = await applyMailServerHostnameToStalwart(
            kubeconfigPath,
            parsed.data.mailServerHostname,
          );
        } catch (err) {
          throw new ApiError(
            'MAIL_HOSTNAME_APPLY_FAILED',
            `Failed to update Stalwart's defaultHostname: ${
              err instanceof Error ? err.message : String(err)
            }. The platform-urls DB row was NOT updated to keep it consistent with the live server.`,
            502,
            { field: 'mailServerHostname' },
          );
        }
      }
      await service.updatePlatformUrls(app.db, parsed.data);
      return service.getPlatformUrls(app.db);
    });

    if (stalwartHostnameUpdate && parsed.data.mailServerHostname) {
      // Forensic audit trail — see matching block in
      // backend/src/modules/webmail-settings/routes.ts. Failure to
      // record the audit row is logged but doesn't fail the request.
      try {
        await app.db.insert(auditLogs).values({
          id: crypto.randomUUID(),
          actorId: (request.user as { sub?: string } | undefined)?.sub ?? 'system',
          actorType: 'user',
          actionType: 'platform_settings.mail_hostname_rename',
          resourceType: 'platform_settings',
          resourceId: 'mail_server_hostname',
          changes: {
            previousHostname: stalwartHostnameUpdate.previousHostname,
            newHostname: parsed.data.mailServerHostname,
            defaultDomainId: stalwartHostnameUpdate.defaultDomainId,
            via: 'platform-urls',
          } as unknown as Record<string, unknown>,
        });
      } catch (err) {
        app.log.error(
          { err, newHostname: parsed.data.mailServerHostname },
          'mail-server-hostname (platform-urls): audit_logs insert failed after successful Stalwart apply',
        );
      }
    }

    return success(result);
  });
}
