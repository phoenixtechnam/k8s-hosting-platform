/**
 * Phase 3 T5.1 — mail submit credential admin API.
 *
 * Endpoints:
 *   GET    /clients/:clientId/mail/submit-credential
 *   POST   /clients/:clientId/mail/submit-credential/rotate
 *   POST   /clients/:clientId/mail/submit-credential/push-to-pvc
 *
 * All endpoints require admin or client_admin. The plain password is
 * ONLY returned at the moment of rotation (client_admin cannot
 * retrieve it later — this prevents privilege escalation via the
 * API). Once rotated, the auth file on the PVC is the authoritative
 * source and pods read it at send time.
 */

import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { authenticate, requireRole, requireClientAccess } from '../../middleware/auth.js';
import { clients } from '../../db/schema.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import * as service from './service.js';
import { writeSendmailAuthFile } from './pvc-writer.js';

// OIDC_ENCRYPTION_KEY is required — the plain dev fallback is only
// tolerated when NODE_ENV is 'development' or 'test', never in
// production. Failing fast here is better than silently encrypting
// every submit credential with an all-zero key.
const encryptionKey = (): string => {
  const k = process.env.OIDC_ENCRYPTION_KEY;
  if (k && k.length >= 32) return k;
  if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') {
    return '0'.repeat(64);
  }
  throw new Error(
    'OIDC_ENCRYPTION_KEY is required in non-dev environments (mail-submit routes)',
  );
};

const fileManagerImage = (): string =>
  process.env.FILE_MANAGER_IMAGE ?? 'file-manager-sidecar:latest';

// Resolve the Stalwart SMTP host. Priority: DB-configured
// webmail-settings.mailServerHostname (set via the Email Management page)
// → env STALWART_HOSTNAME → in-cluster service DNS. Read at call time so a
// hostname change through the admin panel is picked up without a restart
// (the mail-submit flow only opens SMTP sockets on user action, so each
// call gets a fresh resolution).
async function mailHost(app: FastifyInstance): Promise<string> {
  try {
    const { getMailServerHostname } = await import('../webmail-settings/service.js');
    const fromDb = await getMailServerHostname(app.db);
    if (fromDb) return fromDb;
  } catch {
    // Fall through to env + service DNS
  }
  return process.env.STALWART_HOSTNAME ?? 'stalwart-mail.mail.svc.cluster.local';
}

const mailPort = (): number =>
  parseInt(process.env.STALWART_SUBMISSION_PORT ?? '587', 10);

export async function mailSubmitRoutes(app: FastifyInstance): Promise<void> {
  let k8s: K8sClients | undefined;
  try {
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    k8s = createK8sClients(kubeconfigPath);
  } catch (err) {
    app.log.warn({ err }, 'mail-submit: k8s client unavailable — PVC writes disabled');
    k8s = undefined;
  }

  // GET — returns metadata only (no plain password)
  app.get('/clients/:clientId/mail/submit-credential', {
    onRequest: [authenticate, requireRole('super_admin', 'admin', 'support', 'client_admin'), requireClientAccess()],
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };
    const active = await service.loadActiveCredential(app.db, clientId);
    if (!active) {
      return success({ exists: false });
    }
    return success({
      exists: true,
      id: active.id,
      username: active.username,
      createdAt: active.createdAt,
      lastUsedAt: active.lastUsedAt,
      // Never return passwordEncrypted or passwordHash
    });
  });

  // POST — rotate + (optionally) push the new file to the PVC.
  // Returns the plain password ONCE.
  app.post('/clients/:clientId/mail/submit-credential/rotate', {
    onRequest: [authenticate, requireRole('super_admin', 'admin', 'client_admin'), requireClientAccess()],
  }, async (request, reply) => {
    const { clientId } = request.params as { clientId: string };
    const body = (request.body ?? {}) as { note?: string; pushToPvc?: boolean };

    const [client] = await app.db
      .select({ namespace: clients.kubernetesNamespace })
      .from(clients)
      .where(eq(clients.id, clientId));
    if (!client) {
      throw new ApiError('CLIENT_NOT_FOUND', 'Client not found', 404);
    }

    const result = await service.rotateSubmitCredential(
      app.db,
      clientId,
      encryptionKey(),
      { note: body.note },
    );

    let pushed = false;
    let pushError: string | undefined;
    if (body.pushToPvc !== false && k8s) {
      try {
        await writeSendmailAuthFile(
          {
            k8sClients: k8s,
            kubeconfigPath: (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined,
            fileManagerImage: fileManagerImage(),
          },
          client.namespace,
          {
            username: result.username,
            password: result.password,
            mailHost: await mailHost(app),
            mailPort: mailPort(),
          },
        );
        pushed = true;
      } catch (err) {
        pushError = err instanceof Error ? err.message : String(err);
        app.log.warn({ err, clientId }, 'mail-submit: PVC write failed after rotation');
      }
    }

    reply.status(201).send(
      success({
        id: result.id,
        username: result.username,
        password: result.password, // ONE-TIME disclosure
        pushedToPvc: pushed,
        pushError,
      }),
    );
  });

  // POST — force a re-push to the PVC using the currently-active
  // credential. We can't retrieve the password (it's stored
  // encrypted with the server-side key, and we could decrypt it, but
  // expose it via API only during rotation for the audit trail).
  // This endpoint asks the admin to rotate instead if they need to
  // refresh the PVC file.
  app.post('/clients/:clientId/mail/submit-credential/push-to-pvc', {
    onRequest: [authenticate, requireRole('super_admin', 'admin', 'client_admin'), requireClientAccess()],
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };
    const [client] = await app.db
      .select({ namespace: clients.kubernetesNamespace })
      .from(clients)
      .where(eq(clients.id, clientId));
    if (!client) {
      throw new ApiError('CLIENT_NOT_FOUND', 'Client not found', 404);
    }
    const active = await service.loadActiveCredential(app.db, clientId);
    if (!active) {
      throw new ApiError(
        'NO_ACTIVE_CREDENTIAL',
        'No active submit credential — call /rotate first',
        409,
      );
    }
    if (!k8s) {
      throw new ApiError(
        'K8S_UNAVAILABLE',
        'Kubernetes client is not configured — PVC write disabled',
        503,
      );
    }

    // Decrypt the password at rest so we can write the plaintext to
    // the PVC. This is the only place outside of rotation where
    // plain credentials leave the DB, and they go directly into a
    // protected file on the client's own PVC.
    const { decrypt } = await import('../oidc/crypto.js');
    const plain = decrypt(active.passwordEncrypted, encryptionKey());

    await writeSendmailAuthFile(
      {
        k8sClients: k8s,
        kubeconfigPath: (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined,
        fileManagerImage: fileManagerImage(),
      },
      client.namespace,
      {
        username: active.username,
        password: plain,
        mailHost: await mailHost(app),
        mailPort: mailPort(),
      },
    );

    return success({ pushed: true, username: active.username });
  });
}
