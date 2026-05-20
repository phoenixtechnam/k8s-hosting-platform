/**
 * F3 — WAF auto-ban scheduler.
 *
 * 60s periodic tick:
 *   1. Read config from platform_settings.
 *   2. If disabled → skip (still update watermark so re-enabling
 *      doesn't process backlog).
 *   3. Read new waf_logs rows since last watermark (max 1000 per tick).
 *   4. Build the recently-banned LRU + past-bans-per-IP map.
 *   5. Call evaluator.
 *   6. For each banned decision: addBan via existing helper + insert
 *      crowdsec_autoban_runs row.
 *   7. For each skipped decision: insert crowdsec_autoban_runs row
 *      ONLY if `enabled` so disabled-mode doesn't pollute the audit.
 *   8. Advance watermark.
 *
 * Watermark stored in platform_settings under
 * `security.crowdsec.autoban_watermark_id` — string holding the last
 * processed waf_logs.id. Survives platform-api restarts.
 *
 * If addBan() throws (LAPI down, cscli error), we record the failure
 * but advance the watermark — the next tick won't re-try the same
 * event. CrowdSec's own retry path takes over (subsequent events
 * from the same IP will re-trigger).
 */

import crypto from 'node:crypto';
import { and, desc, gt, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { crowdsecAutobanRuns, wafLogs } from '../../db/schema.js';
import { addBan } from '../security-hardening/crowdsec.js';
import { isIpInAllowlist } from '../security-hardening/crowdsec-allowlists.js';
import { evaluateWafBatch, type WafLogRow } from './evaluator.js';
import type { CrowdsecAutobanConfig, CrowdsecAutobanOutcome } from '@k8s-hosting/api-contracts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = NodePgDatabase<any>;

const TICK_INTERVAL_MS = 60_000;
const INITIAL_DELAY_MS = 30_000;
const MAX_BATCH = 1000;
/** LRU: any IP we banned in the last 5 min. Skip to avoid double-banning. */
const LRU_TTL_MS = 5 * 60_000;
/** Pre-prefix for the scenario field — distinguishes auto-bans from operator-added bans. */
export const AUTO_BAN_REASON_PREFIX = 'auto-ban:';

const SETTING_WATERMARK = 'security.crowdsec.autoban_watermark_id';

const DEFAULT_CONFIG: CrowdsecAutobanConfig = {
  enabled: false,
  windowSeconds: 300,
  eventThreshold: 5,
  minSeverity: 'critical',
  initialBanDuration: '1h',
  repeatBackoffMultiplier: 4,
  maxBanDuration: '7d',
  excludedRuleIds: ['949110', '913100'],
  includeTenantRoutes: false,
};

const SETTING_KEYS = {
  enabled: 'security.crowdsec.autoban_enabled',
  windowSeconds: 'security.crowdsec.autoban_window_seconds',
  eventThreshold: 'security.crowdsec.autoban_event_threshold',
  minSeverity: 'security.crowdsec.autoban_min_severity',
  initialBanDuration: 'security.crowdsec.autoban_initial_duration',
  repeatBackoffMultiplier: 'security.crowdsec.autoban_repeat_multiplier',
  maxBanDuration: 'security.crowdsec.autoban_max_duration',
  excludedRuleIds: 'security.crowdsec.autoban_excluded_rule_ids',
  includeTenantRoutes: 'security.crowdsec.autoban_include_tenant_routes',
} as const;

async function loadSettings(db: Db): Promise<Map<string, string>> {
  const keys = [...Object.values(SETTING_KEYS), SETTING_WATERMARK];
  const rows = await db.execute(sql`
    SELECT key, value FROM platform_settings WHERE key = ANY(${keys}::text[])
  `);
  const map = new Map<string, string>();
  for (const r of ((rows as unknown as { rows?: { key: string; value: string }[] }).rows) ?? []) {
    map.set(r.key, r.value);
  }
  return map;
}

export async function loadConfig(db: Db): Promise<CrowdsecAutobanConfig> {
  const settings = await loadSettings(db);
  const get = (k: keyof typeof SETTING_KEYS) => settings.get(SETTING_KEYS[k]);
  return {
    enabled: get('enabled') === 'true',
    windowSeconds: Number(get('windowSeconds') ?? DEFAULT_CONFIG.windowSeconds),
    eventThreshold: Number(get('eventThreshold') ?? DEFAULT_CONFIG.eventThreshold),
    minSeverity: (get('minSeverity') === 'warning' ? 'warning' : 'critical'),
    initialBanDuration: get('initialBanDuration') ?? DEFAULT_CONFIG.initialBanDuration,
    repeatBackoffMultiplier: Number(get('repeatBackoffMultiplier') ?? DEFAULT_CONFIG.repeatBackoffMultiplier),
    maxBanDuration: get('maxBanDuration') ?? DEFAULT_CONFIG.maxBanDuration,
    excludedRuleIds: (get('excludedRuleIds') ?? DEFAULT_CONFIG.excludedRuleIds.join(','))
      .split(',').map((s) => s.trim()).filter((s) => /^\d+$/.test(s)),
    includeTenantRoutes: get('includeTenantRoutes') === 'true',
  };
}

async function loadWatermark(db: Db): Promise<string | null> {
  const settings = await loadSettings(db);
  return settings.get(SETTING_WATERMARK) ?? null;
}

async function saveWatermark(db: Db, id: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO platform_settings (key, value, updated_at)
    VALUES (${SETTING_WATERMARK}, ${id}, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `);
}

async function recentlyBannedIpsFromDb(db: Db): Promise<Set<string>> {
  const rows = await db.execute(sql`
    SELECT DISTINCT source_ip FROM crowdsec_autoban_runs
    WHERE outcome = 'banned' AND triggered_at > NOW() - INTERVAL '5 minutes'
  `);
  const ips = new Set<string>();
  for (const r of ((rows as unknown as { rows?: { source_ip: string }[] }).rows) ?? []) {
    ips.add(r.source_ip);
  }
  return ips;
}

async function pastBansPerIpFromDb(db: Db, candidateIps: string[]): Promise<Map<string, number>> {
  if (candidateIps.length === 0) return new Map();
  const rows = await db.execute(sql`
    SELECT source_ip, COUNT(*)::int AS cnt FROM crowdsec_autoban_runs
    WHERE outcome = 'banned'
      AND triggered_at > NOW() - INTERVAL '24 hours'
      AND source_ip = ANY(${candidateIps}::text[])
    GROUP BY source_ip
  `);
  const map = new Map<string, number>();
  for (const r of ((rows as unknown as { rows?: { source_ip: string; cnt: number }[] }).rows) ?? []) {
    map.set(r.source_ip, Number(r.cnt));
  }
  return map;
}

interface RawWafLogRow {
  id: string;
  created_at: string | Date;
  source_ip: string | null;
  hostname: string;
  rule_id: string;
  severity: string;
  tenant_id: string | null;
}

async function newWafEventsSince(db: Db, watermark: string | null): Promise<{ rows: WafLogRow[]; lastId: string | null }> {
  const result = watermark
    ? await db.execute(sql`
        SELECT id, created_at, source_ip, hostname, rule_id, severity, tenant_id
        FROM waf_logs WHERE id > ${watermark}
        ORDER BY id ASC LIMIT ${MAX_BATCH}
      `)
    : await db.execute(sql`
        SELECT id, created_at, source_ip, hostname, rule_id, severity, tenant_id
        FROM waf_logs
        ORDER BY id DESC LIMIT 1
      `);
  const rawRows = ((result as unknown as { rows?: RawWafLogRow[] }).rows) ?? [];
  if (rawRows.length === 0) return { rows: [], lastId: null };
  const rows: WafLogRow[] = rawRows.map((r) => ({
    id: r.id,
    createdAt: r.created_at instanceof Date ? r.created_at : new Date(r.created_at),
    sourceIp: r.source_ip,
    hostname: r.hostname,
    ruleId: r.rule_id,
    severity: r.severity,
    tenantId: r.tenant_id,
  }));
  const lastId = rawRows[rawRows.length - 1].id;
  return { rows, lastId };
}

async function insertRun(
  db: Db,
  d: {
    sourceIp: string;
    hostname: string | null;
    ruleIds: ReadonlyArray<string>;
    eventCount: number;
    windowSeconds: number;
    banDuration: string;
    banId: number | null;
    outcome: CrowdsecAutobanOutcome;
    outcomeDetail: string | null;
  },
): Promise<void> {
  await db.insert(crowdsecAutobanRuns).values({
    id: crypto.randomUUID(),
    triggeredAt: new Date(),
    sourceIp: d.sourceIp,
    hostname: d.hostname,
    ruleIds: [...d.ruleIds],
    eventCount: d.eventCount,
    windowSeconds: d.windowSeconds,
    banDuration: d.banDuration,
    banId: d.banId,
    outcome: d.outcome,
    outcomeDetail: d.outcomeDetail,
  });
}

interface SchedulerDeps {
  readonly db: Db;
  readonly kubeconfigPath: string | undefined;
  readonly log: { info: (o: object, msg?: string) => void; warn: (o: object, msg?: string) => void };
}

export async function runOnce(deps: SchedulerDeps): Promise<void> {
  const config = await loadConfig(deps.db);
  const watermark = await loadWatermark(deps.db);
  const { rows: events, lastId } = await newWafEventsSince(deps.db, watermark);

  if (events.length === 0) return;

  // Bump watermark immediately to avoid double-evaluating on the next tick
  // if our processing crashes mid-way. The cost of dropping a few events
  // on a crash is better than the cost of double-banning.
  if (lastId) await saveWatermark(deps.db, lastId);

  if (!config.enabled) return;

  // Pre-filter: only events with non-null source_ip + non-'0.0.0.0'
  // sentinel are evaluable.
  const evaluable = events.filter((e) => e.sourceIp && e.sourceIp !== '0.0.0.0');
  if (evaluable.length === 0) return;

  const recentlyBanned = await recentlyBannedIpsFromDb(deps.db);
  const candidateIps = [...new Set(evaluable.map((e) => e.sourceIp as string))];
  const pastBansPerIp = await pastBansPerIpFromDb(deps.db, candidateIps);

  const decisions = evaluateWafBatch(evaluable, config, recentlyBanned, pastBansPerIp);

  for (const d of decisions) {
    if (d.outcome !== 'banned') {
      // Persist skip reason for the audit timeline.
      await insertRun(deps.db, {
        sourceIp: d.sourceIp,
        hostname: d.hostname,
        ruleIds: d.ruleIds,
        eventCount: d.eventCount,
        windowSeconds: config.windowSeconds,
        banDuration: '0s',
        banId: null,
        outcome: d.outcome,
        outcomeDetail: d.outcomeDetail,
      });
      continue;
    }

    // Pre-flight: if the IP is in the F2 allowlist, refuse the ban
    // (defence-in-depth — addBan/cscli will accept it anyway, but the
    // audit row should record this clearly). isIpInAllowlist is
    // fail-CLOSED so a CrowdSec outage results in skip not ban.
    const allowlisted = await isIpInAllowlist(deps.kubeconfigPath, d.sourceIp);
    if (allowlisted) {
      await insertRun(deps.db, {
        sourceIp: d.sourceIp,
        hostname: d.hostname,
        ruleIds: d.ruleIds,
        eventCount: d.eventCount,
        windowSeconds: config.windowSeconds,
        banDuration: '0s',
        banId: null,
        outcome: 'skipped_allowlisted',
        outcomeDetail: 'IP is in CrowdSec allowlist (or check unavailable)',
      });
      continue;
    }

    try {
      // addBan uses the operator path — actor='autoban-scheduler' so audit
      // logs distinguish auto-bans from operator bans. The scenario prefix
      // (admin-panel:) is set by addBan; we want auto-ban: instead, but
      // changing addBan's prefix breaks the existing UI manualByOperator
      // detection. Instead: prepend AUTO_BAN_REASON_PREFIX to the reason
      // string so the scenario becomes admin-panel:autoban-scheduler:auto-ban:<reason>.
      // The UI's autoban detection key off the prefix in the reason segment.
      const reason = `${AUTO_BAN_REASON_PREFIX}rules ${d.ruleIds.join(',')} count ${d.eventCount}`;
      await addBan(
        deps.kubeconfigPath,
        { value: d.sourceIp, scope: 'Ip', duration: d.proposedDuration ?? '1h', reason },
        'autoban-scheduler',
      );
      await insertRun(deps.db, {
        sourceIp: d.sourceIp,
        hostname: d.hostname,
        ruleIds: d.ruleIds,
        eventCount: d.eventCount,
        windowSeconds: config.windowSeconds,
        banDuration: d.proposedDuration ?? '1h',
        banId: null,
        outcome: 'banned',
        outcomeDetail: d.outcomeDetail,
      });
      deps.log.info(
        { sourceIp: d.sourceIp, ruleIds: d.ruleIds, duration: d.proposedDuration },
        'crowdsec-autoban: banned',
      );
    } catch (err) {
      await insertRun(deps.db, {
        sourceIp: d.sourceIp,
        hostname: d.hostname,
        ruleIds: d.ruleIds,
        eventCount: d.eventCount,
        windowSeconds: config.windowSeconds,
        banDuration: d.proposedDuration ?? '1h',
        banId: null,
        outcome: 'failed',
        outcomeDetail: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
      });
      deps.log.warn(
        { sourceIp: d.sourceIp, err: err instanceof Error ? err.message : String(err) },
        'crowdsec-autoban: ban failed',
      );
    }
  }
}

export function startCrowdsecAutobanScheduler(deps: SchedulerDeps): NodeJS.Timeout {
  deps.log.info({}, 'crowdsec-autoban: scheduler starting');
  const run = () => {
    runOnce(deps).catch((err) => {
      deps.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'crowdsec-autoban: tick failed',
      );
    });
  };
  setTimeout(run, INITIAL_DELAY_MS);
  return setInterval(run, TICK_INTERVAL_MS);
}

export async function listRecentRuns(db: Db, limit = 50): Promise<Array<typeof crowdsecAutobanRuns.$inferSelect>> {
  return db.select().from(crowdsecAutobanRuns).orderBy(desc(crowdsecAutobanRuns.triggeredAt)).limit(Math.min(limit, 200));
}

// Re-export for backend tests that need the watermark key name.
export { SETTING_WATERMARK, SETTING_KEYS, DEFAULT_CONFIG };
// Re-export for the unused-but-soon import optimizer: drizzle ops we
// touched in queries above.
export const _drizzleOpsUsed = { and, gt };
