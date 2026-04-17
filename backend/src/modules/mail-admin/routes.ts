/**
 * mail-admin proxy routes.
 *
 *   GET /admin/mail/metrics       →  Stalwart Prometheus output, parsed
 *                                    + summarized into a small JSON
 *                                    shape the admin UI can render as
 *                                    cards.
 *   GET /admin/mail/queue         →  Stalwart admin API queue contents
 *                                    (per-envelope drill-down for
 *                                    stuck-message debugging).
 *   GET /admin/mail/webadmin-url  →  URL + suggested username for the
 *                                    Stalwart web-admin UI, so the
 *                                    admin panel can open it in a new
 *                                    tab. Password is deliberately NOT
 *                                    returned (ops delivers it, or the
 *                                    browser remembers after first login).
 */

import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import * as service from './service.js';
import { buildWebadminUrl } from './webadmin-url.js';

export async function mailAdminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin', 'admin', 'support'));

  app.get('/admin/mail/metrics', async () => {
    try {
      const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
      const result = await service.getMailMetrics(kubeconfigPath);
      return success(result);
    } catch (err) {
      // Log full error server-side; return a fixed generic message
      // to the client so we don't leak pod names, exec args,
      // cluster addressing, or stalwart-cli internals.
      app.log.warn({ err }, 'mail-admin: metrics fetch failed');
      throw new ApiError(
        'STALWART_METRICS_UNAVAILABLE',
        'Could not fetch Stalwart metrics — see server logs',
        503,
      );
    }
  });

  app.get('/admin/mail/webadmin-url', async () => {
    const cfg = app.config as Record<string, unknown>;
    try {
      const result = buildWebadminUrl({
        ingressBaseDomain: cfg.INGRESS_BASE_DOMAIN as string | undefined,
        platformEnv: cfg.PLATFORM_ENV as string | undefined,
        explicitUrl: process.env.STALWART_WEBADMIN_URL,
        explicitUsername: process.env.STALWART_WEBADMIN_USERNAME,
      });
      return success(result);
    } catch (err) {
      app.log.warn({ err }, 'mail-admin: webadmin-url build failed');
      throw new ApiError(
        'STALWART_WEBADMIN_NOT_CONFIGURED',
        'Stalwart web-admin URL is not configured on this platform.',
        503,
      );
    }
  });

  app.get('/admin/mail/queue', async () => {
    try {
      const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
      const result = await service.getMailQueue(kubeconfigPath);
      if (result.status >= 400) {
        throw new ApiError(
          'STALWART_QUEUE_ERROR',
          'Stalwart queue API returned an error — see server logs',
          502,
        );
      }
      return success(result.raw);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      // Same generic-message principle as the metrics route.
      app.log.warn({ err }, 'mail-admin: queue fetch failed');
      throw new ApiError(
        'STALWART_QUEUE_UNAVAILABLE',
        'Could not fetch Stalwart queue — see server logs',
        503,
      );
    }
  });
}
