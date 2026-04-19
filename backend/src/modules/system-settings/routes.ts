import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import * as service from './service.js';
import { reconcileIngressHosts } from './ingress-reconciler.js';
import { z } from 'zod';

const updateSchema = z.object({
  platformName: z.string().min(1).max(255).optional(),
  adminPanelUrl: z.string().url().max(500).optional().nullable(),
  clientPanelUrl: z.string().url().max(500).optional().nullable(),
  supportEmail: z.string().email().max(255).optional().nullable(),
  supportUrl: z.string().url().max(500).optional().nullable(),
  ingressBaseDomain: z.string().max(255).optional().nullable(),
  apiRateLimit: z.number().int().min(1).max(10000).optional(),
  // IANA timezone string. Used as the fallback on new clients that don't
  // specify their own timezone, and as the global default for UI date
  // rendering when a user has no per-user override.
  timezone: z.string().min(1).max(50).optional(),
  // Deprecated here — mailHostname + webmailUrl moved to /admin/webmail-settings
  // in the 2026-04-19 consolidation. Accept silently for backwards compat so
  // existing tooling doesn't break; the service layer ignores them.
  mailHostname: z.string().max(255).optional().nullable(),
  webmailUrl: z.string().url().max(500).optional().nullable(),
});

export async function systemSettingsRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v1/system-info — PUBLIC (no auth). Returns the subset of
  // system settings that are safe to expose to unauthenticated visitors:
  // branding (platform name), support links, and the admin/client panel
  // URLs used for email templates and cross-panel redirects. Consumed by
  // both frontends on boot (login page, footer) and by the main shell to
  // set document.title.
  app.get('/system-info', {
    schema: {
      tags: ['System Settings'],
      summary: 'Public platform branding + support info (no auth required)',
    },
  }, async () => {
    const settings = await service.getSettings(app.db);
    return success({
      platformName: settings.platformName,
      supportEmail: settings.supportEmail ?? null,
      supportUrl: settings.supportUrl ?? null,
      adminPanelUrl: settings.adminPanelUrl ?? null,
      clientPanelUrl: settings.clientPanelUrl ?? null,
    });
  });

  // GET /api/v1/admin/system-settings
  app.get('/admin/system-settings', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
    schema: { tags: ['System Settings'], summary: 'Get platform system settings', security: [{ bearerAuth: [] }] },
  }, async () => {
    const settings = await service.getSettings(app.db);
    return success(settings);
  });

  // PATCH /api/v1/admin/system-settings
  app.patch('/admin/system-settings', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
    schema: { tags: ['System Settings'], summary: 'Update platform system settings', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('INVALID_FIELD_VALUE', parsed.error.errors[0].message, 400);
    }

    const updated = await service.updateSettings(app.db, parsed.data);

    // If either panel URL changed, reconcile the Ingress hosts so traffic
    // to the new hostname is actually served. Non-blocking on failure —
    // the DB write is the authoritative change; the reconciler will retry
    // on next startup if this call hits a transient k8s error.
    if (parsed.data.adminPanelUrl !== undefined || parsed.data.clientPanelUrl !== undefined) {
      const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
      const tlsSecretName = (app.config as Record<string, unknown>).PLATFORM_TLS_SECRET_NAME as string | undefined
        ?? 'platform-dev-tls';
      const clusterIssuerName = (app.config as Record<string, unknown>).CLUSTER_ISSUER_NAME as string | undefined;
      try {
        const result = await reconcileIngressHosts(
          {
            adminPanelUrl: updated.adminPanelUrl ?? null,
            clientPanelUrl: updated.clientPanelUrl ?? null,
            tlsSecretName,
          },
          undefined,
          { kubeconfigPath, clusterIssuerName },
        );
        if (result.changed) {
          app.log.info(
            { adminPanelUrl: updated.adminPanelUrl, clientPanelUrl: updated.clientPanelUrl },
            'system-settings: ingress hosts reconciled',
          );
        }
      } catch (err) {
        app.log.warn(
          { err, adminPanelUrl: updated.adminPanelUrl, clientPanelUrl: updated.clientPanelUrl },
          'system-settings: ingress reconcile failed (non-blocking)',
        );
      }
    }

    return success(updated);
  });
}
