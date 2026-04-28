/**
 * HTTP routes for zrok provider CRUD.
 *
 *   GET    /api/v1/clients/:cid/zrok-providers
 *   POST   /api/v1/clients/:cid/zrok-providers
 *   PATCH  /api/v1/clients/:cid/zrok-providers/:pid
 *   DELETE /api/v1/clients/:cid/zrok-providers/:pid
 *   POST   /api/v1/clients/:cid/zrok-providers/:pid/test
 */

import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { ApiError } from '../../shared/errors.js';
import { success } from '../../shared/response.js';
import { zrokProviderInputSchema } from '@k8s-hosting/api-contracts';
import {
  listProviders,
  createProvider,
  updateProvider,
  deleteProvider,
} from './service.js';
import type { ZodError } from 'zod';

function zodMessage(err: ZodError): string {
  return err.issues
    .map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
}

export async function zrokProvidersRoutes(app: FastifyInstance): Promise<void> {
  const encryptionKey = app.config?.OIDC_ENCRYPTION_KEY
    ?? process.env.OIDC_ENCRYPTION_KEY
    ?? '0'.repeat(64);

  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin', 'admin', 'client_admin'));

  app.get('/clients/:cid/zrok-providers', async (request) => {
    const { cid } = request.params as { cid: string };
    const rows = await listProviders(app.db, cid);
    return success(rows);
  });

  app.post('/clients/:cid/zrok-providers', async (request) => {
    const { cid } = request.params as { cid: string };
    const parsed = zrokProviderInputSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', zodMessage(parsed.error), 400);
    }
    const created = await createProvider(app.db, encryptionKey, cid, parsed.data);
    return success(created);
  });

  app.patch('/clients/:cid/zrok-providers/:pid', async (request) => {
    const { cid, pid } = request.params as { cid: string; pid: string };
    const parsed = zrokProviderInputSchema.partial().safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', zodMessage(parsed.error), 400);
    }
    const updated = await updateProvider(app.db, encryptionKey, cid, pid, parsed.data);
    return success(updated);
  });

  app.delete('/clients/:cid/zrok-providers/:pid', async (request) => {
    const { cid, pid } = request.params as { cid: string; pid: string };
    await deleteProvider(app.db, cid, pid);
    return success({ deleted: true });
  });

  app.post('/clients/:cid/zrok-providers/:pid/test', async (request) => {
    const body = request.body as { controllerUrl?: string } | null;
    const url = body?.controllerUrl;
    if (!url) {
      throw new ApiError('VALIDATION_ERROR', 'controllerUrl required', 400);
    }
    try {
      const probe = `${url.replace(/\/+$/, '')}/api/v1/version`;
      const res = await fetch(probe, { method: 'GET', signal: AbortSignal.timeout(5000) });
      const text = await res.text().catch(() => '');
      if (!res.ok) {
        return success({
          ok: false,
          controllerReachable: true,
          version: null,
          error: `controller responded ${res.status}`,
        });
      }
      // zrok /api/v1/version returns either a version string or JSON.
      // Try JSON first; fall back to plain text.
      let version: string | null = null;
      try {
        const parsed = JSON.parse(text);
        version = typeof parsed === 'object' && parsed && 'version' in parsed ? String(parsed.version) : text.trim();
      } catch {
        version = text.trim() || null;
      }
      return success({
        ok: true,
        controllerReachable: true,
        version,
        error: null,
      });
    } catch (err) {
      return success({
        ok: false,
        controllerReachable: false,
        version: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
