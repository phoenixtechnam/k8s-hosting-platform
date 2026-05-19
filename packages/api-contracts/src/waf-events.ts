/**
 * WAF (ModSecurity / CRS) events — cluster-wide view.
 *
 * Drives the "WAF Events" tab in `/settings/security-hardening`. Backed
 * by the `waf_logs` table populated by the `waf-log-scraper` scheduler
 * that tails `modsec-crs` pod logs every 30s.
 *
 * Two scopes share the same table:
 *   1. Per-tenant per-route — `route_id` set, surfaced under
 *      `/tenants/:tenantId/routes/:routeId/waf-logs` (older endpoint).
 *   2. Admin/api/client/platform host — `route_id IS NULL`,
 *      surfaced only here. These are the events that previously
 *      had no UI surface (the 930120 LFI FP on
 *      POST /admin/system-backup/dr-drill/runs on 2026-05-19 was
 *      the trigger for this tab).
 */

import { z } from 'zod';

export const wafEventSeveritySchema = z.enum(['critical', 'warning', 'info']);
export type WafEventSeverity = z.infer<typeof wafEventSeveritySchema>;

export const wafEventScopeSchema = z.enum(['tenant-route', 'admin-host']);
export type WafEventScope = z.infer<typeof wafEventScopeSchema>;

export const wafEventSchema = z.object({
  id: z.string().uuid(),
  scope: wafEventScopeSchema,
  hostname: z.string().max(255),
  /** ingress_routes.id when scope='tenant-route', null otherwise. */
  routeId: z.string().uuid().nullable(),
  /** tenants.id when scope='tenant-route', null otherwise. */
  tenantId: z.string().uuid().nullable(),
  ruleId: z.string().min(1).max(50),
  severity: wafEventSeveritySchema,
  /** ModSec rule message — truncated at scrape time so an attacker can't blow up the table. */
  message: z.string().max(500),
  /** Request URI from the offending request — truncated at scrape time. */
  requestUri: z.string().max(2048).nullable(),
  requestMethod: z.string().max(10).nullable(),
  sourceIp: z.string().max(45).nullable(),
  occurredAt: z.string().datetime(),
});
export type WafEvent = z.infer<typeof wafEventSchema>;

export const wafEventsQuerySchema = z.object({
  /** Comma-separated list of rule IDs (e.g. "930120,931100"). */
  ruleId: z.string().optional(),
  severity: wafEventSeveritySchema.optional(),
  /**
   * Substring match on hostname (case-insensitive). Restricted to RFC-1035
   * hostname characters + `.` and `-`: `%` and `_` are NOT allowed so the
   * caller can't slip ILIKE wildcards past the substring intent.
   */
  host: z.string().max(255).regex(/^[a-zA-Z0-9.\-]*$/, 'hostname filter must be plain DNS characters').optional(),
  scope: wafEventScopeSchema.optional(),
  /**
   * Max age in seconds. Default 86400 (24h). Min 60s, max 30d — no unbounded
   * scans (closes a footgun where sinceSeconds=0 would walk the whole table).
   */
  sinceSeconds: z.coerce.number().int().min(60).max(2592000).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
export type WafEventsQuery = z.infer<typeof wafEventsQuerySchema>;

export const wafTopRuleSchema = z.object({
  ruleId: z.string(),
  /** Most-common message text for this rule in the window (most-recent if tied). */
  sampleMessage: z.string(),
  /** Most-common severity for this rule in the window. */
  sampleSeverity: wafEventSeveritySchema,
  count: z.number().int().min(0),
});
export type WafTopRule = z.infer<typeof wafTopRuleSchema>;

export const wafTopHostSchema = z.object({
  hostname: z.string(),
  scope: wafEventScopeSchema,
  count: z.number().int().min(0),
});
export type WafTopHost = z.infer<typeof wafTopHostSchema>;

export const wafTopSourceIpSchema = z.object({
  sourceIp: z.string(),
  count: z.number().int().min(0),
});
export type WafTopSourceIp = z.infer<typeof wafTopSourceIpSchema>;

export const wafEventsStatsSchema = z.object({
  /** Time window for these stats, seconds. */
  windowSeconds: z.number().int().min(0),
  totalEvents: z.number().int().min(0),
  totalEventsTenantRoute: z.number().int().min(0),
  totalEventsAdminHost: z.number().int().min(0),
  topRules: z.array(wafTopRuleSchema),
  topHosts: z.array(wafTopHostSchema),
  topSourceIps: z.array(wafTopSourceIpSchema),
  /** ISO timestamp of the most recent event. null if table is empty. */
  mostRecentAt: z.string().datetime().nullable(),
});
export type WafEventsStats = z.infer<typeof wafEventsStatsSchema>;

export const wafScraperStatusSchema = z.object({
  /** True once the in-process scheduler has fired at least one cycle. */
  hasRunOnce: z.boolean(),
  /** ISO timestamp of the most recent cycle completion. null before first cycle. */
  lastRunAt: z.string().datetime().nullable(),
  /** Did the last cycle find a modsec-crs pod to read logs from? */
  modsecPodFound: z.boolean(),
  /** Lines parsed / rows inserted on the last cycle. */
  lastCycleScraped: z.number().int().min(0),
  lastCycleInserted: z.number().int().min(0),
  /** Up to 5 most-recent errors from the last cycle (each ≤256 chars). */
  lastCycleErrors: z.array(z.string()),
  /** Configured polling interval in ms (informational — operator-visible). */
  scrapeIntervalMs: z.number().int().positive(),
});
export type WafScraperStatus = z.infer<typeof wafScraperStatusSchema>;

export const wafEventsResponseSchema = z.object({
  events: z.array(wafEventSchema),
  /** Whether the query was capped by `limit`. */
  truncated: z.boolean(),
  /** Window stats for the same filters (24h fixed regardless of `sinceSeconds`). */
  stats: wafEventsStatsSchema,
  /** Live status of the in-process scraper — lets the UI distinguish
   * "modsec not deployed" from "scraper running but quiet". */
  scraperStatus: wafScraperStatusSchema,
});
export type WafEventsResponse = z.infer<typeof wafEventsResponseSchema>;

export const wafRefreshResponseSchema = z.object({
  triggeredAt: z.string().datetime(),
  scraped: z.number().int().min(0),
  inserted: z.number().int().min(0),
  modsecPodFound: z.boolean(),
  errors: z.array(z.string()),
});
export type WafRefreshResponse = z.infer<typeof wafRefreshResponseSchema>;
