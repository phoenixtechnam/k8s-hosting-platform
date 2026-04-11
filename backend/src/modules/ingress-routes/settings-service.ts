/**
 * Route-level ingress settings service.
 *
 * Manages per-route redirect, security, WAF, and advanced settings.
 * Also handles basic-auth user CRUD and WAF log lifecycle.
 */

import { eq, and, desc, sql } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import { ingressRoutes, routeAuthUsers, wafLogs, domains } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import type { Database } from '../../db/index.js';

const SALT_ROUNDS = 10;

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
    basicAuthEnabled: Boolean(row.basicAuthEnabled),
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
  await verifyRouteOwnership(db, routeId, clientId);

  const updateValues: Record<string, unknown> = {};
  if (input.force_https !== undefined) updateValues.forceHttps = input.force_https ? 1 : 0;
  if (input.www_redirect !== undefined) updateValues.wwwRedirect = input.www_redirect;
  if (input.redirect_url !== undefined) updateValues.redirectUrl = input.redirect_url;

  if (Object.keys(updateValues).length > 0) {
    await db.update(ingressRoutes).set(updateValues).where(eq(ingressRoutes.id, routeId));
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
  if (input.basic_auth_enabled !== undefined) updateValues.basicAuthEnabled = input.basic_auth_enabled ? 1 : 0;
  if (input.basic_auth_realm !== undefined) updateValues.basicAuthRealm = input.basic_auth_realm;
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

// ─── Basic Auth Users CRUD ──────────────────────────────────────────────────

export async function listAuthUsers(db: Database, routeId: string) {
  const users = await db
    .select({
      id: routeAuthUsers.id,
      routeId: routeAuthUsers.routeId,
      username: routeAuthUsers.username,
      enabled: routeAuthUsers.enabled,
      createdAt: routeAuthUsers.createdAt,
    })
    .from(routeAuthUsers)
    .where(eq(routeAuthUsers.routeId, routeId));

  return users.map((u) => ({ ...u, enabled: Boolean(u.enabled) }));
}

export async function createAuthUser(
  db: Database,
  routeId: string,
  username: string,
  password: string,
) {
  // Check for duplicate username on this route
  const [existing] = await db
    .select({ id: routeAuthUsers.id })
    .from(routeAuthUsers)
    .where(and(eq(routeAuthUsers.routeId, routeId), eq(routeAuthUsers.username, username)));

  if (existing) {
    throw new ApiError('AUTH_USER_EXISTS', `User '${username}' already exists on this route`, 409);
  }

  const id = crypto.randomUUID();
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  await db.insert(routeAuthUsers).values({
    id,
    routeId,
    username,
    passwordHash,
  });

  const [created] = await db
    .select({
      id: routeAuthUsers.id,
      routeId: routeAuthUsers.routeId,
      username: routeAuthUsers.username,
      enabled: routeAuthUsers.enabled,
      createdAt: routeAuthUsers.createdAt,
    })
    .from(routeAuthUsers)
    .where(eq(routeAuthUsers.id, id));

  return { ...created, enabled: Boolean(created.enabled) };
}

export async function deleteAuthUser(db: Database, routeId: string, userId: string) {
  const [user] = await db
    .select()
    .from(routeAuthUsers)
    .where(and(eq(routeAuthUsers.id, userId), eq(routeAuthUsers.routeId, routeId)));

  if (!user) {
    throw new ApiError('AUTH_USER_NOT_FOUND', `Auth user '${userId}' not found on route`, 404);
  }

  await db.delete(routeAuthUsers).where(eq(routeAuthUsers.id, userId));
}

export async function toggleAuthUser(
  db: Database,
  routeId: string,
  userId: string,
  enabled: boolean,
) {
  const [user] = await db
    .select()
    .from(routeAuthUsers)
    .where(and(eq(routeAuthUsers.id, userId), eq(routeAuthUsers.routeId, routeId)));

  if (!user) {
    throw new ApiError('AUTH_USER_NOT_FOUND', `Auth user '${userId}' not found on route`, 404);
  }

  await db
    .update(routeAuthUsers)
    .set({ enabled: enabled ? 1 : 0 })
    .where(eq(routeAuthUsers.id, userId));
}

export async function changeAuthUserPassword(
  db: Database,
  routeId: string,
  userId: string,
  newPassword: string,
) {
  const [user] = await db
    .select()
    .from(routeAuthUsers)
    .where(and(eq(routeAuthUsers.id, userId), eq(routeAuthUsers.routeId, routeId)));

  if (!user) {
    throw new ApiError('AUTH_USER_NOT_FOUND', `Auth user '${userId}' not found on route`, 404);
  }

  const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await db.update(routeAuthUsers).set({ passwordHash }).where(eq(routeAuthUsers.id, userId));
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
