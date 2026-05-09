import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import {
  applyMailServerHostnameToStalwart,
  getWebmailSettings,
  updateWebmailSettings,
  withMailHostnameLock,
} from './service.js';
import { updateWebmailSettingsSchema } from '@k8s-hosting/api-contracts';
import { reconcileOutboundConfig } from '../email-outbound/service.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { auditLogs } from '../../db/schema.js';
import crypto from 'node:crypto';

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

    // 2026-05-09: mailServerHostname is editable post-bootstrap.
    // Stalwart 0.16's Bootstrap object is a transient install-only
    // singleton (not "locked" — empirically confirmed it returns
    // notFound after install). The runtime hostname source-of-truth
    // is `SystemSettings.defaultHostname`, which drives BOTH inbound
    // listener banners AND outbound EHLO uniformly via
    // `MtaConnectionStrategy`'s null-fallback path.
    //
    // Update flow when the operator submits a new hostname:
    //   1. Push the new value to Stalwart via JMAP first. If Stalwart
    //      rejects (validation, missing Domain row, network), we
    //      DON'T persist to platform_settings — that prevents the
    //      DB row from drifting ahead of the running server.
    //   2. Only after Stalwart accepts do we save the platform_settings
    //      row, so subsequent reads stay consistent with what the
    //      live mail server is announcing.
    //
    // Operator-side caveats (NOT enforced here, NOT auto-applied):
    //   - The cert SAN must include the new hostname for STARTTLS to
    //     match. Stalwart re-issues only when the Domain row's
    //     subjectAlternativeNames is updated and the ACME loop fires.
    //   - DNS MX + A records must point at the cluster.
    //   - Reverse DNS / FCrDNS at the IP-provider level for outbound
    //     deliverability.
    // Returning the previous value in the response gives the operator
    // a confirmation handle for rollback.
    let stalwartUpdate:
      | { defaultDomainId: string; previousHostname: string }
      | undefined;

    // Hostname change path is locked end-to-end (advisory xact lock)
    // so concurrent PATCHes serialize. The non-hostname path stays
    // unlocked — defaultWebmailUrl + emailSendRateLimitDefault are
    // independent rows where last-write-wins is acceptable.
    const settings = await withMailHostnameLock(app.db, async () => {
      if (parsed.data.mailServerHostname !== undefined) {
        try {
          stalwartUpdate = await applyMailServerHostnameToStalwart(
            parsed.data.mailServerHostname,
          );
        } catch (err) {
          throw new ApiError(
            'MAIL_HOSTNAME_APPLY_FAILED',
            `Failed to update Stalwart's defaultHostname: ${
              err instanceof Error ? err.message : String(err)
            }. The platform-settings DB row was NOT updated to keep it consistent with the live server.`,
            502,
            { field: 'mailServerHostname' },
          );
        }
      }
      return updateWebmailSettings(app.db, parsed.data);
    });

    if (stalwartUpdate) {
      app.log.info(
        {
          previousHostname: stalwartUpdate.previousHostname,
          newHostname: parsed.data.mailServerHostname,
          defaultDomainId: stalwartUpdate.defaultDomainId,
        },
        'mail-server-hostname: Stalwart SystemSettings.defaultHostname updated',
      );
      // Persist a queryable audit record so a forensic review of "who
      // renamed the mail hostname and when" has a discoverable answer.
      // Mail-hostname changes affect SMTP banners, cert SAN
      // requirements, and outbound deliverability for all clients —
      // structured logs alone (which rotate) aren't sufficient.
      try {
        await app.db.insert(auditLogs).values({
          id: crypto.randomUUID(),
          actorId: (request.user as { sub?: string } | undefined)?.sub ?? 'system',
          actorType: 'user',
          actionType: 'platform_settings.mail_hostname_rename',
          resourceType: 'platform_settings',
          resourceId: 'mail_server_hostname',
          changes: {
            previousHostname: stalwartUpdate.previousHostname,
            newHostname: parsed.data.mailServerHostname,
            defaultDomainId: stalwartUpdate.defaultDomainId,
          } as unknown as Record<string, unknown>,
        });
      } catch (err) {
        // Don't fail the rename if audit-log insert hits a transient
        // DB error — the rename itself already succeeded. Log loudly
        // so the operator can investigate the audit-log gap.
        app.log.error(
          { err, newHostname: parsed.data.mailServerHostname },
          'mail-server-hostname: audit_logs insert failed after successful Stalwart apply',
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
