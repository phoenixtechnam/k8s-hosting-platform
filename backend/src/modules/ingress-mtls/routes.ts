/**
 * HTTP routes for per-ingress mTLS access control.
 *
 *   GET    /api/v1/clients/:cid/ingress-routes/:rid/mtls
 *   PATCH  /api/v1/clients/:cid/ingress-routes/:rid/mtls
 *   DELETE /api/v1/clients/:cid/ingress-routes/:rid/mtls
 *
 * Auth: client_admin / super_admin / admin. Cross-tenant safety —
 * every handler verifies the route belongs to a domain that belongs
 * to the requested clientId.
 */

import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { ApiError } from '../../shared/errors.js';
import { success } from '../../shared/response.js';
import { ingressMtlsConfigSchema } from '@k8s-hosting/api-contracts';
import { ingressRoutes, domains, clients } from '../../db/schema.js';
import {
  getMtlsConfig,
  upsertMtlsConfig,
  deleteMtlsConfig,
} from './service.js';
import { createK8sClients, type K8sClients } from '../k8s-provisioner/k8s-client.js';
import { reconcileIngress } from '../domains/k8s-ingress.js';
import type { ZodError } from 'zod';

function zodMessage(err: ZodError): string {
  return err.issues
    .map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
}

async function assertRouteBelongsToClient(
  app: FastifyInstance,
  clientId: string,
  routeId: string,
): Promise<{ namespace: string }> {
  const rows = await app.db
    .select({ ns: clients.kubernetesNamespace })
    .from(ingressRoutes)
    .innerJoin(domains, eq(domains.id, ingressRoutes.domainId))
    .innerJoin(clients, eq(clients.id, domains.clientId))
    .where(and(eq(ingressRoutes.id, routeId), eq(clients.id, clientId)));
  const ns = rows[0]?.ns;
  if (!ns) {
    throw new ApiError('NOT_FOUND', `Ingress route ${routeId} not found for client`, 404);
  }
  return { namespace: ns };
}

export async function ingressMtlsRoutes(app: FastifyInstance): Promise<void> {
  const encryptionKey = app.config?.OIDC_ENCRYPTION_KEY
    ?? process.env.OIDC_ENCRYPTION_KEY
    ?? '0'.repeat(64);

  let k8s: K8sClients | undefined;
  try {
    const kp = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    k8s = createK8sClients(kp);
  } catch (err) {
    app.log.warn({ err }, 'ingress-mtls: k8s client unavailable — reconciler disabled');
  }

  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin', 'admin', 'client_admin'));

  app.get('/clients/:cid/ingress-routes/:rid/mtls', async (request) => {
    const { cid, rid } = request.params as { cid: string; rid: string };
    await assertRouteBelongsToClient(app, cid, rid);
    const cfg = await getMtlsConfig(app.db, rid);
    return success(cfg);
  });

  app.patch('/clients/:cid/ingress-routes/:rid/mtls', async (request) => {
    const { cid, rid } = request.params as { cid: string; rid: string };
    const { namespace } = await assertRouteBelongsToClient(app, cid, rid);
    const parsed = ingressMtlsConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', zodMessage(parsed.error), 400);
    }
    const cfg = await upsertMtlsConfig(app.db, encryptionKey, rid, parsed.data);
    if (k8s) {
      // Re-sync the Ingress — annotation-sync.ts picks up the mTLS
      // config and emits auth-tls-* annotations + the CA Secret.
      try {
        await reconcileIngress(app.db, k8s, cid, namespace);
      } catch (err) {
        request.log.warn({ err, cid, rid }, 'mTLS saved but Ingress annotation sync failed');
      }
    }
    return success(cfg);
  });

  app.delete('/clients/:cid/ingress-routes/:rid/mtls', async (request) => {
    const { cid, rid } = request.params as { cid: string; rid: string };
    const { namespace } = await assertRouteBelongsToClient(app, cid, rid);
    await deleteMtlsConfig(app.db, rid);
    if (k8s) {
      try {
        await reconcileIngress(app.db, k8s, cid, namespace);
      } catch (err) {
        request.log.warn({ err, cid, rid }, 'mTLS deleted but Ingress annotation sync failed');
      }
    }
    return success({ deleted: true });
  });
}
