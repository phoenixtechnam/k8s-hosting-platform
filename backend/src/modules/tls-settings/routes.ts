import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { getTlsSettings, updateTlsSettings } from './service.js';
import { listClusterIssuers } from './cluster-issuers.js';

export async function tlsSettingsRoutes(app: FastifyInstance): Promise<void> {
  // ─── GET /api/v1/admin/cluster-issuers ──────────────────────────────────
  // Returns a list of cert-manager ClusterIssuer names so the UI can
  // render a dropdown. Returns [] if cert-manager isn't reachable — UI
  // falls back to free text.

  app.get('/admin/cluster-issuers', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
    schema: {
      tags: ['TLS Settings'],
      summary: 'List cert-manager ClusterIssuers',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const issuers = await listClusterIssuers();
    return success(issuers);
  });

  // ─── GET /api/v1/admin/tls-settings ─────────────────────────────────────

  app.get('/admin/tls-settings', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
    schema: {
      tags: ['TLS Settings'],
      summary: 'Get TLS / cert-manager settings',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const settings = await getTlsSettings(app.db);
    return success(settings);
  });

  // ─── PATCH /api/v1/admin/tls-settings ───────────────────────────────────

  app.patch('/admin/tls-settings', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
    schema: {
      tags: ['TLS Settings'],
      summary: 'Update TLS / cert-manager settings',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        properties: {
          clusterIssuerName: { type: 'string', minLength: 1, maxLength: 255 },
          autoTlsEnabled: { type: 'boolean' },
        },
      },
    },
  }, async (request) => {
    const body = request.body as {
      clusterIssuerName?: string;
      autoTlsEnabled?: boolean;
    };
    const settings = await updateTlsSettings(app.db, body);
    return success(settings);
  });
}
