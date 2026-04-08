import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requireClientAccess } from '../../middleware/auth.js';
import { createWebmailDomainSchema } from '@k8s-hosting/api-contracts';
import * as service from './service.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

export async function webmailDomainRoutes(app: FastifyInstance): Promise<void> {
  // Create the k8s client once at plugin registration. createK8sClients
  // reads the kubeconfig (or in-cluster config) eagerly, so if we fail here
  // we log a clear warning and every subsequent request runs in no-k8s mode
  // instead of silently swallowing the error on every call.
  let k8s: K8sClients | undefined;
  try {
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as
      | string
      | undefined;
    k8s = createK8sClients(kubeconfigPath);
  } catch (err) {
    app.log.warn(
      { err },
      'webmail-domains: failed to create k8s clients — running in no-k8s mode. '
      + 'All provisioning calls will leave rows in pending.',
    );
    k8s = undefined;
  }

  // ─── Client-scoped CRUD ────────────────────────────────────────────────

  app.register(async (clientScope) => {
    clientScope.addHook('onRequest', authenticate);
    clientScope.addHook('onRequest', requireClientAccess());

    // GET /api/v1/clients/:clientId/webmail-domains
    clientScope.get('/clients/:clientId/webmail-domains', {
      onRequest: [requireRole('super_admin', 'admin', 'support', 'client_admin', 'client_user')],
    }, async (request) => {
      const { clientId } = request.params as { clientId: string };
      const data = await service.listWebmailDomains(app.db, clientId);
      return success(data);
    });

    // GET /api/v1/clients/:clientId/webmail-domains/:id
    // Same role set as the list endpoint — both return the same data, so a
    // narrower role gate on the single-item GET was inconsistent.
    clientScope.get('/clients/:clientId/webmail-domains/:id', {
      onRequest: [requireRole('super_admin', 'admin', 'support', 'client_admin', 'client_user')],
    }, async (request) => {
      const { clientId, id } = request.params as { clientId: string; id: string };
      const data = await service.getWebmailDomain(app.db, clientId, id);
      return success(data);
    });

    // POST /api/v1/clients/:clientId/webmail-domains
    clientScope.post('/clients/:clientId/webmail-domains', {
      onRequest: [requireRole('super_admin', 'admin', 'client_admin')],
    }, async (request, reply) => {
      const { clientId } = request.params as { clientId: string };
      const parsed = createWebmailDomainSchema.safeParse(request.body);
      if (!parsed.success) {
        const firstError = parsed.error.errors[0];
        throw new ApiError(
          'INVALID_FIELD_VALUE',
          `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
          400,
          { field: firstError.path.join('.') },
        );
      }
      const created = await service.createWebmailDomain(
        app.db,
        clientId,
        parsed.data,
        k8s,
        app.log,
      );
      reply.status(201).send(success(created));
    });

    // DELETE /api/v1/clients/:clientId/webmail-domains/:id
    clientScope.delete('/clients/:clientId/webmail-domains/:id', {
      onRequest: [requireRole('super_admin', 'admin', 'client_admin')],
    }, async (request, reply) => {
      const { clientId, id } = request.params as { clientId: string; id: string };
      await service.deleteWebmailDomain(app.db, clientId, id, k8s, app.log);
      reply.status(204).send();
    });
  });
}
