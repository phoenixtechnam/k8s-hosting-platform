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
 *   POST /admin/mail/rotate-stalwart-password
 *                                           →  Generate a fresh password,
 *                                             patch the `stalwart-secrets`
 *                                             k8s Secret, rollout restart
 *                                             Stalwart + platform-api, verify.
 *                                             super_admin only.
 */

import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import * as service from './service.js';
import { readStalwartCredentials } from './credentials.js';
import { rotateStalwartPassword } from './rotate.js';

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

  app.get('/admin/mail/stalwart-credentials', async (req) => {
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

  app.post('/admin/mail/rotate-stalwart-password', {
    preHandler: requireRole('super_admin'),
  }, async (req) => {
    const cfg = app.config as Record<string, unknown>;
    const userId = req.user?.sub ?? 'unknown';
    app.log.warn({ userId }, 'mail-admin: rotate-stalwart-password requested');
    try {
      const result = await rotateStalwartPassword({
        kubeconfigPath: cfg.KUBECONFIG_PATH as string | undefined,
        stalwartNamespace: 'mail',
        platformNamespace: 'platform',
        secretName: 'stalwart-secrets',
        platformMirrorSecretName: 'platform-stalwart-creds',
        stalwartStatefulSetName: 'stalwart-mail',
        platformDeploymentName: 'platform-api',
        stalwartMgmtHost:
          process.env.STALWART_MGMT_HOST ?? 'stalwart-mail-mgmt.mail.svc.cluster.local',
        stalwartMgmtPort: Number(process.env.STALWART_MGMT_PORT ?? '8080'),
        username: readStalwartCredentials(process.env).username,
        verifyTimeoutMs: 120_000,
      });
      app.log.warn({ userId, rotatedAt: result.rotatedAt }, 'mail-admin: rotation succeeded');
      return success(result);
    } catch (err) {
      app.log.error({ err, userId }, 'mail-admin: rotation failed');
      if (err instanceof ApiError) throw err;
      // Generic client message — do not echo err.message (may include
      // namespace / resource names, timeouts, or internal details).
      throw new ApiError(
        'STALWART_ROTATION_FAILED',
        'Stalwart password rotation failed. See server logs; you may need to manually restart platform-api if Stalwart restarted successfully but verification timed out.',
        500,
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
