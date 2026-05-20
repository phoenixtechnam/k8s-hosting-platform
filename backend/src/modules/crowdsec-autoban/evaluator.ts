/**
 * F3 — Pure function that decides which IPs to auto-ban from a batch
 * of waf_logs rows.
 *
 * Stateless and side-effect-free so it's trivially unit-testable. The
 * scheduler calls this on each tick with: the new event batch, the
 * current config, and the set of IPs we've banned in the last 5min
 * (in-process LRU dedupe). The evaluator returns one Decision per IP
 * group describing whether to ban + with what duration + outcome
 * code for the audit table.
 */

import type { CrowdsecAutobanConfig, CrowdsecAutobanOutcome } from '@k8s-hosting/api-contracts';

/** Shape we read from waf_logs — kept minimal so tests don't need full row mocks. */
export interface WafLogRow {
  readonly id: string;
  readonly createdAt: Date;
  readonly sourceIp: string | null;
  readonly hostname: string;
  readonly ruleId: string;
  readonly severity: string;
  /** null = admin-host scope; non-null = tenant-route scope. */
  readonly tenantId: string | null;
}

/** One per source IP. The scheduler walks this and acts on each. */
export interface AutobanDecision {
  readonly sourceIp: string;
  readonly hostname: string | null;
  readonly ruleIds: ReadonlyArray<string>;
  readonly eventCount: number;
  readonly outcome: CrowdsecAutobanOutcome;
  /** Set when outcome === 'banned'. CrowdSec duration string. */
  readonly proposedDuration: string | null;
  /** Audit context, e.g. "rule 949110 excluded by config". */
  readonly outcomeDetail: string | null;
}

const SEVERITY_RANK: Record<string, number> = {
  info: 0,
  warning: 1,
  critical: 2,
};

function passesSeverity(rowSev: string, minSev: 'warning' | 'critical'): boolean {
  return (SEVERITY_RANK[rowSev] ?? 0) >= (SEVERITY_RANK[minSev] ?? 1);
}

function parseDurationMs(d: string): number {
  const re = /(\d+)([smhd])/g;
  let total = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d)) !== null) {
    const n = Number(m[1]);
    const mult = m[2] === 's' ? 1_000 : m[2] === 'm' ? 60_000 : m[2] === 'h' ? 3_600_000 : 86_400_000;
    total += n * mult;
  }
  return total;
}

