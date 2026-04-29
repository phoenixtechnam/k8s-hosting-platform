/**
 * HTTP routes for per-deployment Network Access.
 *
 *   GET    /api/v1/clients/:cid/deployments/:did/network-access
 *   PATCH  /api/v1/clients/:cid/deployments/:did/network-access
 *   DELETE /api/v1/clients/:cid/deployments/:did/network-access
 */

import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { ApiError } from '../../shared/errors.js';
import { success } from '../../shared/response.js';
import { deploymentNetworkAccessInputSchema } from '@k8s-hosting/api-contracts';
import { deployments } from '../../db/schema.js';
import { getConfig, upsertConfig, deleteConfig } from './service.js';
import { reconcileClient } from './reconciler.js';
import { createK8sClients, type K8sClients } from '../k8s-provisioner/k8s-client.js';
import { reconcileIngress } from '../domains/k8s-ingress.js';
import type { ZodError } from 'zod';

function zodMessage(err: ZodError): string {
  return err.issues
    .map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
}

async function assertDeploymentBelongsToClient(
  app: FastifyInstance,
  clientId: string,
  deploymentId: string,
): Promise<void> {
  const [d] = await app.db
    .select()
    .from(deployments)
    .where(and(eq(deployments.id, deploymentId), eq(deployments.clientId, clientId)));
  if (!d) {
    throw new ApiError('NOT_FOUND', `Deployment ${deploymentId} not found for client`, 404);
  }
}

export async function deploymentNetworkAccessRoutes(app: FastifyInstance): Promise<void> {
  const encryptionKey = app.config?.OIDC_ENCRYPTION_KEY
    ?? process.env.OIDC_ENCRYPTION_KEY
    ?? '0'.repeat(64);

  let k8s: K8sClients | undefined;
  try {
    const kp = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    k8s = createK8sClients(kp);
  } catch (err) {
    app.log.warn({ err }, 'deployment-network-access: k8s client unavailable — reconciler disabled');
  }

  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin', 'admin', 'client_admin'));

  app.get('/clients/:cid/deployments/:did/network-access', async (request) => {
    const { cid, did } = request.params as { cid: string; did: string };
    await assertDeploymentBelongsToClient(app, cid, did);
    const cfg = await getConfig(app.db, did);
    return success(cfg);
  });

  app.patch('/clients/:cid/deployments/:did/network-access', async (request) => {
    const { cid, did } = request.params as { cid: string; did: string };
    await assertDeploymentBelongsToClient(app, cid, did);
    const parsed = deploymentNetworkAccessInputSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', zodMessage(parsed.error), 400);
    }
    const cfg = await upsertConfig(app.db, did, parsed.data);
    if (k8s) {
      // Reconcile the per-client mesh proxy AND re-sync ingresses
      // so the suppress_public_ingress flag is honoured.
      const outcome = await reconcileClient({ db: app.db, k8s: { core: k8s.core, apps: k8s.apps, networking: k8s.networking }, encryptionKey }, cid);
      if (outcome.error) {
        throw new ApiError(
          'RECONCILE_FAILED',
          `Config saved but mesh-proxy reconcile failed: ${outcome.error}. The next scheduler tick will retry.`,
          502,
        );
      }
      try {
        await reconcileIngress(app.db, k8s, cid, outcome.namespace);
      } catch (err) {
        request.log.warn({ err, cid, did }, 'Network-access saved + proxy provisioned, but Ingress sync failed');
      }
    }
    return success(cfg);
  });

  app.delete('/clients/:cid/deployments/:did/network-access', async (request) => {
    const { cid, did } = request.params as { cid: string; did: string };
    await assertDeploymentBelongsToClient(app, cid, did);
    await deleteConfig(app.db, did);
    if (k8s) {
      const outcome = await reconcileClient({ db: app.db, k8s: { core: k8s.core, apps: k8s.apps, networking: k8s.networking }, encryptionKey }, cid);
      try {
        await reconcileIngress(app.db, k8s, cid, outcome.namespace);
      } catch (err) {
        request.log.warn({ err, cid, did }, 'Network-access deleted + proxy torn down, but Ingress sync failed');
      }
    }
    return success({ deleted: true });
  });
}
