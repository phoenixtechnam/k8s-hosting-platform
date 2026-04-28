/**
 * HTTP routes for per-client OIDC provider CRUD.
 *
 *   GET    /api/v1/clients/:cid/oidc-providers
 *   POST   /api/v1/clients/:cid/oidc-providers
 *   GET    /api/v1/clients/:cid/oidc-providers/:id
 *   PATCH  /api/v1/clients/:cid/oidc-providers/:id
 *   DELETE /api/v1/clients/:cid/oidc-providers/:id
 *
 * Auth: client_admin / super_admin / admin. Cross-tenant safety —
 * every handler scopes by `clientId` from the URL.
 *
 * Delete returns 409 with consumer count when ingresses still
 * reference the provider (FK RESTRICT at the DB level).
 */

import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { ApiError } from '../../shared/errors.js';
import { success } from '../../shared/response.js';
import { oidcProviderInputSchema } from '@k8s-hosting/api-contracts';
import {
  listProviders,
  getProvider,
  createProvider,
  updateProvider,
  deleteProvider,
} from './providers-service.js';
import type { ZodError } from 'zod';

function zodMessage(err: ZodError): string {
  return err.issues
    .map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
}

export async function oidcProvidersRoutes(app: FastifyInstance): Promise<void> {
  const encryptionKey =
    app.config?.OIDC_ENCRYPTION_KEY ?? process.env.OIDC_ENCRYPTION_KEY ?? '0'.repeat(64);

  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin', 'admin', 'client_admin'));

  // GET — list all providers for a client.
  app.get('/clients/:cid/oidc-providers', async (request) => {
    const { cid } = request.params as { cid: string };
    const rows = await listProviders(app.db, cid);
    return success(rows);
  });

  // POST — create a new provider.
  app.post('/clients/:cid/oidc-providers', async (request, reply) => {
    const { cid } = request.params as { cid: string };
    const parsed = oidcProviderInputSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', zodMessage(parsed.error), 400);
    }
    const provider = await createProvider(app.db, { encryptionKey }, cid, parsed.data);
    reply.status(201).send(success(provider));
  });

  // GET — single provider.
  app.get('/clients/:cid/oidc-providers/:id', async (request) => {
    const { cid, id } = request.params as { cid: string; id: string };
    const provider = await getProvider(app.db, cid, id);
    if (!provider) {
      throw new ApiError('NOT_FOUND', `Provider ${id} not found`, 404);
    }
    return success(provider);
  });

  // PATCH — partial update. clientSecret optional.
  app.patch('/clients/:cid/oidc-providers/:id', async (request) => {
    const { cid, id } = request.params as { cid: string; id: string };
    const parsed = oidcProviderInputSchema.partial().safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', zodMessage(parsed.error), 400);
    }
    const provider = await updateProvider(app.db, { encryptionKey }, cid, id, parsed.data);
    return success(provider);
  });

  // DELETE — 409 when in use.
  app.delete('/clients/:cid/oidc-providers/:id', async (request) => {
    const { cid, id } = request.params as { cid: string; id: string };
    await deleteProvider(app.db, cid, id);
    return success({ deleted: true });
  });
}
