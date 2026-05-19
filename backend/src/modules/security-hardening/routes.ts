/**
 * Security / Firewall / Node Hardening admin routes.
 *
 *   GET  /admin/security-hardening          — full snapshot envelope
 *   POST /admin/security-hardening/refresh  — bump probe DaemonSet annotation
 *   GET  /admin/security/waf-events         — cluster-wide ModSec/CRS events
 *
 * All endpoints are super_admin only. The snapshot is the highest-
 * level posture surface in the platform — surfaces SSH exposure,
 * firewall mode, CIS findings, and the Phase 2 augmentation cards.
 * The refresh endpoint patches the DaemonSet template annotation,
 * which causes a rolling restart of all probe pods. waf-events
 * queries the waf_logs table populated by the existing
 * waf-log-scraper (modules/ingress-routes/waf-log-scraper.ts).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { buildSecurityHardeningSnapshot, triggerProbeRefresh } from './service.js';
import { loadSecurityHardeningClients } from './k8s-client.js';
import { listWafEvents } from './waf-events.js';
import { wafEventsQuerySchema } from '@k8s-hosting/api-contracts';

interface AuthedRequest {
  readonly user?: { readonly sub?: string };
}

function userOf(req: AuthedRequest): string {
  return req.user?.sub ?? 'unknown';
}

export interface SecurityHardeningDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly db: NodePgDatabase<any>;
}

export function buildSecurityHardeningRoutes(deps: SecurityHardeningDeps) {
  return async function securityHardeningRoutes(app: FastifyInstance): Promise<void> {
    app.addHook('onRequest', authenticate);
    const cfg = app.config as Record<string, unknown>;
    const k8sOpts = { kubeconfigPath: cfg.KUBECONFIG_PATH as string | undefined };

    app.get(
      '/admin/security-hardening',
      { preHandler: requireRole('super_admin') },
      async () => {
        const clients = await loadSecurityHardeningClients(k8sOpts);
        const snapshot = await buildSecurityHardeningSnapshot({
          db: deps.db,
          core: clients.core,
          custom: clients.custom,
          apps: clients.apps,
        });
        return success(snapshot);
      },
    );

    app.post(
      '/admin/security-hardening/refresh',
      { preHandler: requireRole('super_admin') },
      async (req: AuthedRequest) => {
        const userId = userOf(req);
        app.log.warn({ userId }, 'security-hardening: probe refresh triggered');
        const podsTouched = await triggerProbeRefresh(k8sOpts);
        return success({
          triggeredAt: new Date().toISOString(),
          podsTouched,
        });
      },
    );

    app.get(
      '/admin/security/waf-events',
      { preHandler: requireRole('super_admin') },
      async (req: FastifyRequest, reply: FastifyReply) => {
        const parsed = wafEventsQuerySchema.safeParse(req.query ?? {});
        if (!parsed.success) {
          return reply.status(400).send({
            error: 'INVALID_QUERY',
            message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          });
        }
        const response = await listWafEvents(deps.db, parsed.data);
        return success(response);
      },
    );
  };
}
