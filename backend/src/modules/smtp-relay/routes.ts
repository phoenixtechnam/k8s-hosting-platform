import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requireClientAccess } from '../../middleware/auth.js';
import { createSmtpRelaySchema, updateSmtpRelaySchema } from '@k8s-hosting/api-contracts';
import * as service from './service.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { reconcileOutboundConfig } from '../email-outbound/service.js';
import { getEffectiveRateLimit } from '../email-outbound/rate-limit.js';
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

  // The /admin/* routes below require admin. The /clients/:cid/mail/...
  // routes are registered separately at the bottom with their own
  // role + client-access guards.
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
      const firstError = parsed.error.issues[0];
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
      const firstError = parsed.error.issues[0];
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

  // GET /api/v1/admin/clients/:clientId/mail/rate-limit
  //
  // Phase 3 (post-Phase-3) G5: read the effective email send rate
  // limit for a client. Mirrors the same calculation that the
  // [queue.throttle] reconciler uses, so admins can verify what's
  // actually configured without having to read the rendered
  // ConfigMap. Returns the source (override / platform_default /
  // hardcoded_default / suspended) so callers know WHY the value is
  // what it is.
  //
  // This route inherits the admin-only guard from the addHook above.
  app.get('/admin/clients/:clientId/mail/rate-limit', async (request) => {
    const { clientId } = request.params as { clientId: string };
    const result = await getEffectiveRateLimit(app.db, clientId);
    return success(result);
  });
}

// ─── Client-scoped rate limit ─────────────────────────────────────────────
//
// Registered as a SEPARATE plugin so the parent's admin-only
// authenticate+requireRole hooks don't apply. This route lets a
// client_admin read their OWN rate limit from the client panel; an
// admin can also call it via the same path because requireRole
// includes 'super_admin' | 'admin'.
export async function smtpRelayClientRoutes(app: FastifyInstance): Promise<void> {
  app.get('/clients/:clientId/mail/rate-limit', {
    onRequest: [
      authenticate,
      requireRole('super_admin', 'admin', 'support', 'client_admin'),
      requireClientAccess(),
    ],
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };
    const result = await getEffectiveRateLimit(app.db, clientId);
    return success(result);
  });
}
