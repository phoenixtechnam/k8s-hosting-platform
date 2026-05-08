/**
 * system-pvc routes.
 *
 *   GET   /admin/system/pvc/storage   →  Live system-db-1 PVC state
 *                                         + StorageClass + best-effort
 *                                         used/free probe.
 *   PATCH /admin/system/pvc/storage   →  Online-grow request. Refuses
 *                                         shrink + same-size + SC-
 *                                         no-expansion up-front with
 *                                         explicit SYSTEM_PVC_*
 *                                         error codes the UI surfaces
 *                                         in <ErrorPanel>.
 *
 * Gated to super_admin only — system PVC ops are higher-blast-radius
 * than mail-pvc (loss of the platform DB stops every tenant), so we
 * deliberately don't extend access to the broader admin/support
 * roles that get the mail-pvc surface.
 */

import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { getSystemPvcStorage, resizeSystemPvc } from './system-pvc.js';
import { systemPvcResizeRequestSchema } from '@k8s-hosting/api-contracts';

export async function systemPvcRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);

  app.get(
    '/admin/system/pvc/storage',
    { preHandler: requireRole('super_admin') },
    async () => {
      const cfg = app.config as Record<string, unknown>;
      try {
        const result = await getSystemPvcStorage({
          kubeconfigPath: cfg.KUBECONFIG_PATH as string | undefined,
        });
        return success(result);
      } catch (err) {
        if (err instanceof ApiError) throw err;
        app.log.warn({ err }, 'system-pvc: storage read failed');
        throw new ApiError(
          'SYSTEM_PVC_READ_FAILED',
          'Could not read system-db-1 PVC state — see server logs',
          503,
        );
      }
    },
  );

  app.patch(
    '/admin/system/pvc/storage',
    { preHandler: requireRole('super_admin') },
    async (req: { body: unknown; user?: { sub?: string } }) => {
      const cfg = app.config as Record<string, unknown>;
      const userId = req.user?.sub ?? 'unknown';
      const parsed = systemPvcResizeRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError(
          'VALIDATION_ERROR',
          parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', '),
          400,
        );
      }
      app.log.warn({ userId, newGiB: parsed.data.newGiB }, 'system-pvc: resize requested');
      try {
        const result = await resizeSystemPvc(parsed.data.newGiB, {
          kubeconfigPath: cfg.KUBECONFIG_PATH as string | undefined,
        });
        app.log.warn({ userId, newGiB: parsed.data.newGiB }, 'system-pvc: resize patched');
        return success(result);
      } catch (err) {
        if (err instanceof ApiError) throw err;
        app.log.error({ err, userId }, 'system-pvc: resize failed');
        throw new ApiError(
          'SYSTEM_PVC_RESIZE_FAILED',
          'system-db-1 PVC resize failed — see server logs',
          500,
        );
      }
    },
  );
}
