import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import * as service from './service.js';
import { reconcileIngressHosts, extractHost } from './ingress-reconciler.js';
import {
  probeUrlHealth,
  createDefaultUrlHealthDeps,
  type UrlHealthReport,
} from './url-health.js';
import { z } from 'zod';

// 60s health cache: DNS lookups + k8s Certificate reads are both cheap but
// not free, and the UI polls every 30s. Keyed by `${host}::${secretName}`
// so hostname changes invalidate automatically.
interface HealthCacheEntry {
  readonly expiresAt: number;
  readonly report: UrlHealthReport;
}
const HEALTH_CACHE = new Map<string, HealthCacheEntry>();
const HEALTH_CACHE_TTL_MS = 60_000;

/**
 * Resolve the TLS Secret name referenced by Ingress.spec.tls[0].secretName.
 * ConfigMap (prod: bootstrap.sh, dev: platform-config-patch.yaml) is the
 * canonical source. Defaults to `platform-tls` — the prod convention — so
 * a misconfigured deploy fails noisily (no matching Secret) rather than
 * silently binding to a dev-specific name.
 */
function resolveTlsSecretName(config: unknown): string {
  const cfg = config as Record<string, unknown>;
  const fromEnv = cfg.PLATFORM_TLS_SECRET_NAME as string | undefined;
  return fromEnv && fromEnv.trim() !== '' ? fromEnv.trim() : 'platform-tls';
}

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
      const tlsSecretName = resolveTlsSecretName(app.config);
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

    // PATCH invalidates the health cache for these hosts so the next UI
    // poll probes fresh values instead of the 60s-old ones.
    if (parsed.data.adminPanelUrl !== undefined || parsed.data.clientPanelUrl !== undefined) {
      HEALTH_CACHE.clear();
    }

    return success(updated);
  });

  // GET /api/v1/admin/system-settings/url-health
  //
  // Probe DNS resolvability + TLS certificate status for both panel URLs.
  // Cached per host+secret for 60s so the UI can poll (default 30s) cheaply.
  // Never returns 500 for probe failures — status enums convey the failure
  // shape so the badge can render consistently.
  app.get('/admin/system-settings/url-health', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
    schema: {
      tags: ['System Settings'],
      summary: 'DNS + TLS health check for admin/client panel URLs',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const settings = await service.getSettings(app.db);
    const cfg = app.config as Record<string, unknown>;
    const tlsSecretName = resolveTlsSecretName(app.config);
    const certNamespace = (cfg.PLATFORM_NAMESPACE as string | undefined) ?? 'platform';
    const kubeconfigPath = cfg.KUBECONFIG_PATH as string | undefined;

    const adminHost = extractHost(settings.adminPanelUrl);
    const clientHost = extractHost(settings.clientPanelUrl);
    const deps = createDefaultUrlHealthDeps({ kubeconfigPath });

    const probe = async (host: string | null): Promise<UrlHealthReport> => {
      const cacheKey = `${host ?? ''}::${tlsSecretName}`;
      const now = Date.now();
      const cached = HEALTH_CACHE.get(cacheKey);
      if (cached && cached.expiresAt > now) return cached.report;
      const report = await probeUrlHealth(
        { host, certSecretName: tlsSecretName, certNamespace },
        deps,
      );
      HEALTH_CACHE.set(cacheKey, { expiresAt: now + HEALTH_CACHE_TTL_MS, report });
      return report;
    };

    const [admin, client] = await Promise.all([probe(adminHost), probe(clientHost)]);
    return success({ admin, client });
  });
}
