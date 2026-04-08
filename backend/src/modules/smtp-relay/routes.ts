import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { createSmtpRelaySchema, updateSmtpRelaySchema } from '@k8s-hosting/api-contracts';
import * as service from './service.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { reconcileOutboundConfig } from '../email-outbound/service.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

export async function smtpRelayRoutes(app: FastifyInstance): Promise<void> {
  const encryptionKey = app.config?.OIDC_ENCRYPTION_KEY ?? process.env.OIDC_ENCRYPTION_KEY ?? '0'.repeat(64) /* Dev-only fallback — production requires OIDC_ENCRYPTION_KEY env var */;

  // Phase 3.B.1: reconcile Stalwart outbound config on every relay CRUD.
  let k8s: K8sClients | undefined;
  try {
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    k8s = createK8sClients(kubeconfigPath);
  } catch (err) {
    app.log.warn({ err }, 'smtp-relay: k8s client unavailable — outbound reconcile disabled');
    k8s = undefined;
  }

  const triggerOutboundReconcile = async () => {
    if (!k8s) return;
    try {
      await reconcileOutboundConfig(app.db, k8s, app.log);
    } catch (err) {
      app.log.warn({ err }, 'smtp-relay: outbound reconcile failed (non-blocking)');
    }
  };

  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin', 'admin'));

  // GET /api/v1/admin/email/smtp-relays
  app.get('/admin/email/smtp-relays', async () => {
    const configs = await service.listRelayConfigs(app.db);
    return success(configs);
  });

  // POST /api/v1/admin/email/smtp-relays
  app.post('/admin/email/smtp-relays', async (request, reply) => {
    const parsed = createSmtpRelaySchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ApiError(
        'MISSING_REQUIRED_FIELD',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    const config = await service.createRelayConfig(app.db, parsed.data, encryptionKey);
    await triggerOutboundReconcile();
    reply.status(201).send(success(config));
  });

  // PATCH /api/v1/admin/email/smtp-relays/:id
  app.patch('/admin/email/smtp-relays/:id', async (request) => {
    const { id } = request.params as { id: string };
    const parsed = updateSmtpRelaySchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    const updated = await service.updateRelayConfig(app.db, id, parsed.data, encryptionKey);
    await triggerOutboundReconcile();
    return success(updated);
  });

  // DELETE /api/v1/admin/email/smtp-relays/:id
  app.delete('/admin/email/smtp-relays/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await service.deleteRelayConfig(app.db, id);
    await triggerOutboundReconcile();
    reply.status(204).send();
  });

  // POST /api/v1/admin/email/smtp-relays/:id/test
  app.post('/admin/email/smtp-relays/:id/test', async (request) => {
    const { id } = request.params as { id: string };
    const result = await service.testRelayConnection(app.db, id, encryptionKey);
    return success(result);
  });

  // POST /api/v1/admin/mail/outbound/reconcile
  //
  // Phase 3.B.1: manual trigger to re-render the Stalwart outbound
  // ConfigMap from the current DB state. Automatically called on
  // every smtp-relay CRUD, but exposed here for operator debugging
  // or when a client's rate limit was updated via a direct DB write.
  app.post('/admin/mail/outbound/reconcile', async () => {
    if (!k8s) {
      throw new ApiError(
        'K8S_UNAVAILABLE',
        'Kubernetes client is not configured — cannot reconcile outbound config',
        503,
      );
    }
    const result = await reconcileOutboundConfig(app.db, k8s, app.log);
    return success(result);
  });
}
