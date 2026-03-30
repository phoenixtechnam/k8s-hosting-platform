import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { getTlsSettings, updateTlsSettings } from './service.js';

export async function tlsSettingsRoutes(app: FastifyInstance): Promise<void> {
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
