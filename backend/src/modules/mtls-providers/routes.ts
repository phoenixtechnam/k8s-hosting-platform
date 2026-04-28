/**
 * HTTP routes for per-client mTLS provider CRUD + cert issuance.
 *
 *   GET    /api/v1/clients/:cid/mtls-providers
 *   POST   /api/v1/clients/:cid/mtls-providers          (upload OR generate)
 *   PATCH  /api/v1/clients/:cid/mtls-providers/:pid
 *   DELETE /api/v1/clients/:cid/mtls-providers/:pid
 *   POST   /api/v1/clients/:cid/mtls-providers/:pid/issue-cert
 */

import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { ApiError } from '../../shared/errors.js';
import { success } from '../../shared/response.js';
import {
  mtlsProviderInputSchema,
  mtlsProviderUpdateSchema,
  mtlsIssueCertInputSchema,
} from '@k8s-hosting/api-contracts';
import {
  listProviders,
  createProvider,
  updateProvider,
  deleteProvider,
  issueUserCert,
} from './service.js';
import type { ZodError } from 'zod';

function zodMessage(err: ZodError): string {
  return err.issues
    .map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
}

export async function mtlsProvidersRoutes(app: FastifyInstance): Promise<void> {
  const encryptionKey = app.config?.OIDC_ENCRYPTION_KEY
    ?? process.env.OIDC_ENCRYPTION_KEY
    ?? '0'.repeat(64);

  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin', 'admin', 'client_admin'));

  app.get('/clients/:cid/mtls-providers', async (request) => {
    const { cid } = request.params as { cid: string };
    const rows = await listProviders(app.db, cid);
    return success(rows);
  });

  app.post('/clients/:cid/mtls-providers', async (request) => {
    const { cid } = request.params as { cid: string };
    const parsed = mtlsProviderInputSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', zodMessage(parsed.error), 400);
    }
    const created = await createProvider(app.db, encryptionKey, cid, parsed.data);
    return success(created);
  });

  app.patch('/clients/:cid/mtls-providers/:pid', async (request) => {
    const { cid, pid } = request.params as { cid: string; pid: string };
    const parsed = mtlsProviderUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', zodMessage(parsed.error), 400);
    }
    const updated = await updateProvider(app.db, encryptionKey, cid, pid, parsed.data);
    return success(updated);
  });

  app.delete('/clients/:cid/mtls-providers/:pid', async (request) => {
    const { cid, pid } = request.params as { cid: string; pid: string };
    await deleteProvider(app.db, cid, pid);
    return success({ deleted: true });
  });

  // Issue a fresh user cert from this provider's CA. The cert + key
  // are returned ONCE; the operator must save them locally — no
  // server-side persistence after this response.
  app.post('/clients/:cid/mtls-providers/:pid/issue-cert', async (request) => {
    const { cid, pid } = request.params as { cid: string; pid: string };
    const parsed = mtlsIssueCertInputSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', zodMessage(parsed.error), 400);
    }
    const issued = await issueUserCert(app.db, encryptionKey, cid, pid, parsed.data);
    return success(issued);
  });
}
