/**
 * Route-level ingress settings service.
 *
 * Manages per-route redirect, security, WAF, and advanced settings.
 * Also handles basic-auth user CRUD and WAF log lifecycle.
 */

import { eq, and, desc, sql } from 'drizzle-orm';
import { ingressRoutes, wafLogs, domains } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import {
  autoProvisionRouteDns,
  autoDeleteRouteDns,
  getWwwCompanionHostname,
} from './service.js';
import type { Database } from '../../db/index.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

async function getRouteOrThrow(db: Database, routeId: string) {
  const [route] = await db.select().from(ingressRoutes).where(eq(ingressRoutes.id, routeId));
  if (!route) {
    throw new ApiError('ROUTE_NOT_FOUND', `Ingress route '${routeId}' not found`, 404);
  }
  return route;
}

async function verifyRouteOwnership(db: Database, routeId: string, clientId: string) {
  const route = await getRouteOrThrow(db, routeId);

  const [domain] = await db
    .select()
    .from(domains)
    .where(and(eq(domains.id, route.domainId), eq(domains.clientId, clientId)));

  if (!domain) {
    throw new ApiError('ROUTE_NOT_FOUND', `Ingress route '${routeId}' not found for client`, 404);
  }

  return route;
}

export function mapRouteToResponse(row: typeof ingressRoutes.$inferSelect) {
  return {
    ...row,
    forceHttps: Boolean(row.forceHttps),
    wafEnabled: Boolean(row.wafEnabled),
    wafOwaspCrs: Boolean(row.wafOwaspCrs),
    createdAt: row.createdAt?.toISOString?.() ?? row.createdAt,
    updatedAt: row.updatedAt?.toISOString?.() ?? row.updatedAt,
  };
}

async function fetchUpdatedRoute(db: Database, routeId: string) {
  const [updated] = await db.select().from(ingressRoutes).where(eq(ingressRoutes.id, routeId));
  return mapRouteToResponse(updated);
}

// ─── Redirect Settings ──────────────────────────────────────────────────────

export async function updateRedirectSettings(
  db: Database,
  routeId: string,
  clientId: string,
  input: Record<string, unknown>,
) {
  const route = await verifyRouteOwnership(db, routeId, clientId);

  const updateValues: Record<string, unknown> = {};
  if (input.force_https !== undefined) updateValues.forceHttps = input.force_https ? 1 : 0;
  if (input.www_redirect !== undefined) updateValues.wwwRedirect = input.www_redirect;
  if (input.redirect_url !== undefined) updateValues.redirectUrl = input.redirect_url;

  if (Object.keys(updateValues).length > 0) {
    await db.update(ingressRoutes).set(updateValues).where(eq(ingressRoutes.id, routeId));
  }

  // Handle companion DNS when wwwRedirect changes
  if (input.www_redirect !== undefined && input.www_redirect !== route.wwwRedirect) {
    const newWww = input.www_redirect as string;
    const oldWww = route.wwwRedirect;

    // Delete old companion DNS if the previous setting had one
    const oldCompanion = getWwwCompanionHostname(route.hostname, oldWww);
    if (oldCompanion) {
      try {
        await autoDeleteRouteDns(db, route.domainId, oldCompanion);
      } catch {
        // Non-blocking
      }
    }

    // Provision new companion DNS if the new setting needs one
    const newCompanion = getWwwCompanionHostname(route.hostname, newWww);
    if (newCompanion) {
      try {
        await autoProvisionRouteDns(db, route.domainId, newCompanion);
      } catch {
        // Non-blocking
      }
    }
  }

  return fetchUpdatedRoute(db, routeId);
}

// ─── Security Settings ──────────────────────────────────────────────────────

