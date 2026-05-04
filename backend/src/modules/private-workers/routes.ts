/**
 * Public HTTP routes for the private-worker feature.
 *
 *   GET    /api/v1/clients/:clientId/private-workers
 *   POST   /api/v1/clients/:clientId/private-workers
 *   GET    /api/v1/clients/:clientId/private-workers/:workerId
 *   PATCH  /api/v1/clients/:clientId/private-workers/:workerId
 *   POST   /api/v1/clients/:clientId/private-workers/:workerId/rotate
 *   POST   /api/v1/clients/:clientId/private-workers/:workerId/revoke
 *   DELETE /api/v1/clients/:clientId/private-workers/:workerId
 *   GET    /api/v1/clients/:clientId/private-workers/:workerId/audit
 *
 * Auth chain matches every other client-resource module:
 *   authenticate → requireClientRoleByMethod → requireClientAccess.
 *
 * After mutations we kick the K8s reconciler in the background so the
 * HTTP response isn't blocked on cluster apply latency. The reconciler
 * is idempotent and the next scheduled tick (or any other mutation)
 * will retry on transient failures.
 */

import type { FastifyInstance } from 'fastify';
import {
  createPrivateWorkerSchema,
  updatePrivateWorkerSchema,
  rotatePrivateWorkerTokenSchema,
  revokePrivateWorkerSchema,
} from '@k8s-hosting/api-contracts';
import {
  authenticate,
  requireClientAccess,
  requireClientRoleByMethod,
} from '../../middleware/auth.js';
import { ApiError } from '../../shared/errors.js';
import { success } from '../../shared/response.js';
import * as service from './service.js';
import { reconcilePrivateWorkersForClient } from './reconciler.js';
import { createK8sClients, type K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { ZodError } from 'zod';

function zodMessage(err: ZodError): string {
  return err.issues
    .map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
}

function scheduleReconcile(
  app: FastifyInstance,
  k8s: K8sClients | undefined,
  clientId: string,
): void {
  if (!k8s) return;
  // Fire-and-forget. Errors are logged; the lifecycle scheduler retries.
  void reconcilePrivateWorkersForClient({ db: app.db, k8s }, clientId).then(
    (outcome) => {
      if (outcome.error) {
        app.log.warn(
          { clientId, action: outcome.action, error: outcome.error },
          'private-workers: reconcile reported an error',
        );
      }
    },
    (err: unknown) => {
      app.log.error(
        { err, clientId },
        'private-workers: reconcile threw unexpectedly',
      );
    },
  );
}

export async function privateWorkerRoutes(app: FastifyInstance): Promise<void> {
  // K8s clients are created once per plugin registration. If the
  // platform-api can't reach the cluster (e.g. local unit-test mode),
  // mutations still succeed in the DB and the next scheduler tick
  // converges the cluster.
  let k8s: K8sClients | undefined;
  try {
    const cfg = app.config as Record<string, unknown>;
    const kubeconfigPath = cfg.KUBECONFIG_PATH as string | undefined;
    k8s = createK8sClients(kubeconfigPath);
  } catch (err) {
    app.log.warn({ err }, 'private-workers: k8s client unavailable — reconciler disabled');
  }

  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireClientRoleByMethod());
  app.addHook('onRequest', requireClientAccess());

  // GET — list
  app.get('/clients/:clientId/private-workers', async (request) => {
    const { clientId } = request.params as { clientId: string };
    const items = await service.listPrivateWorkers(app.db, clientId);
    return success({ items });
  });

  // POST — create (returns one-time secret).
  // Per-route rate limit: 10 mints / 15 min / user — defends against
  // enumeration of the secret space + DoS via rapid worker churn.
  app.post('/clients/:clientId/private-workers', {
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const { clientId } = request.params as { clientId: string };
    const parsed = createPrivateWorkerSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', zodMessage(parsed.error), 400);
    }
    const result = await service.createPrivateWorker(
      app.db,
      clientId,
      parsed.data,
      request.user?.sub ?? null,
      request.ip,
    );
    scheduleReconcile(app, k8s, clientId);
    reply.status(201).send(success(result));
  });

  // GET — detail
  app.get('/clients/:clientId/private-workers/:workerId', async (request) => {
    const { clientId, workerId } = request.params as {
      clientId: string;
      workerId: string;
    };
    const worker = await service.getPrivateWorker(app.db, clientId, workerId);
    return success(worker);
  });

  // PATCH — update name/description (no rotation)
  app.patch('/clients/:clientId/private-workers/:workerId', async (request) => {
    const { clientId, workerId } = request.params as {
      clientId: string;
      workerId: string;
    };
    const parsed = updatePrivateWorkerSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', zodMessage(parsed.error), 400);
    }
    const worker = await service.updatePrivateWorker(
      app.db,
      clientId,
      workerId,
      parsed.data,
    );
    return success(worker);
  });

  // POST — rotate token. Rotates the per-client SHARED auth secret,
  // invalidating every sibling worker — UI warns about this.
  app.post('/clients/:clientId/private-workers/:workerId/rotate', {
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
  }, async (request) => {
    const { clientId, workerId } = request.params as {
      clientId: string;
      workerId: string;
    };
    const parsed = rotatePrivateWorkerTokenSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', zodMessage(parsed.error), 400);
    }
    const result = await service.rotatePrivateWorker(
      app.db,
      clientId,
      workerId,
      request.user?.sub ?? null,
      request.ip,
    );
    scheduleReconcile(app, k8s, clientId);
    return success(result);
  });

  // POST — revoke
  app.post('/clients/:clientId/private-workers/:workerId/revoke', async (request) => {
    const { clientId, workerId } = request.params as {
      clientId: string;
      workerId: string;
    };
    const parsed = revokePrivateWorkerSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', zodMessage(parsed.error), 400);
    }
    const worker = await service.revokePrivateWorker(
      app.db,
      clientId,
      workerId,
      request.user?.sub ?? null,
      request.ip,
    );
    scheduleReconcile(app, k8s, clientId);
    return success(worker);
  });

  // DELETE — hard delete (revokes first if active)
  app.delete('/clients/:clientId/private-workers/:workerId', async (request, reply) => {
    const { clientId, workerId } = request.params as {
      clientId: string;
      workerId: string;
    };
    await service.deletePrivateWorker(
      app.db,
      clientId,
      workerId,
      request.user?.sub ?? null,
    );
    scheduleReconcile(app, k8s, clientId);
    reply.status(204).send();
  });

  // GET — audit log
  app.get('/clients/:clientId/private-workers/:workerId/audit', async (request) => {
    const { clientId, workerId } = request.params as {
      clientId: string;
      workerId: string;
    };
    const query = request.query as { limit?: string };
    const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 200);
    const items = await service.listPrivateWorkerAudit(
      app.db,
      clientId,
      workerId,
      limit,
    );
    return success({ items });
  });
}
