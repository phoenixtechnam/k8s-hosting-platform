import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { getWebmailSettings, updateWebmailSettings } from './service.js';
import { updateWebmailSettingsSchema } from '@k8s-hosting/api-contracts';
import { reconcileOutboundConfig } from '../email-outbound/service.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

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
      const firstError = parsed.error.issues[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    // 2026-05-07: Stalwart 0.16's Bootstrap.serverHostname is locked
    // post-bootstrap (`This operation is only allowed bootstrap mode`),
    // so a runtime PATCH that changed mailServerHostname could only
    // update the platform_settings DB row — leaving Stalwart, the
    // SMTP 220 banner, the cert SAN, every client domain's MX/SRV
    // records, and the outbound EHLO all stale. Reject the field
    // explicitly with a 400 + clear pointer to the rename runbook so
    // operators don't end up with a half-migrated cluster. The field
    // remains in the Zod schema for backward compatibility (existing
    // API clients won't error on the request shape) but the runtime
    // gate replaces the silent half-migration with a loud failure.
    if (parsed.data.mailServerHostname !== undefined) {
      throw new ApiError(
        'MAIL_HOSTNAME_IMMUTABLE',
        'Mail server hostname is fixed at install time. Stalwart 0.16 locks the Bootstrap.serverHostname value once written, so runtime renames would leave the running server, the cert SAN, and every client domain DNS record out of sync. Rename requires a maintenance-window snapshot+rebootstrap procedure — see the rename runbook.',
        400,
        { field: 'mailServerHostname' },
      );
    }

    const settings = await updateWebmailSettings(app.db, parsed.data);

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

  // 2026-05-07: POST /admin/mail/certificate/ensure removed.
  //
  // The endpoint provisioned a cert-manager Certificate CR for the
  // Stalwart mail hostname — that path was the v0.15 architecture
  // where the Stalwart pod mounted the resulting Secret. Cut 3
  // moved Stalwart cert lifecycle into Stalwart itself
  // (Bootstrap.requestTlsCertificate=true + AcmeProvider Http01),
  // so a cert-manager Cert CR for the mail hostname is no longer
  // mounted anywhere — calling this endpoint produced a Cert
  // resource Stalwart didn't observe, masking the real issue
  // (Stalwart's own ACME loop) when operators thought they were
  // re-issuing.
  //
  // Operators triggering manual cert re-issue now use:
  //   1. Inspect: GET /admin/email-settings/ssl-status
  //   2. Update Domain.certificateManagement.subjectAlternativeNames
  //      via the Stalwart admin UI (or stalwart-cli)
  //   3. POST Action=ReloadTlsCertificates + roll the pod if needed
  //
  // The corresponding ensureMailServerCertificate() in
  // certificates/service.ts is now dead code; flagged for removal
  // in the next v0.15 cleanup pass.
}
