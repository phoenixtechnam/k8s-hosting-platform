import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { getWebmailSettings, updateWebmailSettings, getMailServerHostname } from './service.js';
import { updateWebmailSettingsSchema } from '@k8s-hosting/api-contracts';
import { ensureMailServerCertificate } from '../certificates/service.js';
import { reconcileOutboundConfig } from '../email-outbound/service.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { reconcileStalwartHostname } from './stalwart-reconciler.js';

export async function webmailSettingsRoutes(app: FastifyInstance): Promise<void> {
  // Phase 3.A.1: k8s client for cert provisioning. Created once at
  // plugin registration, not per-request.
  let k8s: K8sClients | undefined;
  try {
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    k8s = createK8sClients(kubeconfigPath);
  } catch (err) {
    app.log.warn({ err }, 'webmail-settings: k8s client unavailable — mail cert provisioning disabled');
    k8s = undefined;
  }

  // GET /api/v1/admin/webmail-settings
  app.get('/admin/webmail-settings', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
    schema: {
      tags: ['Webmail Settings'],
      summary: 'Get platform webmail settings',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const settings = await getWebmailSettings(app.db);
    return success(settings);
  });

  // PATCH /api/v1/admin/webmail-settings
  app.patch('/admin/webmail-settings', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
    schema: {
      tags: ['Webmail Settings'],
      summary: 'Update platform webmail settings',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const parsed = updateWebmailSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }
    const settings = await updateWebmailSettings(app.db, parsed.data);

    // Phase 3.A.1: if the mail hostname was changed, re-issue the
    // Stalwart TLS cert to match. Non-blocking on failure — admin can
    // retry via POST /admin/mail/certificate/ensure.
    if (k8s && parsed.data.mailServerHostname) {
      try {
        await ensureMailServerCertificate(
          app.db,
          k8s,
          parsed.data.mailServerHostname,
          app.log,
        );
      } catch (err) {
        app.log.warn(
          { err, hostname: parsed.data.mailServerHostname },
          'webmail-settings: mail cert ensure failed (non-blocking)',
        );
      }

      // Propagate the hostname into the running Stalwart pod by patching
      // the stalwart-secrets Secret's STALWART_HOSTNAME key and rollout-
      // restarting the StatefulSet. Stalwart reads this env at startup
      // (config.toml: hostname = "%{env:STALWART_HOSTNAME}%"), so without
      // this step the SMTP 220 greeting keeps announcing the old name.
      // Fire-and-forget with await on error log — the PATCH response is
      // the DB write; the pod roll happens in the background and shows up
      // via future SMTP probes / pod status.
      const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
      try {
        const restarted = await reconcileStalwartHostname(
          parsed.data.mailServerHostname,
          { kubeconfigPath },
        );
        if (restarted) {
          app.log.info(
            { hostname: parsed.data.mailServerHostname },
            'webmail-settings: STALWART_HOSTNAME updated, stalwart-mail StatefulSet restart triggered',
          );
        }
      } catch (err) {
        app.log.warn(
          { err, hostname: parsed.data.mailServerHostname },
          'webmail-settings: stalwart hostname reconcile failed (non-blocking)',
        );
      }
    }

    // Phase 3.B.3: if the global rate limit default was changed,
    // reconcile the Stalwart outbound config.
    if (k8s && parsed.data.emailSendRateLimitDefault !== undefined) {
      try {
        await reconcileOutboundConfig(app.db, k8s, app.log);
      } catch (err) {
        app.log.warn(
          { err },
          'webmail-settings: outbound reconcile failed (non-blocking)',
        );
      }
    }

    return success(settings);
  });

  // POST /api/v1/admin/mail/certificate/ensure
  // Phase 3.A.1: manually trigger (or re-trigger) Stalwart mail server
  // certificate provisioning. Useful when:
  //   - operator is bootstrapping the production mail stack
  //   - the previous issuance failed and they want to retry
  //   - the ClusterIssuer has been changed via /admin/tls-settings
  //     and they want a fresh cert signed by the new issuer
  app.post('/admin/mail/certificate/ensure', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
    schema: {
      tags: ['Webmail Settings'],
      summary: 'Ensure the Stalwart mail server TLS certificate exists',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    if (!k8s) {
      throw new ApiError(
        'K8S_UNAVAILABLE',
        'Kubernetes client is not configured — cannot provision mail server certificate',
        503,
      );
    }
    const hostname = await getMailServerHostname(app.db);
    const result = await ensureMailServerCertificate(app.db, k8s, hostname, app.log);
    return success(result);
  });
}
