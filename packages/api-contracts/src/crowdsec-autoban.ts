/**
 * F3 — WAF Auto-Ban configuration + runs.
 *
 * Opt-in: when `enabled` is true, a 60s scheduler reads new waf_logs
 * rows since the last watermark, groups by source_ip, filters by
 * severity + excluded-rule list + (optional) tenant-route scope, and
 * issues an auto-ban via the existing addBan helper when the event
 * count crosses `eventThreshold` within `windowSeconds`.
 *
 * Tenant-routes scope: by default auto-ban only triggers on admin-host
 * events (`waf_logs.tenant_id IS NULL`) so a tenant's customer base
 * doesn't get auto-banned for tripping the WAF on the tenant's own
 * site. Set `includeTenantRoutes: true` to extend the scope to all
 * WAF events — useful for operators running the platform as a SaaS
 * with very few tenant routes.
 */

import { z } from 'zod';

export const crowdsecAutobanOutcomeSchema = z.enum([
  'banned',
  'skipped_allowlisted',
  'skipped_excluded_rule',
  'skipped_already_banned',
  'skipped_below_threshold',
  'failed',
]);
export type CrowdsecAutobanOutcome = z.infer<typeof crowdsecAutobanOutcomeSchema>;

export const crowdsecAutobanRunSchema = z.object({
  id: z.string().uuid(),
  triggeredAt: z.string().datetime(),
  sourceIp: z.string(),
  hostname: z.string().nullable(),
  ruleIds: z.array(z.string()),
  eventCount: z.number().int().min(0),
  windowSeconds: z.number().int().positive(),
  banDuration: z.string(),
  banId: z.number().int().nullable(),
  outcome: crowdsecAutobanOutcomeSchema,
  outcomeDetail: z.string().nullable(),
});
export type CrowdsecAutobanRun = z.infer<typeof crowdsecAutobanRunSchema>;

export const crowdsecAutobanListRunsResponseSchema = z.object({
  runs: z.array(crowdsecAutobanRunSchema),
});
export type CrowdsecAutobanListRunsResponse = z.infer<typeof crowdsecAutobanListRunsResponseSchema>;

export const crowdsecAutobanSeveritySchema = z.enum(['warning', 'critical']);
export type CrowdsecAutobanSeverity = z.infer<typeof crowdsecAutobanSeveritySchema>;

/**
 * Server-stored config. All keys live under `security.crowdsec.autoban_*`
 * in platform_settings (single source of truth). The schema mirrors the
 * shape returned by GET /admin/security/crowdsec/autoban/config.
 */
export const crowdsecAutobanConfigSchema = z.object({
  /** Master toggle. Default false. */
  enabled: z.boolean(),
  /** Rolling window for event counting. Min 60s, max 1h. Default 300s. */
  windowSeconds: z.number().int().min(60).max(3600),
  /** Number of qualifying events within the window to trigger a ban. 2..100. Default 5. */
  eventThreshold: z.number().int().min(2).max(100),
  /** Minimum severity that counts. 'warning' includes warning+critical; 'critical' is critical-only. */
  minSeverity: crowdsecAutobanSeveritySchema,
  /** Initial ban duration (CrowdSec duration string). Default '1h'. */
  initialBanDuration: z.string().min(2).max(16).regex(/^\d+[smhd](\d+[smhd])*$/),
  /** Backoff multiplier for repeat offenders. 1..10. Default 4. */
  repeatBackoffMultiplier: z.number().min(1).max(10),
  /** Cap on the auto-derived ban duration. Default '7d'. */
  maxBanDuration: z.string().min(2).max(16).regex(/^\d+[smhd](\d+[smhd])*$/),
  /**
   * CRS rule IDs that NEVER trigger auto-ban. Default ['949110','913100']
   * — meta-rules that fire on accumulated score and would lead to mass
   * false-positive bans if included.
   */
  excludedRuleIds: z.array(z.string().regex(/^[0-9]+$/)).max(200),
  /**
   * If true, evaluate auto-ban for tenant-route events too (not just
   * admin/api/client/platform host events). Default false — a tenant's
   * own customer base shouldn't be auto-banned for tripping WAF on the
   * tenant's site.
   */
  includeTenantRoutes: z.boolean(),
});
export type CrowdsecAutobanConfig = z.infer<typeof crowdsecAutobanConfigSchema>;

export const crowdsecAutobanPatchConfigRequestSchema = crowdsecAutobanConfigSchema.partial();
export type CrowdsecAutobanPatchConfigRequest = z.infer<typeof crowdsecAutobanPatchConfigRequestSchema>;

/**
 * Calibration dry-run response — operator clicks "Preview" before
 * enabling. Server replays the last 24h of waf_logs against the
 * supplied (or current) config and reports how many bans WOULD have
 * been issued, across how many distinct IPs, and the breakdown by
 * rule_id so the operator can fine-tune excludedRuleIds.
 */
export const crowdsecAutobanCalibrationResponseSchema = z.object({
  windowSeconds: z.number().int().positive(),
  totalEventsConsidered: z.number().int().min(0),
  distinctSourceIpsAboveThreshold: z.number().int().min(0),
  hypotheticalBans: z.number().int().min(0),
  topRulesInBatch: z.array(z.object({
    ruleId: z.string(),
    distinctIps: z.number().int().min(0),
    eventCount: z.number().int().min(0),
  })),
});
export type CrowdsecAutobanCalibrationResponse = z.infer<typeof crowdsecAutobanCalibrationResponseSchema>;