function msToCrowdsecDuration(ms: number): string {
  if (ms <= 0) return '1m';
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.max(1, Math.round(ms / 1000))}s`;
}

/**
 * Compute the auto-ban duration for an IP, accounting for repeat-offender
 * backoff. `recentBanDurations` are durations of bans we know we issued
 * against this IP in the previous N hours (caller-supplied; sourced from
 * crowdsec_autoban_runs WHERE source_ip=$1 AND triggered_at > NOW() - 24h).
 *
 * Multiplier compounds per past ban capped at maxBanDuration:
 *   first ban: initialBanDuration (e.g. 1h)
 *   second:    initialBanDuration * multiplier (e.g. 4h)
 *   third:     ... * multiplier^2 (e.g. 16h)
 */
export function computeBanDuration(
  config: Pick<CrowdsecAutobanConfig, 'initialBanDuration' | 'repeatBackoffMultiplier' | 'maxBanDuration'>,
  pastBanCount: number,
): string {
  const baseMs = parseDurationMs(config.initialBanDuration);
  const capMs = parseDurationMs(config.maxBanDuration);
  const scaled = baseMs * Math.pow(config.repeatBackoffMultiplier, Math.max(0, pastBanCount));
  const finalMs = Math.min(scaled, capMs);
  return msToCrowdsecDuration(finalMs);
}

/**
 * Group new events by source IP and decide what to do with each group.
 *
 * Inputs:
 *   events: NEW rows inserted to waf_logs since the last watermark.
 *           Filtered upstream so we only consider rows with non-null
 *           source_ip in [warning, critical] severity; this fn applies
 *           the final filters (excludedRuleIds, includeTenantRoutes,
 *           recentlyBannedIps, threshold).
 *   config: live platform_settings values.
 *   recentlyBannedIps: IPs the LRU has seen within ~5min — skip to
 *           avoid thundering-herd duplicate addBan() calls.
 *   pastBansPerIp: count of bans we issued against each IP in the
 *           prior 24h (sourced from crowdsec_autoban_runs).
 */
export function evaluateWafBatch(
  events: ReadonlyArray<WafLogRow>,
  config: CrowdsecAutobanConfig,
  recentlyBannedIps: ReadonlySet<string>,
  pastBansPerIp: ReadonlyMap<string, number>,
): AutobanDecision[] {
  if (!config.enabled || events.length === 0) return [];

  const excludedSet = new Set(config.excludedRuleIds);

  // Group by sourceIp. Track ruleIds + last hostname for audit context.
  type Group = {
    ruleIds: Set<string>;
    eventCount: number;
    /** Events that pass the severity floor (regardless of exclude). */
    severityPassedCount: number;
    /** Events that pass severity AND aren't an excluded rule. */
    qualifyingCount: number;
    hostname: string | null;
    sawTenantRoute: boolean;
  };
  const groups = new Map<string, Group>();
  for (const e of events) {
    if (!e.sourceIp) continue;
    let g = groups.get(e.sourceIp);
    if (!g) {
      g = { ruleIds: new Set(), eventCount: 0, severityPassedCount: 0, qualifyingCount: 0, hostname: null, sawTenantRoute: false };
      groups.set(e.sourceIp, g);
    }
    g.eventCount += 1;
    g.ruleIds.add(e.ruleId);
    g.hostname = e.hostname || g.hostname;
    if (e.tenantId !== null) g.sawTenantRoute = true;
    if (!passesSeverity(e.severity, config.minSeverity)) continue;
    g.severityPassedCount += 1;
    if (excludedSet.has(e.ruleId)) continue;
    g.qualifyingCount += 1;
  }

  const decisions: AutobanDecision[] = [];
  for (const [sourceIp, g] of groups) {
    const ruleIds = [...g.ruleIds].sort();
    const base = {
      sourceIp,
      hostname: g.hostname,
      ruleIds,
      eventCount: g.eventCount,
      proposedDuration: null as string | null,
    };

    // Scope filter: by default skip tenant-route-only IPs unless the
    // operator opted in to includeTenantRoutes. Skip is silent (we
    // emit no audit row) — recorded only when explicitly enabled.
    const onlyTenantRoutes = g.sawTenantRoute && ![...g.ruleIds].some((id) =>
      events.some((e) => e.sourceIp === sourceIp && e.ruleId === id && e.tenantId === null),
    );
    if (onlyTenantRoutes && !config.includeTenantRoutes) {
      continue;
    }

    if (recentlyBannedIps.has(sourceIp)) {
      decisions.push({ ...base, outcome: 'skipped_already_banned', outcomeDetail: 'in-process LRU shows recent ban' });
      continue;
    }
    // Order: severity → excluded-rule → threshold. The first failed
    // gate determines the outcome label so audit rows reflect the
    // actual reason. Events that pass severity but are all excluded
    // get 'skipped_excluded_rule'; events that don't even pass severity
    // get 'skipped_below_threshold' (because qualifyingCount is also 0
    // but for a different reason).
    if (g.severityPassedCount > 0 && g.qualifyingCount === 0) {
      decisions.push({
        ...base, outcome: 'skipped_excluded_rule',
        outcomeDetail: `all ${g.severityPassedCount} severity-passing events matched excluded rule(s): ${ruleIds.join(',')}`,
      });
      continue;
    }
    if (g.qualifyingCount < config.eventThreshold) {
      decisions.push({
        ...base, outcome: 'skipped_below_threshold',
        outcomeDetail: `${g.qualifyingCount}/${config.eventThreshold} qualifying events`,
      });
      continue;
    }
    const pastBans = pastBansPerIp.get(sourceIp) ?? 0;
    const duration = computeBanDuration(config, pastBans);
    decisions.push({
      ...base,
      outcome: 'banned',
      proposedDuration: duration,
      outcomeDetail: pastBans > 0 ? `repeat offender (${pastBans} prior bans in 24h)` : null,
    });
  }
  return decisions;
}
