/**
 * Cluster-wide WAF events service for the Security & Hardening admin page.
 *
 * Sources its data from the `waf_logs` table (populated by the existing
 * `waf-log-scraper` scheduler in modules/ingress-routes). Joins to
 * `domains.name` so the UI can render `<tenant-subdomain>.<apex>` rows
 * with a hint about which tenant they belong to.
 *
 * The 0013_waf_logs_admin_hosts migration made route_id + tenant_id
 * NULLABLE so admin/api/client-host events (no per-tenant ingress_route)
 * land in the same table — those are this view's bread and butter, since
 * they were previously invisible.
 *
 * super_admin only — there are no per-tenant guards on this surface.
 */

import { and, desc, eq, gte, ilike, inArray, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { wafLogs } from '../../db/schema.js';

// Matches SecurityHardeningDeps.db — kept loose to share the same instance
// across the security-hardening module.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = NodePgDatabase<any>;
import type {
  WafEvent,
  WafEventScope,
  WafEventSeverity,
  WafEventsQuery,
  WafEventsResponse,
  WafEventsStats,
  WafTopRule,
  WafTopHost,
  WafTopSourceIp,
} from '@k8s-hosting/api-contracts';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const DEFAULT_SINCE_SECONDS = 86_400;
const STATS_TOP_N = 10;
// Stats window is independent from the listing query so the "top rules"
// numbers stay meaningful when the operator narrows the filters.
const STATS_WINDOW_SECONDS = 86_400;

// Exported for tests — pure helpers, no DB dependency.
export function normalizeSeverity(raw: string): WafEventSeverity {
  if (raw === 'critical' || raw === 'warning' || raw === 'info') return raw;
  return 'info';
}

export function scopeOf(routeId: string | null): WafEventScope {
  return routeId === null ? 'admin-host' : 'tenant-route';
}

interface WafLogRow {
  readonly id: string;
  readonly routeId: string | null;
  readonly tenantId: string | null;
  readonly hostname: string;
  readonly ruleId: string;
  readonly severity: string;
  readonly message: string;
  readonly requestUri: string | null;
  readonly requestMethod: string | null;
  readonly sourceIp: string | null;
  readonly createdAt: Date | string;
}

function rowToEvent(row: WafLogRow): WafEvent {
  const ts = row.createdAt instanceof Date
    ? row.createdAt.toISOString()
    : new Date(row.createdAt).toISOString();
  return {
    id: row.id,
    scope: scopeOf(row.routeId),
    hostname: row.hostname ?? '',
    routeId: row.routeId,
    tenantId: row.tenantId,
    ruleId: row.ruleId,
    severity: normalizeSeverity(row.severity),
    message: row.message,
    requestUri: row.requestUri,
    requestMethod: row.requestMethod,
    sourceIp: row.sourceIp,
    occurredAt: ts,
  };
}

export function parseRuleIds(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[0-9]+$/.test(s))
    .slice(0, 50);
}

function buildFilters(query: WafEventsQuery) {
  const filters = [];
  const ruleIds = parseRuleIds(query.ruleId);
  if (ruleIds.length > 0) filters.push(inArray(wafLogs.ruleId, ruleIds));
  if (query.severity) filters.push(eq(wafLogs.severity, query.severity));
  if (query.host) filters.push(ilike(wafLogs.hostname, `%${query.host}%`));
  if (query.scope === 'admin-host') filters.push(isNull(wafLogs.routeId));
  if (query.scope === 'tenant-route') filters.push(sql`${wafLogs.routeId} IS NOT NULL`);
  // Time filter is always applied. Zod schema enforces sinceSeconds ≥ 60
  // so we never issue an unbounded scan against waf_logs.
  const sinceSeconds = query.sinceSeconds ?? DEFAULT_SINCE_SECONDS;
  const cutoff = new Date(Date.now() - sinceSeconds * 1000);
  filters.push(gte(wafLogs.createdAt, cutoff));
  return filters;
}

export async function listWafEvents(
  db: Db,
  query: WafEventsQuery,
): Promise<WafEventsResponse> {
  const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const filters = buildFilters(query);
  const where = filters.length > 0 ? and(...filters) : undefined;

  // Fetch one extra row to detect truncation
  const fetchLimit = limit + 1;
  const rows = await db
    .select()
    .from(wafLogs)
    .where(where)
    .orderBy(desc(wafLogs.createdAt))
    .limit(fetchLimit);

  const truncated = rows.length > limit;
  const slice = truncated ? rows.slice(0, limit) : rows;
  const events = slice.map(rowToEvent);

  const stats = await computeStats(db);

  return { events, truncated, stats };
}