export async function updateSecuritySettings(
  db: Database,
  routeId: string,
  clientId: string,
  input: Record<string, unknown>,
) {
  await verifyRouteOwnership(db, routeId, clientId);

  const updateValues: Record<string, unknown> = {};
  if (input.ip_allowlist !== undefined) updateValues.ipAllowlist = input.ip_allowlist;
  if (input.rate_limit_rps !== undefined) updateValues.rateLimitRps = input.rate_limit_rps;
  if (input.rate_limit_connections !== undefined) updateValues.rateLimitConnections = input.rate_limit_connections;
  if (input.rate_limit_burst_multiplier !== undefined) {
    updateValues.rateLimitBurstMultiplier = input.rate_limit_burst_multiplier !== null
      ? String(input.rate_limit_burst_multiplier)
      : null;
  }
  if (input.waf_enabled !== undefined) updateValues.wafEnabled = input.waf_enabled ? 1 : 0;
  if (input.waf_owasp_crs !== undefined) updateValues.wafOwaspCrs = input.waf_owasp_crs ? 1 : 0;
  if (input.waf_anomaly_threshold !== undefined) updateValues.wafAnomalyThreshold = input.waf_anomaly_threshold;
  if (input.waf_excluded_rules !== undefined) updateValues.wafExcludedRules = input.waf_excluded_rules;

  if (Object.keys(updateValues).length > 0) {
    await db.update(ingressRoutes).set(updateValues).where(eq(ingressRoutes.id, routeId));
  }

  return fetchUpdatedRoute(db, routeId);
}

// ─── Advanced Settings ──────────────────────────────────────────────────────

export async function updateAdvancedSettings(
  db: Database,
  routeId: string,
  clientId: string,
  input: Record<string, unknown>,
) {
  await verifyRouteOwnership(db, routeId, clientId);

  const updateValues: Record<string, unknown> = {};
  if (input.custom_error_codes !== undefined) updateValues.customErrorCodes = input.custom_error_codes;
  if (input.custom_error_path !== undefined) updateValues.customErrorPath = input.custom_error_path;
  if (input.additional_headers !== undefined) updateValues.additionalHeaders = input.additional_headers;

  if (Object.keys(updateValues).length > 0) {
    await db.update(ingressRoutes).set(updateValues).where(eq(ingressRoutes.id, routeId));
  }

  return fetchUpdatedRoute(db, routeId);
}

// ─── WAF Logs ───────────────────────────────────────────────────────────────

export async function listWafLogs(db: Database, routeId: string, limit = 50) {
  const capped = Math.min(limit, 100);
  return db
    .select()
    .from(wafLogs)
    .where(eq(wafLogs.routeId, routeId))
    .orderBy(desc(wafLogs.createdAt))
    .limit(capped);
}

export async function ingestWafLog(
  db: Database,
  routeId: string,
  clientId: string,
  log: {
    ruleId: string;
    severity: string;
    message: string;
    requestUri?: string | null;
    requestMethod?: string | null;
    sourceIp?: string | null;
    matchedData?: string | null;
  },
) {
  const id = crypto.randomUUID();
  await db.insert(wafLogs).values({
    id,
    routeId,
    clientId,
    ruleId: log.ruleId,
    severity: log.severity,
    message: log.message,
    requestUri: log.requestUri ?? null,
    requestMethod: log.requestMethod ?? null,
    sourceIp: log.sourceIp ?? null,
    matchedData: log.matchedData ?? null,
  });
}

export async function pruneWafLogs(db: Database, routeId: string, keepCount = 50): Promise<number> {
  // Find the Nth-newest log's createdAt, then delete everything older.
  const kept = await db
    .select({ createdAt: wafLogs.createdAt })
    .from(wafLogs)
    .where(eq(wafLogs.routeId, routeId))
    .orderBy(desc(wafLogs.createdAt))
    .limit(1)
    .offset(keepCount - 1);

  if (kept.length === 0) {
    // Fewer than keepCount rows — nothing to prune
    return 0;
  }

  const cutoff = kept[0].createdAt;
  const result = await db
    .delete(wafLogs)
    .where(
      and(
        eq(wafLogs.routeId, routeId),
        sql`${wafLogs.createdAt} < ${cutoff}`,
      ),
    );

  return (result as unknown as { rowCount?: number }).rowCount ?? 0;
}
