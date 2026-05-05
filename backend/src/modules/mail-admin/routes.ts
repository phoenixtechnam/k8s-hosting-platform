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
import { rotateWebmailMasterPassword } from './rotate-webmail-master.js';

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
        // platform-api reads /etc/stalwart-creds/ADMIN_SECRET_PLAIN
        // from a volume mount of platform/platform-stalwart-creds.
        // Mirror the rotated password into that Secret so platform-api
        // picks it up on the next kubelet refresh (~60s) without needing
        // a pod restart.
        mirrorNamespace: 'platform',
        mirrorSecretName: 'platform-stalwart-creds',
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

  // Cut 3 (2026-05-05): rotate the Stalwart `master@master.local` Account
  // password (consumed by Roundcube's jwt_auth plugin for IMAP master-
  // user impersonation). Same JMAP+Secret mechanics as the admin route
  // but targets `roundcube-secrets/STALWART_MASTER_PASSWORD` and rolls
  // the Roundcube Deployment afterwards (Roundcube reads the env var
  // at process start, not via volume-mount refresh).
  const handleRotateWebmailMasterPassword = async (req: { user?: { sub?: string } }) => {
    const cfg = app.config as Record<string, unknown>;
    const userId = req.user?.sub ?? 'unknown';
    app.log.warn({ userId }, 'mail-admin: rotate-webmail-master-password requested');
    try {
      const result = await rotateWebmailMasterPassword({
        kubeconfigPath: cfg.KUBECONFIG_PATH as string | undefined,
      });
      app.log.warn({ userId, rotatedAt: result.rotatedAt }, 'mail-admin: webmail master rotation succeeded');
      return success(result);
    } catch (err) {
      app.log.error({ err, userId }, 'mail-admin: webmail master rotation failed');
      if (err instanceof ApiError) throw err;
      throw new ApiError(
        'WEBMAIL_MASTER_ROTATION_FAILED',
        'Webmail master password rotation failed. See server logs.',
        500,
      );
    }
  };
  app.post(
    '/admin/mail/rotate-webmail-master-password',
    { preHandler: requireRole('super_admin') },
    handleRotateWebmailMasterPassword,
  );

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
