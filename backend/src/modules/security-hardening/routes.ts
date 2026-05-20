/**
 * Security / Firewall / Node Hardening admin routes.
 *
 *   GET  /admin/security-hardening              — full snapshot envelope
 *   POST /admin/security-hardening/refresh      — bump probe DaemonSet annotation
 *   GET  /admin/security/waf-events             — cluster-wide ModSec/CRS events
 *   POST /admin/security/waf-events/refresh     — force one immediate scrape cycle
 *
 * All endpoints are super_admin only. The snapshot is the highest-
 * level posture surface in the platform — surfaces SSH exposure,
 * firewall mode, CIS findings, and the Phase 2 augmentation cards.
 * The probe-refresh endpoint patches the DaemonSet template annotation,
 * which causes a rolling restart of all probe pods. waf-events
 * queries the waf_logs table populated by the existing
 * waf-log-scraper (modules/ingress-routes/waf-log-scraper.ts);
 * waf-events/refresh runs one scrape cycle inline so an operator
 * doesn't have to wait the 30s for the next scheduled tick.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { buildSecurityHardeningSnapshot, triggerProbeRefresh } from './service.js';
import { loadSecurityHardeningClients } from './k8s-client.js';
import { listWafEvents } from './waf-events.js';
import { wafEventsQuerySchema } from '@k8s-hosting/api-contracts';
import { scrapeWafLogs, getScraperStatus } from '../ingress-routes/waf-log-scraper.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import {
  addBan,
  addStaticBan,
  deleteDecisionById,
  getStatus as getCrowdsecStatus,
  listDecisions,
} from './crowdsec.js';
import {
  addAllowlistEntry,
  listAllowlistEntries,
  removeAllowlistEntry,
} from './crowdsec-allowlists.js';
import {
  crowdsecAddAllowlistRequestSchema,
  crowdsecAddBanRequestSchema,
  crowdsecAddStaticBanRequestSchema,
  crowdsecAutobanPatchConfigRequestSchema,
  crowdsecListDecisionsQuerySchema,
} from '@k8s-hosting/api-contracts';
import { listRecentRuns, loadConfig as loadAutobanConfig, SETTING_KEYS as AUTOBAN_SETTING_KEYS } from '../crowdsec-autoban/scheduler.js';
import { sql } from 'drizzle-orm';

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

    // Rate-limit immediate-refresh to once per 3s per process. The scraper
    // reads modsec pod logs over the K8s API, and the live-tail toggle
    // in the UI refetches every 3s — without a floor an over-eager
    // operator could trigger an inline scrape per refetch and pin kube-API.
    let lastRefreshAt = 0;
    const REFRESH_MIN_GAP_MS = 3_000;

    app.post(
      '/admin/security/waf-events/refresh',
      { preHandler: requireRole('super_admin') },
      async (req: AuthedRequest, reply: FastifyReply) => {
        const now = Date.now();
        if (now - lastRefreshAt < REFRESH_MIN_GAP_MS) {
          // Don't run the cycle — surface current status so the UI can
          // still update its "last scraper run" indicator.
          const s = getScraperStatus();
          return reply.status(429).send({
            error: 'RATE_LIMITED',
            message: `Refresh allowed once per ${REFRESH_MIN_GAP_MS / 1000}s.`,
            retryAfterMs: REFRESH_MIN_GAP_MS - (now - lastRefreshAt),
            scraperStatus: s,
          });
        }
        lastRefreshAt = now;
        const userId = userOf(req);
        app.log.info({ userId }, 'waf-events: manual scraper refresh triggered');
        const k8s = createK8sClients(k8sOpts.kubeconfigPath);
        try {
          const result = await scrapeWafLogs(deps.db, k8s);
          return success({
            triggeredAt: new Date(now).toISOString(),
            scraped: result.scraped,
            inserted: result.inserted,
            modsecPodFound: getScraperStatus().modsecPodFound,
            errors: result.errors,
          });
        } catch (err) {
          // Don't 500 — surface the error in the response so the UI can
          // render it next to the empty state.
          return success({
            triggeredAt: new Date(now).toISOString(),
            scraped: 0,
            inserted: 0,
            modsecPodFound: getScraperStatus().modsecPodFound,
            errors: [err instanceof Error ? err.message : String(err)],
          });
        }
      },
    );

    // ─── CrowdSec / Banned IPs ────────────────────────────────────────────

    const kubeconfigPath = k8sOpts.kubeconfigPath;

    app.get(
      '/admin/security/crowdsec/decisions',
      { preHandler: requireRole('super_admin') },
      async (req: FastifyRequest, reply: FastifyReply) => {
        const parsed = crowdsecListDecisionsQuerySchema.safeParse(req.query ?? {});
        if (!parsed.success) {
          return reply.status(400).send({
            error: 'INVALID_QUERY',
            message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          });
        }
        try {
          const response = await listDecisions(kubeconfigPath, parsed.data);
          return success(response);
        } catch (err) {
          return reply.status(502).send({
            error: 'CROWDSEC_UNREACHABLE',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      },
    );

    app.post(
      '/admin/security/crowdsec/decisions',
      { preHandler: requireRole('super_admin') },
      async (req: AuthedRequest & FastifyRequest, reply: FastifyReply) => {
        const parsed = crowdsecAddBanRequestSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          return reply.status(400).send({
            error: 'INVALID_BODY',
            message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          });
        }
        const actor = userOf(req as AuthedRequest);
        app.log.warn({ actor, ban: parsed.data }, 'crowdsec: manual ban added');
        try {
          const result = await addBan(kubeconfigPath, parsed.data, actor);
          return success({
            message: result.message,
            value: parsed.data.value,
            scope: parsed.data.scope,
            duration: parsed.data.duration,
            reason: parsed.data.reason,
          });
        } catch (err) {
          return reply.status(502).send({
            error: 'CROWDSEC_BAN_FAILED',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      },
    );

    app.delete(
      '/admin/security/crowdsec/decisions/:id',
      { preHandler: requireRole('super_admin') },
      async (req: AuthedRequest & FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const n = Number(id);
        if (!Number.isInteger(n) || n < 0) {
          return reply.status(400).send({ error: 'INVALID_ID', message: 'id must be a non-negative integer' });
        }
        const actor = userOf(req as AuthedRequest);
        app.log.warn({ actor, decisionId: n }, 'crowdsec: decision deletion (unban)');
        try {
          const result = await deleteDecisionById(kubeconfigPath, n);
          return success(result);
        } catch (err) {
          return reply.status(502).send({
            error: 'CROWDSEC_UNBAN_FAILED',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      },
    );

    app.get(
      '/admin/security/crowdsec/status',
      { preHandler: requireRole('super_admin') },
      async (_req: FastifyRequest, reply: FastifyReply) => {
        try {
          const status = await getCrowdsecStatus(kubeconfigPath);
          return success(status);
        } catch (err) {
          return reply.status(502).send({
            error: 'CROWDSEC_STATUS_FAILED',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      },
    );

    // ─── F2 — Allowlist (cscli allowlists wrapper) ──────────────────────

    app.get(
      '/admin/security/crowdsec/allowlist',
      { preHandler: requireRole('super_admin') },
      async (_req: FastifyRequest, reply: FastifyReply) => {
        try {
          const entries = await listAllowlistEntries(kubeconfigPath);
          return success({ entries });
        } catch (err) {
          return reply.status(502).send({
            error: 'CROWDSEC_ALLOWLIST_LIST_FAILED',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      },
    );

    app.post(
      '/admin/security/crowdsec/allowlist',
      { preHandler: requireRole('super_admin') },
      async (req: AuthedRequest & FastifyRequest, reply: FastifyReply) => {
        const parsed = crowdsecAddAllowlistRequestSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          return reply.status(400).send({
            error: 'INVALID_BODY',
            message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          });
        }
        const actor = userOf(req as AuthedRequest);
        app.log.warn({ actor, entry: parsed.data }, 'crowdsec: allowlist entry added');
        try {
          const result = await addAllowlistEntry(kubeconfigPath, parsed.data, actor);
          return success({
            message: result.message,
            value: parsed.data.value,
            scope: parsed.data.scope,
            comment: parsed.data.comment,
          });
        } catch (err) {
          return reply.status(502).send({
            error: 'CROWDSEC_ALLOWLIST_ADD_FAILED',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      },
    );

    app.delete(
      '/admin/security/crowdsec/allowlist/:value',
      { preHandler: requireRole('super_admin') },
      async (req: AuthedRequest & FastifyRequest, reply: FastifyReply) => {
        const { value } = req.params as { value: string };
        const decoded = decodeURIComponent(value);
        // Strict regex match — value is interpolated into the cscli argv.
        if (!/^[a-fA-F0-9.:/]+$/.test(decoded) || decoded.length > 64) {
          return reply.status(400).send({
            error: 'INVALID_VALUE',
            message: 'value must be an IP or CIDR (≤64 chars, [a-fA-F0-9.:/]+)',
          });
        }
        const actor = userOf(req as AuthedRequest);
        app.log.warn({ actor, value: decoded }, 'crowdsec: allowlist entry removed');
        try {
          const result = await removeAllowlistEntry(kubeconfigPath, decoded);
          return success(result);
        } catch (err) {
          return reply.status(502).send({
            error: 'CROWDSEC_ALLOWLIST_REMOVE_FAILED',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      },
    );

    // ─── F2 — Static (long-duration) operator ban ───────────────────────

    app.post(
      '/admin/security/crowdsec/static-blocklist',
      { preHandler: requireRole('super_admin') },
      async (req: AuthedRequest & FastifyRequest, reply: FastifyReply) => {
        const parsed = crowdsecAddStaticBanRequestSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          return reply.status(400).send({
            error: 'INVALID_BODY',
            message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          });
        }
        const actor = userOf(req as AuthedRequest);
        app.log.warn({ actor, ban: parsed.data }, 'crowdsec: static ban added (1y duration)');
        try {
          const result = await addStaticBan(kubeconfigPath, parsed.data, actor);
          return success({
            message: result.message,
            value: parsed.data.value,
            scope: parsed.data.scope,
            duration: '8760h',
            reason: parsed.data.reason,
          });
        } catch (err) {
          return reply.status(502).send({
            error: 'CROWDSEC_STATIC_BAN_FAILED',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      },
    );

    // ─── F3 — WAF auto-ban config + runs ────────────────────────────────

    app.get(
      '/admin/security/crowdsec/autoban/config',
      { preHandler: requireRole('super_admin') },
      async (_req: FastifyRequest, reply: FastifyReply) => {
        try {
          const config = await loadAutobanConfig(deps.db);
          return success(config);
        } catch (err) {
          return reply.status(500).send({
            error: 'AUTOBAN_CONFIG_LOAD_FAILED',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      },
    );

    app.patch(
      '/admin/security/crowdsec/autoban/config',
      { preHandler: requireRole('super_admin') },
      async (req: AuthedRequest & FastifyRequest, reply: FastifyReply) => {
        const parsed = crowdsecAutobanPatchConfigRequestSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          return reply.status(400).send({
            error: 'INVALID_BODY',
            message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          });
        }
        const actor = userOf(req as AuthedRequest);
        app.log.warn({ actor, patch: parsed.data }, 'crowdsec-autoban: config patched');
        // Persist each provided key into platform_settings.
        const entries: [string, string][] = [];
        const p = parsed.data;
        if (p.enabled !== undefined) entries.push([AUTOBAN_SETTING_KEYS.enabled, String(p.enabled)]);
        if (p.windowSeconds !== undefined) entries.push([AUTOBAN_SETTING_KEYS.windowSeconds, String(p.windowSeconds)]);
        if (p.eventThreshold !== undefined) entries.push([AUTOBAN_SETTING_KEYS.eventThreshold, String(p.eventThreshold)]);
        if (p.minSeverity !== undefined) entries.push([AUTOBAN_SETTING_KEYS.minSeverity, p.minSeverity]);
        if (p.initialBanDuration !== undefined) entries.push([AUTOBAN_SETTING_KEYS.initialBanDuration, p.initialBanDuration]);
        if (p.repeatBackoffMultiplier !== undefined) entries.push([AUTOBAN_SETTING_KEYS.repeatBackoffMultiplier, String(p.repeatBackoffMultiplier)]);
        if (p.maxBanDuration !== undefined) entries.push([AUTOBAN_SETTING_KEYS.maxBanDuration, p.maxBanDuration]);
        if (p.excludedRuleIds !== undefined) entries.push([AUTOBAN_SETTING_KEYS.excludedRuleIds, p.excludedRuleIds.join(',')]);
        if (p.includeTenantRoutes !== undefined) entries.push([AUTOBAN_SETTING_KEYS.includeTenantRoutes, String(p.includeTenantRoutes)]);
        for (const [key, value] of entries) {
          await deps.db.execute(sql`
            INSERT INTO platform_settings (key, value, updated_at)
            VALUES (${key}, ${value}, NOW())
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
          `);
        }
        const final = await loadAutobanConfig(deps.db);
        return success(final);
      },
    );

    app.get(
      '/admin/security/crowdsec/autoban/runs',
      { preHandler: requireRole('super_admin') },
      async (req: FastifyRequest, reply: FastifyReply) => {
        const limit = Number((req.query as { limit?: string }).limit ?? 50);
        try {
          const rows = await listRecentRuns(deps.db, limit);
          return success({
            runs: rows.map((r) => ({
              id: r.id,
              triggeredAt: r.triggeredAt instanceof Date ? r.triggeredAt.toISOString() : new Date(r.triggeredAt as unknown as string).toISOString(),
              sourceIp: r.sourceIp,
              hostname: r.hostname,
              ruleIds: r.ruleIds ?? [],
              eventCount: r.eventCount,
              windowSeconds: r.windowSeconds,
              banDuration: r.banDuration,
              banId: r.banId,
              outcome: r.outcome,
              outcomeDetail: r.outcomeDetail,
            })),
          });
        } catch (err) {
          return reply.status(500).send({
            error: 'AUTOBAN_RUNS_LOAD_FAILED',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      },
    );
  };
}