/**
 * Stats over a FIXED 24h window. Independent from the listing query
 * filters so operators always see what's actually noisy on the cluster,
 * not just what matches their current narrow filter.
 */
export async function computeStats(db: Db): Promise<WafEventsStats> {
  const cutoff = new Date(Date.now() - STATS_WINDOW_SECONDS * 1000);
  const baseWhere = gte(wafLogs.createdAt, cutoff);

  type TotalsRow = { total: number; tenant_route: number; admin_host: number; most_recent: string | Date | null };
  type TopRuleRow = { rule_id: string; cnt: number; message: string | null; severity: string | null };
  type HostRow = { hostname: string; is_admin_host: boolean; cnt: number };

  // 4 independent aggregations — fire concurrently to halve wall-clock latency.
  const [totalsRaw, topRulesRaw, topHostsRaw, topIpsRaw] = await Promise.all([
    db.execute(sql`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE route_id IS NOT NULL)::int AS tenant_route,
        COUNT(*) FILTER (WHERE route_id IS NULL)::int AS admin_host,
        MAX(created_at) AS most_recent
      FROM waf_logs
      WHERE created_at >= ${cutoff}
    `),
    // Top rules + sample message+severity in one CTE.
    db.execute(sql`
      WITH top_rules AS (
        SELECT rule_id, COUNT(*)::int AS cnt
        FROM waf_logs
        WHERE created_at >= ${cutoff}
        GROUP BY rule_id
        ORDER BY cnt DESC
        LIMIT ${STATS_TOP_N}
      ),
      samples AS (
        SELECT DISTINCT ON (rule_id) rule_id, message, severity
        FROM waf_logs
        WHERE created_at >= ${cutoff}
          AND rule_id IN (SELECT rule_id FROM top_rules)
        ORDER BY rule_id, created_at DESC
      )
      SELECT t.rule_id, t.cnt, s.message, s.severity
      FROM top_rules t
      LEFT JOIN samples s USING (rule_id)
      ORDER BY t.cnt DESC
    `),
    db.execute(sql`
      SELECT
        hostname,
        (route_id IS NULL) AS is_admin_host,
        count(*)::int AS cnt
      FROM waf_logs
      WHERE created_at >= ${cutoff}
      GROUP BY hostname, (route_id IS NULL)
      ORDER BY cnt DESC
      LIMIT ${STATS_TOP_N}
    `),
    // Top source IPs (filter out the 0.0.0.0 parser placeholder — that's
    // "no IP extractable", not a real attacker).
    db
      .select({
        sourceIp: wafLogs.sourceIp,
        count: sql<number>`count(*)::int`,
      })
      .from(wafLogs)
      .where(and(baseWhere, sql`${wafLogs.sourceIp} IS NOT NULL AND ${wafLogs.sourceIp} <> '0.0.0.0'`))
      .groupBy(wafLogs.sourceIp)
      .orderBy(sql`count(*) desc`)
      .limit(STATS_TOP_N),
  ]);

  const totalsArr = (totalsRaw as unknown as { rows?: TotalsRow[] }).rows ?? [];
  const totals: TotalsRow = totalsArr[0] ?? { total: 0, tenant_route: 0, admin_host: 0, most_recent: null };

  const topRules: WafTopRule[] = (((topRulesRaw as unknown as { rows?: TopRuleRow[] }).rows) ?? []).map((row) => ({
    ruleId: row.rule_id,
    sampleMessage: row.message ?? '',
    sampleSeverity: normalizeSeverity(row.severity ?? 'info'),
    count: Number(row.cnt ?? 0),
  }));

  const topHosts: WafTopHost[] = (((topHostsRaw as unknown as { rows?: HostRow[] }).rows) ?? []).map((row) => ({
    hostname: row.hostname ?? '',
    scope: row.is_admin_host ? 'admin-host' : 'tenant-route',
    count: Number(row.cnt ?? 0),
  }));

  const topSourceIps: WafTopSourceIp[] = topIpsRaw.map((r) => ({
    sourceIp: r.sourceIp ?? '',
    count: Number(r.count ?? 0),
  }));

  const mostRecentAt = totals.most_recent
    ? (totals.most_recent instanceof Date
        ? totals.most_recent.toISOString()
        : new Date(totals.most_recent).toISOString())
    : null;

  return {
    windowSeconds: STATS_WINDOW_SECONDS,
    totalEvents: Number(totals.total ?? 0),
    totalEventsTenantRoute: Number(totals.tenant_route ?? 0),
    totalEventsAdminHost: Number(totals.admin_host ?? 0),
    topRules,
    topHosts,
    topSourceIps,
    mostRecentAt,
  };
}
