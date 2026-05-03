/**
 * mail-admin routes.
 *
 *   GET  /admin/mail/metrics               →  Stalwart prometheus metrics
 *                                             parsed into a small JSON card
 *                                             shape.
 *   GET  /admin/mail/queue                 →  Stalwart admin API queue
 *                                             contents (per-envelope drill-
 *                                             down for stuck messages).
 *   GET  /admin/mail/stalwart-credentials  →  {username, password} for the
 *                                             fallback-admin, so the admin
 *                                             UI can reveal + copy them.
 *                                             Gated to super_admin/admin/
 *                                             support (same as other routes).
 *   POST /admin/mail/rotate-admin-password →  (Stalwart 0.16) Generate a fresh
 *                                             password, call JMAP Principal/set
 *                                             to update the admin principal's
 *                                             secret in-flight (no Stalwart
 *                                             restart needed), then patch the
 *                                             stalwart-admin-creds k8s Secret
 *                                             mirror. super_admin only.
 *                                             Alias: rotate-stalwart-password
 *                                             (kept for back-compat).
 */

import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import * as service from './service.js';
import { readStalwartCredentials } from './credentials.js';
import { rotateAdminPasswordViaJmap } from './rotate-jmap.js';

export async function mailAdminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin', 'admin', 'support'));
  // Note: routes that expose the cleartext Stalwart admin password
  // (`/admin/mail/stalwart-credentials` and `/admin/mail/rotate-*`) carry
  // their own narrower preHandler — see below.

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

  // Security review HIGH-2 fix (2026-05-03): scope to super_admin only.
  // `support` and `admin` previously inherited the route-wide gate but
  // these are lower-privilege roles that should not see Stalwart's
  // cleartext admin password (which would let them bypass platform
  // audit trails by talking to Stalwart's JMAP/web-admin directly).
  app.get('/admin/mail/stalwart-credentials', { preHandler: requireRole('super_admin') }, async (req) => {
    try {
      return success(readStalwartCredentials(process.env));
    } catch (err) {
      // Audit the *attempt*, not the creds.
      app.log.warn({ err, userId: req.user?.sub }, 'mail-admin: stalwart-credentials read failed');
      throw new ApiError(
        'STALWART_CREDENTIALS_UNAVAILABLE',
        'Stalwart admin credentials are not configured on this platform.',
        503,
      );
    }
  });

  // Stalwart 0.16: JMAP-backed admin password rotation.
  // New canonical route name. No Stalwart StatefulSet restart required —
  // JMAP Principal/set updates the admin secret in-flight.
  const handleRotateAdminPassword = async (req: { user?: { sub?: string } }) => {
    const cfg = app.config as Record<string, unknown>;
    const userId = req.user?.sub ?? 'unknown';
    app.log.warn({ userId }, 'mail-admin: rotate-admin-password requested (JMAP)');
    try {
      const result = await rotateAdminPasswordViaJmap({
        kubeconfigPath: cfg.KUBECONFIG_PATH as string | undefined,
        stalwartNamespace: 'mail',
        secretName: 'stalwart-admin-creds',
        username: readStalwartCredentials(process.env).username,
      });
      app.log.warn({ userId, rotatedAt: result.rotatedAt }, 'mail-admin: rotation succeeded (JMAP)');
      return success(result);
    } catch (err) {
      app.log.error({ err, userId }, 'mail-admin: rotation failed');
      if (err instanceof ApiError) throw err;
      throw new ApiError(
        'STALWART_ROTATION_FAILED',
        'Stalwart admin password rotation failed. See server logs.',
        500,
      );
    }
  };

  // Canonical 0.16 route
  app.post('/admin/mail/rotate-admin-password', { preHandler: requireRole('super_admin') }, handleRotateAdminPassword);

  // Legacy alias — keeps the frontend hook working without a breaking change
  // until we rename the UI label in a follow-up.
  app.post('/admin/mail/rotate-stalwart-password', { preHandler: requireRole('super_admin') }, handleRotateAdminPassword);

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
