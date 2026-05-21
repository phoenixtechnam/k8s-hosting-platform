/**
 * Web Defense — extracted from SecurityHardeningSettings (2026-05-21).
 *
 * All CrowdSec + WAF tab components live here so the Security Hub's
 * Web Defense page can render them as its own tab tree, separate
 * from the Posture page's hardening tabs. The Posture page no longer
 * surfaces WAF / Bans / Exclusions — those moved here.
 *
 * Exports (consumed by frontend/admin-panel/src/pages/WebDefensePage.tsx):
 *   - WafEventsTab, BannedIpsTab, WafExclusionsTab — main tab content
 *   - CrowdsecL4Card — L4 enforcement toggle (rendered as a banner
 *     above the tabs on the Web Defense page)
 *
 * Internal helpers (WafStatsPanel, BanIpModal, AllowlistCard, etc.)
 * are not exported — they are implementation details of the four
 * top-level exports.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  RefreshCw,
  Network,
  Activity,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Clock,
  Info,
  Filter,
  Globe,
  Play,
  Pause,
  Ban,
  Trash2,
  Plus,
  ShieldAlert,
  ShieldOff,
} from 'lucide-react';
import { SkeletonLoader } from '@/components/ui/SkeletonLoader';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useRefreshWafScraper, useWafEvents } from '@/hooks/use-waf-events';
import {
  useCreateWafRuleExclusion,
  useDeleteWafRuleExclusion,
  useUpdateWafRuleExclusion,
  useWafRuleExclusions,
} from '@/hooks/use-waf-rule-exclusions';
import {
  useAddCrowdsecAllowlistEntry,
  useAddCrowdsecBan,
  useAddCrowdsecStaticBan,
  useCalibrateAutoban,
  useCrowdsecAllowlist,
  useCrowdsecAutobanConfig,
  useCrowdsecAutobanRuns,
  useCrowdsecConsoleStatus,
  useCrowdsecDecisions,
  useCrowdsecL4Status,
  useCrowdsecStatus,
  useDeleteCrowdsecDecision,
  useDisenrollCrowdsecConsole,
  useEnrollCrowdsecConsole,
  usePatchCrowdsecAutobanConfig,
  usePatchCrowdsecConsoleMeta,
  usePatchCrowdsecL4Mode,
  usePruneCrowdsecBouncers,
  useRemoveCrowdsecAllowlistEntry,
} from '@/hooks/use-crowdsec';
import type {
  WafEvent,
  WafEventScope,
  WafEventSeverity,
  WafEventsQuery,
  WafEventsResponse,
  WafScraperStatus,
  CrowdsecAllowlistEntry,
  CrowdsecDecision,
  CrowdsecDecisionScope,
  CrowdsecListDecisionsQuery,
  CrowdsecStatus,
  CrowdsecAutobanCalibrationResponse,
  CrowdsecAutobanConfig,
  CrowdsecAutobanOutcome,
  CrowdsecAutobanRun,
  CrowdsecL4Mode,
  WafRuleExclusion,
  WafRuleExclusionScope,
} from '@k8s-hosting/api-contracts';
import { buildHostnameRegexFromEventHost } from '@k8s-hosting/api-contracts';

// ─── WAF tab filter option constants (moved from PosturePage) ──────────

const SINCE_OPTIONS: ReadonlyArray<{ readonly label: string; readonly seconds: number }> = [
  { label: 'Last hour', seconds: 3_600 },
  { label: 'Last 24 hours', seconds: 86_400 },
  { label: 'Last 7 days', seconds: 604_800 },
  { label: 'All', seconds: 0 },
];

const SEVERITY_OPTIONS: ReadonlyArray<{ readonly label: string; readonly value: '' | WafEventSeverity }> = [
  { label: 'All severities', value: '' },
  { label: 'Critical only', value: 'critical' },
  { label: 'Warning only', value: 'warning' },
  { label: 'Info only', value: 'info' },
];

const SCOPE_OPTIONS: ReadonlyArray<{ readonly label: string; readonly value: '' | WafEventScope }> = [
  { label: 'All scopes', value: '' },
  { label: 'Admin/platform hosts only', value: 'admin-host' },
  { label: 'Tenant routes only', value: 'tenant-route' },
];

export function WafEventsTab() {
  const [ruleId, setRuleId] = useState('');
  const [severity, setSeverity] = useState<'' | WafEventSeverity>('');
  const [host, setHost] = useState('');
  const [scope, setScope] = useState<'' | WafEventScope>('');
  const [sinceSeconds, setSinceSeconds] = useState(86_400);
  const [live, setLive] = useState(false);
  // Lifted to tab-level so the BanIpModal can render once and survive
  // any WafEventRow re-mounting from the 30s refetch.
  const [banModalPrefill, setBanModalPrefill] = useState<{ value: string; reason: string } | null>(null);
  // F4 — "Whitelist this rule for this host" prefill, same lifting reason.
  const [whitelistPrefill, setWhitelistPrefill] = useState<{
    ruleId: string;
    hostnameRegex: string;
    reason: string;
  } | null>(null);

  // Debounce text inputs so a keystroke doesn't fan out into one request per
  // character — the backend would re-run the same expensive cluster-wide
  // query 13 times for "admin.example".
  const debouncedRuleId = useDebouncedValue(ruleId, 400);
  const debouncedHost = useDebouncedValue(host, 400);

  const query: WafEventsQuery = useMemo(() => {
    const q: WafEventsQuery = { sinceSeconds, limit: 200 };
    if (debouncedRuleId.trim()) q.ruleId = debouncedRuleId.trim();
    if (severity) q.severity = severity;
    if (debouncedHost.trim()) q.host = debouncedHost.trim();
    if (scope) q.scope = scope;
    return q;
  }, [debouncedRuleId, severity, debouncedHost, scope, sinceSeconds]);

  const { data, isLoading, isError, isFetching, error, refetch } = useWafEvents(query, { live });
  const payload: WafEventsResponse | undefined = data?.data;
  const refresh = useRefreshWafScraper();

  const onRefresh = () => {
    // 1. Trigger an inline scrape cycle (server rate-limits to 1/3s).
    // 2. Refetch the listing immediately — don't wait for the polling tick.
    refresh.mutate(undefined, { onSettled: () => { void refetch(); } });
  };

  return (
    <section className="space-y-4" data-testid="waf-events-tab">
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 text-sm text-gray-700 dark:text-gray-200">
        Cluster-wide WAF events from the ModSecurity / OWASP CRS rule engine.
        Includes <strong>admin/api/client/platform-host</strong> events that have
        no per-tenant ingress route (e.g. CRS rule 930120 blocking
        <code className="text-xs mx-1">POST /admin/system-backup/dr-drill/runs</code>),
        plus the same per-route events surfaced under each Domain.
        Scraper polls the <code className="text-xs">modsec-crs</code> pod every 30s;
        admin-host events are capped at 500 globally, per-route at 50.
      </div>

      {/* Scraper-status banner — explains an empty table BEFORE the operator wonders. */}
      {payload?.scraperStatus && (
        <WafScraperStatusBanner
          status={payload.scraperStatus}
          eventsInView={payload.events.length}
          lastInsertAt={payload.stats.mostRecentAt}
        />
      )}

      {/* Live-tail + refresh controls */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3" data-testid="waf-controls">
        <div className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
          <span>
            Auto-refresh:{' '}
            <span className={live ? 'font-semibold text-emerald-600 dark:text-emerald-400' : 'text-gray-700 dark:text-gray-300'}>
              {live ? 'live (3s)' : '30s'}
            </span>
          </span>
          {isFetching && <span className="text-brand-600 dark:text-brand-400">· reloading…</span>}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setLive((v) => !v)}
            className={[
              'inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm font-medium',
              live
                ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-200 dark:border-emerald-700'
                : 'border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700',
            ].join(' ')}
            data-testid="waf-live-toggle"
            aria-pressed={live}
          >
            {live ? <Pause size={14} /> : <Play size={14} />}
            {live ? 'Stop live tail' : 'Live tail'}
          </button>
          <button
            type="button"
            onClick={onRefresh}
            disabled={refresh.isPending}
            className="inline-flex items-center gap-1 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
            data-testid="waf-refresh-now"
            title="Force a scrape cycle now (rate-limited to once per 3s)"
          >
            <RefreshCw size={14} className={refresh.isPending ? 'animate-spin' : ''} />
            Refresh now
          </button>
        </div>
      </div>

      {/* Stats panel */}
      {payload?.stats && <WafStatsPanel stats={payload.stats} />}

      {/* Filter bar */}
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3" data-testid="waf-filters">
        <div className="flex flex-wrap items-end gap-3">
          <FilterField label="Rule ID(s)" hint="comma-separated">
            <input
              type="text"
              value={ruleId}
              onChange={(e) => setRuleId(e.target.value)}
              placeholder="930120,931100"
              className="w-40 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-sm font-mono"
              data-testid="waf-filter-rule"
            />
          </FilterField>
          <FilterField label="Severity">
            <select
              value={severity}
              onChange={(e) => setSeverity(e.target.value as '' | WafEventSeverity)}
              className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-sm"
              data-testid="waf-filter-severity"
            >
              {SEVERITY_OPTIONS.map((o) => (
                <option key={o.value || 'all'} value={o.value}>{o.label}</option>
              ))}
            </select>
          </FilterField>
          <FilterField label="Host substring">
            <input
              type="text"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="admin."
              className="w-44 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-sm font-mono"
              data-testid="waf-filter-host"
            />
          </FilterField>
          <FilterField label="Scope">
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value as '' | WafEventScope)}
              className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-sm"
              data-testid="waf-filter-scope"
            >
              {SCOPE_OPTIONS.map((o) => (
                <option key={o.value || 'all'} value={o.value}>{o.label}</option>
              ))}
            </select>
          </FilterField>
          <FilterField label="Window">
            <select
              value={sinceSeconds}
              onChange={(e) => setSinceSeconds(Number(e.target.value))}
              className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-sm"
              data-testid="waf-filter-since"
            >
              {SINCE_OPTIONS.map((o) => (
                <option key={o.seconds} value={o.seconds}>{o.label}</option>
              ))}
            </select>
          </FilterField>
          <button
            type="button"
            onClick={() => { setRuleId(''); setSeverity(''); setHost(''); setScope(''); setSinceSeconds(86_400); }}
            className="ml-auto inline-flex items-center gap-1 rounded-md border border-gray-300 dark:border-gray-600 px-3 py-1 text-xs text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
            data-testid="waf-filter-clear"
          >
            <Filter size={12} /> Clear filters
          </button>
        </div>
      </div>

      {isLoading && <SkeletonLoader />}
      {isError && (
        <div className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-900/20 dark:border-red-700 p-4 text-sm text-red-700 dark:text-red-300">
          Failed to load WAF events: {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      {payload && (
        <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-900 dark:text-gray-100 flex items-center justify-between">
            <span>Events ({payload.events.length}{payload.truncated ? '+' : ''})</span>
            {payload.truncated && (
              <span className="text-xs text-amber-600 dark:text-amber-400">
                Result capped — narrow filters to see older events
              </span>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm" data-testid="waf-events-table">
              <thead className="bg-gray-50 dark:bg-gray-900/50 text-gray-600 dark:text-gray-400 text-xs uppercase">
                <tr>
                  <th className="px-4 py-2 text-left">When</th>
                  <th className="px-4 py-2 text-left">Rule</th>
                  <th className="px-4 py-2 text-left">Severity</th>
                  <th className="px-4 py-2 text-left">Host</th>
                  <th className="px-4 py-2 text-left">Source IP</th>
                  <th className="px-4 py-2 text-left">Request</th>
                  <th className="px-4 py-2 text-left">Message</th>
                  <th className="px-4 py-2 text-left">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {payload.events.map((ev) => (
                  <WafEventRow
                    key={ev.id}
                    ev={ev}
                    onBan={(ip) => setBanModalPrefill({ value: ip, reason: `WAF: rule ${ev.ruleId} on ${ev.hostname} (${ev.requestMethod ?? 'GET'} ${ev.requestUri ?? '/'})` })}
                    onWhitelist={() => setWhitelistPrefill({
                      ruleId: ev.ruleId,
                      hostnameRegex: buildHostnameRegexFromEventHost(ev.hostname || ''),
                      reason: `False-positive on ${ev.requestMethod ?? 'GET'} ${ev.requestUri ?? '/'}`,
                    })}
                  />
                ))}
                {payload.events.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-4 py-8 text-center text-gray-500 text-sm">
                      <WafEmptyState
                        scraperStatus={payload.scraperStatus}
                        lastInsertAt={payload.stats.mostRecentAt}
                        hasActiveFilters={Boolean(ruleId || severity || host || scope)}
                      />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {banModalPrefill && (
        <BanIpModal
          // key forces remount when the operator clicks "Ban IP" on a different
          // WAF row while the modal is already open from a previous row —
          // without it, the modal's internal state would still hold the first
          // row's prefill values.
          key={`${banModalPrefill.value}|${banModalPrefill.reason}`}
          prefill={banModalPrefill}
          onClose={() => setBanModalPrefill(null)}
        />
      )}

      {whitelistPrefill && (
        <WhitelistRuleModal
          key={`${whitelistPrefill.ruleId}|${whitelistPrefill.hostnameRegex}`}
          prefill={whitelistPrefill}
          onClose={() => setWhitelistPrefill(null)}
        />
      )}
    </section>
  );
}

function ageSeconds(iso: string | null): number | null {
  if (!iso) return null;
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

// Distinguishes the three reasons an operator might see "no events":
//   1. modsec-crs pod not running         → scraper has nothing to read
//   2. scraper hasn't fired its first cycle yet (≤15s after process boot)
//   3. scraper is healthy but cluster is genuinely quiet
function WafScraperStatusBanner({
  status,
  eventsInView,
  lastInsertAt,
}: {
  status: WafScraperStatus;
  eventsInView: number;
  lastInsertAt: string | null;
}) {
  const intervalS = Math.round(status.scrapeIntervalMs / 1000);
  const sinceLastRun = ageSeconds(status.lastRunAt);
  const sinceLastInsert = ageSeconds(lastInsertAt);

  // Healthy + recent insert + table populated = happy path, suppress banner
  // so it doesn't add visual noise to an operator who is just browsing.
  if (status.hasRunOnce && status.modsecPodFound && eventsInView > 0) {
    return null;
  }

  let variant: 'good' | 'warn' | 'bad' = 'warn';
  let title = '';
  let detail: React.ReactNode = null;

  if (!status.hasRunOnce) {
    variant = 'warn';
    title = 'Scraper has not run yet';
    detail = <>The platform-api scheduler fires its first cycle ~15s after process start. If you just rolled out the deployment, give it a moment.</>;
  } else if (!status.modsecPodFound) {
    variant = 'bad';
    title = 'modsec-crs pod not found';
    detail = (
      <>
        The scraper ran <span className="font-medium">{sinceLastRun !== null ? formatAge(sinceLastRun) : 'recently'}</span> but found no pod with{' '}
        <code className="text-xs">app=modsec-crs</code> in the <code className="text-xs">traefik</code> namespace.
        This is normal in single-node clusters where the anti-affinity replicas=2 doesn't satisfy.
        Without it, no events will be captured.
      </>
    );
  } else if (eventsInView === 0 && sinceLastInsert !== null && sinceLastInsert > 24 * 3600) {
    variant = 'good';
    title = 'No events in window';
    detail = (
      <>
        Scraper is healthy (last cycle {sinceLastRun !== null ? formatAge(sinceLastRun) : 'unknown'}, every {intervalS}s) — no CRS rules fired in the selected window.
        Most-recent event was {formatAge(sinceLastInsert)}; widen the Window filter to see it.
      </>
    );
  } else if (eventsInView === 0) {
    variant = 'good';
    title = 'Scraper healthy — cluster is quiet';
    detail = (
      <>
        Last cycle {sinceLastRun !== null ? formatAge(sinceLastRun) : 'unknown'} (every {intervalS}s). No CRS rules fired during the current window — that's a good sign.
      </>
    );
  } else {
    return null;
  }

  const tone =
    variant === 'good' ? 'border-emerald-300 bg-emerald-50 dark:bg-emerald-900/20 dark:border-emerald-700 text-emerald-900 dark:text-emerald-100' :
    variant === 'warn' ? 'border-amber-300 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-700 text-amber-900 dark:text-amber-100' :
                         'border-red-300 bg-red-50 dark:bg-red-900/20 dark:border-red-700 text-red-900 dark:text-red-100';
  const Icon = variant === 'good' ? CheckCircle2 : variant === 'warn' ? Clock : AlertTriangle;

  return (
    <div className={`rounded-lg border p-4 ${tone}`} data-testid="waf-scraper-status">
      <div className="flex items-start gap-3">
        <Icon size={18} className="mt-0.5 shrink-0" />
        <div className="flex-1 text-sm">
          <div className="font-semibold mb-1">{title}</div>
          <div className="text-xs leading-relaxed">{detail}</div>
          {status.lastCycleErrors.length > 0 && (
            <details className="mt-2 text-xs">
              <summary className="cursor-pointer font-medium">
                Last cycle errors ({status.lastCycleErrors.length})
              </summary>
              <ul className="mt-1 list-disc pl-5 font-mono text-[11px]">
                {status.lastCycleErrors.map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}

function WafEmptyState({
  scraperStatus,
  lastInsertAt,
  hasActiveFilters,
}: {
  scraperStatus: WafScraperStatus;
  lastInsertAt: string | null;
  hasActiveFilters: boolean;
}) {
  const sinceLastInsert = ageSeconds(lastInsertAt);
  if (!scraperStatus.hasRunOnce) {
    return <span>Waiting for the first scraper cycle.</span>;
  }
  if (!scraperStatus.modsecPodFound) {
    return <span>No <code className="text-xs">modsec-crs</code> pod available — see status banner above.</span>;
  }
  if (hasActiveFilters) {
    return (
      <span>
        No events match the current filters
        {lastInsertAt && ` — last scraper write was ${formatAge(sinceLastInsert ?? 0)}`}.
        Clear filters to see the full window.
      </span>
    );
  }
  if (!lastInsertAt) {
    return <span>Scraper is healthy but no CRS rules have fired yet (table is empty).</span>;
  }
  return (
    <span>
      No events in the selected window. Last scraper write was {formatAge(sinceLastInsert ?? 0)} — widen the Window filter to see it.
    </span>
  );
}

function WafStatsPanel({ stats }: { stats: WafEventsResponse['stats'] }) {
  const hours = Math.round(stats.windowSeconds / 3_600);
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3" data-testid="waf-stats-panel">
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
        <div className="flex items-center gap-2 text-gray-600 dark:text-gray-400 text-xs uppercase">
          <Activity size={14} /> Events ({hours}h)
        </div>
        <div className="text-2xl font-semibold text-gray-900 dark:text-gray-100 mt-2">
          {stats.totalEvents.toLocaleString()}
        </div>
        <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          {stats.totalEventsAdminHost.toLocaleString()} admin / {stats.totalEventsTenantRoute.toLocaleString()} tenant
        </div>
      </div>

      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
        <div className="flex items-center gap-2 text-gray-600 dark:text-gray-400 text-xs uppercase">
          <ShieldAlert size={14} /> Top rules ({hours}h)
        </div>
        <ul className="mt-2 space-y-1 text-xs" data-testid="waf-top-rules">
          {stats.topRules.length === 0 && <li className="text-gray-500">No events in window</li>}
          {stats.topRules.slice(0, 5).map((r) => (
            <li key={r.ruleId} className="flex items-baseline justify-between gap-2">
              <span className="font-mono text-gray-700 dark:text-gray-200 shrink-0">{r.ruleId}</span>
              <span className="truncate text-gray-600 dark:text-gray-400 text-[11px] flex-1" title={r.sampleMessage}>{r.sampleMessage}</span>
              <span className="font-medium text-gray-900 dark:text-gray-100 shrink-0">{r.count}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
        <div className="flex items-center gap-2 text-gray-600 dark:text-gray-400 text-xs uppercase">
          <Globe size={14} /> Top hosts ({hours}h)
        </div>
        <ul className="mt-2 space-y-1 text-xs" data-testid="waf-top-hosts">
          {stats.topHosts.length === 0 && <li className="text-gray-500">No events in window</li>}
          {stats.topHosts.slice(0, 5).map((h) => (
            <li key={`${h.hostname}-${h.scope}`} className="flex items-baseline justify-between gap-2">
              <span className="font-mono text-gray-700 dark:text-gray-200 truncate" title={h.hostname}>{h.hostname || '(empty)'}</span>
              <span className="text-[10px] uppercase text-gray-500 shrink-0">{h.scope === 'admin-host' ? 'admin' : 'tenant'}</span>
              <span className="font-medium text-gray-900 dark:text-gray-100 shrink-0">{h.count}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function WafEventRow({ ev, onBan, onWhitelist }: {
  ev: WafEvent;
  onBan: (ip: string) => void;
  onWhitelist: () => void;
}) {
  const sevTone =
    ev.severity === 'critical'
      ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-200'
      : ev.severity === 'warning'
        ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200'
        : 'bg-gray-100 text-gray-700 dark:bg-gray-700/40 dark:text-gray-300';
  // Don't offer a Ban button for the parser's "no IP extractable" placeholder.
  const banAvailable = Boolean(ev.sourceIp && ev.sourceIp !== '0.0.0.0');
  // Don't offer whitelist when hostname is empty — operator should
  // craft a hostname regex manually from the Exclusions tab in that case.
  const whitelistAvailable = Boolean(ev.hostname);
  return (
    <tr>
      <td className="px-4 py-2 font-mono text-[11px] text-gray-700 dark:text-gray-200 whitespace-nowrap">
        {new Date(ev.occurredAt).toISOString().replace('T', ' ').slice(0, 19)}
      </td>
      <td className="px-4 py-2 font-mono text-xs text-gray-900 dark:text-gray-100">{ev.ruleId}</td>
      <td className="px-4 py-2">
        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${sevTone}`}>
          {ev.severity}
        </span>
      </td>
      <td className="px-4 py-2 text-xs text-gray-700 dark:text-gray-200">
        <span className="font-mono">{ev.hostname || '(unknown)'}</span>
        {ev.scope === 'admin-host' && (
          <span className="ml-1 text-[9px] uppercase text-amber-700 dark:text-amber-300">admin</span>
        )}
      </td>
      <td className="px-4 py-2 font-mono text-xs text-gray-700 dark:text-gray-200">{ev.sourceIp || '—'}</td>
      <td className="px-4 py-2 font-mono text-xs text-gray-700 dark:text-gray-200">
        {ev.requestMethod ? `${ev.requestMethod} ` : ''}{ev.requestUri || '/'}
      </td>
      <td className="px-4 py-2 text-xs text-gray-700 dark:text-gray-200">{ev.message}</td>
      <td className="px-4 py-2">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center">
          {banAvailable && (
            <button
              type="button"
              onClick={() => onBan(ev.sourceIp as string)}
              className="inline-flex items-center gap-1 rounded-md border border-red-300 bg-red-50 dark:bg-red-900/20 dark:border-red-700 px-2 py-0.5 text-[11px] font-medium text-red-700 dark:text-red-200 hover:bg-red-100 dark:hover:bg-red-900/40"
              data-testid={`waf-ban-${ev.id}`}
              title={`Ban ${ev.sourceIp} via CrowdSec`}
            >
              <Ban size={11} /> Ban IP
            </button>
          )}
          {whitelistAvailable && (
            <button
              type="button"
              onClick={onWhitelist}
              className="inline-flex items-center gap-1 rounded-md border border-emerald-300 bg-emerald-50 dark:bg-emerald-900/20 dark:border-emerald-700 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-200 hover:bg-emerald-100 dark:hover:bg-emerald-900/40"
              data-testid={`waf-whitelist-${ev.id}`}
              title={`Whitelist rule ${ev.ruleId} for ${ev.hostname}`}
            >
              <ShieldOff size={11} /> Whitelist
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

function FilterField({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-gray-600 dark:text-gray-400">
      <span>
        {label}
        {hint && <span className="ml-1 text-[10px] text-gray-400">({hint})</span>}
      </span>
      {children}
    </label>
  );
}

// ─── Banned IPs tab ─────────────────────────────────────────────────────
//
// Surfaces active CrowdSec decisions (community blocklist + scenario hits +
// operator-added manual bans). Enforcement is cluster-wide because the
// Traefik DaemonSet's crowdsec middleware queries the LAPI on every
// request — see backend/src/modules/security-hardening/crowdsec.ts.

const DURATION_OPTIONS: ReadonlyArray<{ readonly label: string; readonly value: string }> = [
  { label: '1 hour', value: '1h' },
  { label: '4 hours', value: '4h' },
  { label: '12 hours', value: '12h' },
  { label: '1 day', value: '24h' },
  { label: '7 days', value: '168h' },
  { label: '30 days', value: '720h' },
];

export function BannedIpsTab() {
  const [q, setQ] = useState('');
  const [scope, setScope] = useState<'' | CrowdsecDecisionScope>('');
  const [manualOnly, setManualOnly] = useState(false);
  const [staticOnly, setStaticOnly] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [staticAddOpen, setStaticAddOpen] = useState(false);

  const debouncedQ = useDebouncedValue(q, 400);

  const query: CrowdsecListDecisionsQuery = useMemo(() => {
    const out: CrowdsecListDecisionsQuery = {};
    if (debouncedQ.trim()) out.q = debouncedQ.trim();
    if (scope) out.scope = scope;
    if (manualOnly) out.manualOnly = true;
    if (staticOnly) out.staticOnly = true;
    return out;
  }, [debouncedQ, scope, manualOnly, staticOnly]);

  const { data, isLoading, isError, error, refetch, isFetching } = useCrowdsecDecisions(query);
  const status = useCrowdsecStatus();
  const del = useDeleteCrowdsecDecision();

  const payload = data?.data;

  return (
    <section className="space-y-4" data-testid="banned-ips-tab">
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 text-sm text-gray-700 dark:text-gray-200">
        Active CrowdSec ban decisions (community blocklist + scenario triggers + operator-added manual bans).
        Enforcement is cluster-wide — the <code className="text-xs">crowdsec</code> Traefik middleware queries the
        LAPI on every request, so a ban applies on every node simultaneously. Adding or removing a ban here
        propagates to all <code className="text-xs">traefik</code> DaemonSet pods within a few seconds.
      </div>

      {status.data?.data && <CrowdsecStatusPanel status={status.data.data} />}

      {/* F2 — Allowlist + Static blocklist (operator-managed lists) */}
      <AllowlistCard />
      <StaticBlocklistCard onOpenAdd={() => setStaticAddOpen(true)} />

      {/* F5 — CrowdSec Console enrollment (opt-in, super_admin only) */}
      <CrowdsecConsoleCard />

      {/* F3 UI — Auto-ban config + recent runs + calibration dry-run */}
      <CrowdsecAutobanCard />

      {/* F1+F6 — L4 enforcement toggle (highest-risk, operator IP guard) */}
      <CrowdsecL4Card />

      {/* Controls */}
      <div className="flex flex-wrap items-end justify-between gap-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
        <div className="flex flex-wrap items-end gap-3">
          <FilterField label="Search" hint="IP / CIDR / country">
            <input
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="1.2.3.4 or US"
              className="w-44 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-sm font-mono"
              data-testid="bans-filter-q"
            />
          </FilterField>
          <FilterField label="Scope">
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value as '' | CrowdsecDecisionScope)}
              className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-sm"
              data-testid="bans-filter-scope"
            >
              <option value="">All scopes</option>
              <option value="Ip">IP</option>
              <option value="Range">Range (CIDR)</option>
              <option value="Country">Country</option>
              <option value="AS">AS</option>
            </select>
          </FilterField>
          <label className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-200">
            <input
              type="checkbox"
              checked={manualOnly}
              onChange={(e) => setManualOnly(e.target.checked)}
              data-testid="bans-filter-manual"
            />
            Manual bans only
          </label>
          <label className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-200">
            <input
              type="checkbox"
              checked={staticOnly}
              onChange={(e) => setStaticOnly(e.target.checked)}
              data-testid="bans-filter-static"
            />
            Static (1y) bans only
          </label>
        </div>
        <div className="flex items-center gap-2">
          {isFetching && <span className="text-xs text-brand-600 dark:text-brand-400">reloading…</span>}
          <button
            type="button"
            onClick={() => { void refetch(); }}
            disabled={isFetching}
            className="inline-flex items-center gap-1 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
            data-testid="bans-reload"
          >
            <RefreshCw size={14} className={isFetching ? 'animate-spin' : ''} />
            Reload
          </button>
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="inline-flex items-center gap-1 rounded-md border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 px-3 py-1.5 text-sm font-medium text-red-700 dark:text-red-200 hover:bg-red-100 dark:hover:bg-red-900/40"
            data-testid="bans-add-manual"
          >
            <Plus size={14} /> Add manual ban
          </button>
        </div>
      </div>

      {isLoading && <SkeletonLoader />}
      {isError && (
        <div className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-900/20 dark:border-red-700 p-4 text-sm text-red-700 dark:text-red-300">
          Failed to load decisions: {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      {payload && (
        <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-900 dark:text-gray-100 flex items-center justify-between">
            <span>Active bans ({payload.decisions.length} shown / {payload.totalActive} total)</span>
            {del.isError && (
              <span className="text-xs text-red-600 dark:text-red-400">
                Unban failed: {del.error?.message ?? 'unknown error'}
              </span>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm" data-testid="bans-table">
              <thead className="bg-gray-50 dark:bg-gray-900/50 text-gray-600 dark:text-gray-400 text-xs uppercase">
                <tr>
                  <th className="px-4 py-2 text-left">Scope</th>
                  <th className="px-4 py-2 text-left">Value</th>
                  <th className="px-4 py-2 text-left">Type</th>
                  <th className="px-4 py-2 text-left">Origin</th>
                  <th className="px-4 py-2 text-left">Reason</th>
                  <th className="px-4 py-2 text-left">Time left</th>
                  <th className="px-4 py-2 text-left">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {payload.decisions.map((d) => (
                  <DecisionRow
                    key={d.id}
                    d={d}
                    onUnban={() => del.mutate(d.id)}
                    isUnbanning={del.isPending && del.variables === d.id}
                  />
                ))}
                {payload.decisions.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-gray-500 text-sm">
                      {payload.totalActive > 0
                        ? 'No bans match the current filters. Clear filters to see all.'
                        : 'No active bans. The community blocklist refreshes hourly — check back, or add a manual ban above.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {addOpen && (
        <BanIpModal
          prefill={{ value: '', reason: '' }}
          onClose={() => setAddOpen(false)}
        />
      )}
      {staticAddOpen && (
        <StaticBanModal onClose={() => setStaticAddOpen(false)} />
      )}
    </section>
  );
}

function CrowdsecStatusPanel({ status }: { status: CrowdsecStatus }) {
  const coverageOk = status.coverage.traefikPodsTotal > 0 && status.coverage.traefikPodsCovered === status.coverage.traefikPodsTotal;
  const fullCoverage = coverageOk && status.coverage.traefikPodsTotal === status.coverage.nodesTotal;
  // Bans are only enforced if at least one bouncer has pulled recently
  // (default <5min ago). If every registered bouncer is stale, the
  // Traefik plugin isn't actually reaching the LAPI — bans won't fire
  // regardless of how many decisions are in the table.
  const liveBouncers = status.bouncers.filter((b) => b.online).length;
  const enforcementBroken = status.bouncers.length > 0 && liveBouncers === 0;
  return (
    <div className="space-y-3" data-testid="crowdsec-status-panel">
      {enforcementBroken && (
        <div className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-900/20 dark:border-red-700 p-3 text-sm" data-testid="crowdsec-enforcement-warning">
          <div className="flex items-start gap-2">
            <AlertTriangle size={16} className="text-red-600 dark:text-red-300 mt-0.5 shrink-0" />
            <div>
              <div className="font-semibold text-red-900 dark:text-red-100">
                Bans aren't being enforced — all {status.bouncers.length} bouncer{status.bouncers.length === 1 ? '' : 's'} stale
              </div>
              <div className="text-xs text-red-800 dark:text-red-200 mt-1">
                No bouncer has pulled decisions from the LAPI in the last 5 minutes.
                Adding a manual ban here will succeed but won't actually block traffic until at least one bouncer reconnects.
                Check the Traefik <code className="text-[11px]">crowdsec</code> middleware plugin can resolve <code className="text-[11px]">crowdsec.crowdsec.svc.cluster.local:8080</code> — bare-hostname DNS lookup failures are the common cause.
              </div>
            </div>
          </div>
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
        <div className="flex items-center gap-2 text-gray-600 dark:text-gray-400 text-xs uppercase">
          <ShieldAlert size={14} /> LAPI
        </div>
        <div className="text-base font-semibold mt-1 flex items-center gap-2">
          {status.lapiHealthy
            ? <span className="text-emerald-700 dark:text-emerald-300">healthy</span>
            : <span className="text-red-700 dark:text-red-300">unreachable</span>}
        </div>
        <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          {status.lapiError ?? `${status.scenariosLoaded} scenarios loaded`}
        </div>
        <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          Community blocklist:{' '}
          {status.communityBlocklistEnabled
            ? <span className="text-emerald-600 dark:text-emerald-400">enabled</span>
            : <span className="text-amber-600 dark:text-amber-400">disabled</span>}
          {!status.capiAuthenticated && <span className="text-amber-600 dark:text-amber-400"> (CAPI auth failed)</span>}
        </div>
        {/* Decision counts — surfaced when cscli was reachable on the
            most-recent status fetch. Community blocklist count + total
            give operators an at-a-glance sense of how many IPs are
            actively dropping. Operators can review individual entries
            in the "Active decisions" table below (use the Search field
            to find specific IPs; CAPI-origin entries dominate when
            community blocklist is enabled, so the search box is the
            practical review tool for a 6M-entry list). */}
        {status.decisionCounts ? (
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            <span className="font-mono text-gray-700 dark:text-gray-300">
              {status.decisionCounts.communityBlocklist.toLocaleString()}
            </span>{' '}community IPs ·{' '}
            <span className="font-mono text-gray-700 dark:text-gray-300">
              {status.decisionCounts.total.toLocaleString()}
            </span>{' '}total decisions
            {Object.keys(status.decisionCounts.byOrigin).length > 1 && (
              <span className="ml-1 text-[10px] opacity-60" title={
                Object.entries(status.decisionCounts.byOrigin)
                  .sort((a, b) => b[1] - a[1])
                  .map(([o, n]) => `${o}: ${n.toLocaleString()}`)
                  .join('\n')
              }>
                (hover for origin breakdown)
              </span>
            )}
          </div>
        ) : (
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-1 italic">
            decision counts unavailable (cscli unreachable)
          </div>
        )}
      </div>

      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
        <div className="flex items-center gap-2 text-gray-600 dark:text-gray-400 text-xs uppercase">
          <Globe size={14} /> Enforcement coverage
        </div>
        <div className="text-base font-semibold mt-1">
          {fullCoverage
            ? <span className="text-emerald-700 dark:text-emerald-300">all {status.coverage.traefikPodsCovered} / {status.coverage.nodesTotal} nodes</span>
            : <span className="text-amber-700 dark:text-amber-300">{status.coverage.traefikPodsCovered} / {status.coverage.traefikPodsTotal} Traefik pods</span>}
        </div>
        <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          Bouncer enforces on every Traefik replica via the crowdsec middleware.
        </div>
        <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          modsec-crs pods: {status.coverage.modsecPodsTotal} (independent — feeds WAF Events tab)
        </div>
      </div>

      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-gray-600 dark:text-gray-400 text-xs uppercase">
            <Activity size={14} /> Bouncers ({status.bouncers.length})
          </div>
          <CrowdsecBouncerPruneButton staleCount={status.bouncers.length - liveBouncers} />
        </div>
        <ul className="mt-2 space-y-1 text-xs" data-testid="crowdsec-bouncers">
          {status.bouncers.length === 0 && <li className="text-amber-600 dark:text-amber-400">No bouncers registered — bans won't be enforced!</li>}
          {status.bouncers.map((b) => (
            <li key={b.name} className="flex items-center justify-between gap-2">
              <span className="font-mono text-gray-700 dark:text-gray-200">{b.name}</span>
              <span className={b.online ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}>
                {b.online ? 'online' : 'stale'}
              </span>
            </li>
          ))}
        </ul>
        <div className="mt-2 text-[10px] text-gray-500 dark:text-gray-400 italic">
          Stale bouncers (no LAPI pull in 24h+) are auto-pruned every 24h.
          Each Traefik pod rollover leaves an old registration behind because
          the maxlerebourg plugin doesn't send a stable name.
        </div>
      </div>
      </div>
    </div>
  );
}

function DecisionRow({ d, onUnban, isUnbanning }: { d: CrowdsecDecision; onUnban: () => void; isUnbanning: boolean }) {
  const expiresIn = d.expiresAt
    ? formatAge(Math.max(0, Math.floor((new Date(d.expiresAt).getTime() - Date.now()) / 1000))).replace(' ago', '')
    : d.duration;
  return (
    <tr>
      <td className="px-4 py-2 text-xs text-gray-700 dark:text-gray-200 whitespace-nowrap">{d.scope}</td>
      <td className="px-4 py-2 font-mono text-xs text-gray-900 dark:text-gray-100">{d.value}</td>
      <td className="px-4 py-2 text-xs">
        <span className="inline-flex items-center rounded-full bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-200 px-2 py-0.5 text-[10px] font-medium">
          {d.type}{d.simulated && <span className="ml-1 opacity-70">(sim)</span>}
        </span>
      </td>
      <td className="px-4 py-2 text-xs text-gray-700 dark:text-gray-200">
        <span className="font-mono">{d.origin || '—'}</span>
        {d.staticByOperator && <span className="ml-1 text-[9px] uppercase text-purple-700 dark:text-purple-300">static</span>}
        {d.manualByOperator && !d.staticByOperator && <span className="ml-1 text-[9px] uppercase text-amber-700 dark:text-amber-300">manual</span>}
      </td>
      <td className="px-4 py-2 text-xs text-gray-700 dark:text-gray-200 max-w-md truncate" title={d.scenario}>{d.scenario}</td>
      <td className="px-4 py-2 text-xs text-gray-700 dark:text-gray-200 whitespace-nowrap">{expiresIn}</td>
      <td className="px-4 py-2">
        <button
          type="button"
          onClick={onUnban}
          disabled={isUnbanning}
          className="inline-flex items-center gap-1 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-0.5 text-[11px] font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
          data-testid={`bans-unban-${d.id}`}
          title={`Unban ${d.value} (decision id ${d.id})`}
        >
          <Trash2 size={11} /> {isUnbanning ? 'Unbanning…' : 'Unban'}
        </button>
      </td>
    </tr>
  );
}

// ─── Shared Ban-IP modal (used by WAF Events row + Banned IPs tab) ──────

function BanIpModal({
  prefill,
  onClose,
}: {
  prefill: { value: string; reason: string };
  onClose: () => void;
}) {
  const [value, setValue] = useState(prefill.value);
  const [scope, setScope] = useState<CrowdsecDecisionScope>('Ip');
  const [duration, setDuration] = useState('4h');
  const [reason, setReason] = useState(prefill.reason);
  const add = useAddCrowdsecBan();

  const valid = /^[a-fA-F0-9.:/]+$/.test(value) && value.length >= 1 && reason.trim().length >= 3;

  const onSubmit = () => {
    if (!valid) return;
    add.mutate(
      { value, scope, duration, reason: reason.trim() },
      { onSuccess: () => onClose() },
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-lg rounded-lg bg-white dark:bg-gray-900 shadow-xl" data-testid="ban-ip-modal">
        <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 px-5 py-3">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Ban IP (CrowdSec)</h3>
          <button type="button" onClick={onClose} className="text-gray-500 hover:text-gray-700">✕</button>
        </div>
        <div className="px-5 py-4 space-y-3 text-sm">
          <div>
            <label className="block text-xs uppercase text-gray-600 dark:text-gray-400 mb-1">IP / CIDR</label>
            <input
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="1.2.3.4 or 1.2.3.0/24"
              className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm font-mono"
              data-testid="ban-modal-value"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs uppercase text-gray-600 dark:text-gray-400 mb-1">Scope</label>
              <select
                value={scope}
                onChange={(e) => setScope(e.target.value as CrowdsecDecisionScope)}
                className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
                data-testid="ban-modal-scope"
              >
                <option value="Ip">IP</option>
                <option value="Range">Range (CIDR)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs uppercase text-gray-600 dark:text-gray-400 mb-1">Duration</label>
              <select
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
                className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
                data-testid="ban-modal-duration"
              >
                {DURATION_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs uppercase text-gray-600 dark:text-gray-400 mb-1">Reason</label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Reason for the ban — surfaced in the decisions list"
              rows={3}
              className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
              data-testid="ban-modal-reason"
            />
            <div className="text-[10px] text-gray-500 mt-1">
              Will be stored as <code>admin-panel:&lt;your-userId&gt;:{reason.trim() || '<reason>'}</code> so it's
              distinguishable from automatic bans.
            </div>
          </div>
          {add.isError && (
            <div className="rounded-md border border-red-300 bg-red-50 dark:bg-red-900/20 dark:border-red-700 p-2 text-xs text-red-700 dark:text-red-300">
              {add.error?.message ?? 'Ban failed'}
            </div>
          )}
        </div>
        <div className="border-t border-gray-200 dark:border-gray-700 px-5 py-3 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800">
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={!valid || add.isPending}
            className="rounded-md px-3 py-1.5 text-sm border border-red-300 bg-red-600 dark:bg-red-700 text-white hover:bg-red-700 dark:hover:bg-red-600 disabled:opacity-50"
            data-testid="ban-modal-submit"
          >
            {add.isPending ? 'Banning…' : 'Ban'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── F2 — Allowlist card (operator-managed; immune from any ban) ────────

function AllowlistCard() {
  const list = useCrowdsecAllowlist();
  const addMut = useAddCrowdsecAllowlistEntry();
  const removeMut = useRemoveCrowdsecAllowlistEntry();
  const [value, setValue] = useState('');
  const [comment, setComment] = useState('');
  const [scope, setScope] = useState<'Ip' | 'Range'>('Ip');

  const entries = list.data?.data?.entries ?? [];
  const valid = /^[a-fA-F0-9.:/]+$/.test(value) && value.length >= 1 && comment.trim().length >= 3;

  const onAdd = () => {
    if (!valid) return;
    addMut.mutate(
      { value, scope, comment: comment.trim() },
      { onSuccess: () => { setValue(''); setComment(''); } },
    );
  };

  return (
    <div className="rounded-lg border border-emerald-300 dark:border-emerald-700 bg-emerald-50/40 dark:bg-emerald-900/10" data-testid="allowlist-card">
      <div className="px-4 py-3 border-b border-emerald-300 dark:border-emerald-700 text-sm font-medium text-emerald-900 dark:text-emerald-100">
        Allowlist — IPs that are NEVER banned
        <span className="ml-2 text-[11px] font-normal text-emerald-800 dark:text-emerald-200/70">
          Immune from community blocklist, scenario hits, manual bans, and L4 enforcement. Populate before enabling L4 or auto-ban.
        </span>
      </div>
      <div className="px-4 py-3">
        <div className="flex flex-wrap items-end gap-2 mb-3">
          <div className="flex flex-col gap-1">
            <label className="text-[10px] uppercase text-gray-600 dark:text-gray-400">IP / CIDR</label>
            <input
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="203.0.113.42 or 198.51.100.0/24"
              className="w-56 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-sm font-mono"
              data-testid="allowlist-add-value"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[10px] uppercase text-gray-600 dark:text-gray-400">Scope</label>
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value as 'Ip' | 'Range')}
              className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-sm"
              data-testid="allowlist-add-scope"
            >
              <option value="Ip">IP</option>
              <option value="Range">Range (CIDR)</option>
            </select>
          </div>
          <div className="flex flex-col gap-1 flex-1 min-w-[200px]">
            <label className="text-[10px] uppercase text-gray-600 dark:text-gray-400">Reason / description</label>
            <input
              type="text"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="office IP — never ban"
              className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-sm"
              data-testid="allowlist-add-comment"
            />
          </div>
          <button
            type="button"
            onClick={onAdd}
            disabled={!valid || addMut.isPending}
            className="inline-flex items-center gap-1 rounded-md border border-emerald-300 dark:border-emerald-700 bg-emerald-100 dark:bg-emerald-900/30 px-3 py-1.5 text-sm font-medium text-emerald-800 dark:text-emerald-200 hover:bg-emerald-200 dark:hover:bg-emerald-900/40 disabled:opacity-50"
            data-testid="allowlist-add-submit"
          >
            <Plus size={14} /> {addMut.isPending ? 'Adding…' : 'Add to allowlist'}
          </button>
        </div>
        {addMut.isError && (
          <div className="text-xs text-red-600 dark:text-red-400 mb-2">
            Add failed: {addMut.error?.message ?? 'unknown'}
          </div>
        )}
        {removeMut.isError && (
          <div className="text-xs text-red-600 dark:text-red-400 mb-2">
            Remove failed: {removeMut.error?.message ?? 'unknown'}
          </div>
        )}
        {list.isLoading && <div className="text-xs text-gray-500">Loading allowlist…</div>}
        {list.isError && <div className="text-xs text-red-600">Failed to load allowlist</div>}
        {!list.isLoading && entries.length === 0 && (
          <div className="text-xs text-gray-500 italic">Allowlist is empty. Add at least your office / operator IP before enabling L4 enforcement.</div>
        )}
        {entries.length > 0 && (
          <table className="min-w-full text-xs" data-testid="allowlist-table">
            <thead className="text-gray-500 uppercase text-[10px]">
              <tr>
                <th className="px-2 py-1 text-left">Value</th>
                <th className="px-2 py-1 text-left">Scope</th>
                <th className="px-2 py-1 text-left">Comment</th>
                <th className="px-2 py-1 text-left">Added by</th>
                <th className="px-2 py-1"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-emerald-200/40 dark:divide-emerald-900/40">
              {entries.map((e: CrowdsecAllowlistEntry) => (
                <tr key={e.value}>
                  <td className="px-2 py-1 font-mono">{e.value}</td>
                  <td className="px-2 py-1">{e.scope}</td>
                  <td className="px-2 py-1">{e.comment || <span className="text-gray-400">—</span>}</td>
                  <td className="px-2 py-1 font-mono text-[10px]">{e.addedBy || <span className="text-gray-400">—</span>}</td>
                  <td className="px-2 py-1 text-right">
                    <button
                      type="button"
                      onClick={() => removeMut.mutate(e.value)}
                      disabled={removeMut.isPending && removeMut.variables === e.value}
                      className="inline-flex items-center gap-1 text-[11px] text-red-700 dark:text-red-300 hover:underline disabled:opacity-50"
                      data-testid={`allowlist-remove-${e.value}`}
                    >
                      <Trash2 size={11} /> Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ─── F2 — Static blocklist card (operator-managed; 1-year duration) ─────

function StaticBlocklistCard({ onOpenAdd }: { onOpenAdd: () => void }) {
  return (
    <div className="rounded-lg border border-purple-300 dark:border-purple-700 bg-purple-50/40 dark:bg-purple-900/10 p-4" data-testid="static-blocklist-card">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium text-purple-900 dark:text-purple-100">Static blocklist — long-term bans (1 year)</div>
          <div className="text-[11px] text-purple-800 dark:text-purple-200/70 mt-1">
            For known-bad IPs from your own threat intelligence. Static bans appear in the table below with a <code className="text-[10px]">static</code> badge and a <strong>1 year</strong> expiry (re-add manually if still needed).
          </div>
        </div>
        <button
          type="button"
          onClick={onOpenAdd}
          className="inline-flex items-center gap-1 rounded-md border border-purple-300 dark:border-purple-700 bg-purple-100 dark:bg-purple-900/30 px-3 py-1.5 text-sm font-medium text-purple-800 dark:text-purple-200 hover:bg-purple-200 dark:hover:bg-purple-900/40"
          data-testid="static-blocklist-add"
        >
          <Plus size={14} /> Add static ban
        </button>
      </div>
    </div>
  );
}

// ─── F2 — Static-ban add modal ─────────────────────────────────────────

function StaticBanModal({ onClose }: { onClose: () => void }) {
  const [value, setValue] = useState('');
  const [scope, setScope] = useState<'Ip' | 'Range'>('Ip');
  const [reason, setReason] = useState('');
  const mut = useAddCrowdsecStaticBan();
  const valid = /^[a-fA-F0-9.:/]+$/.test(value) && value.length >= 1 && reason.trim().length >= 3;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-lg rounded-lg bg-white dark:bg-gray-900 shadow-xl" data-testid="static-ban-modal">
        <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 px-5 py-3">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Add static ban (1 year)</h3>
          <button type="button" onClick={onClose} className="text-gray-500 hover:text-gray-700">✕</button>
        </div>
        <div className="px-5 py-4 space-y-3 text-sm">
          <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-700 p-2 text-xs text-amber-800 dark:text-amber-200">
            Static bans last <strong>1 year</strong>. The operator must re-add manually after expiry. For shorter bans use the regular &ldquo;Add manual ban&rdquo; flow.
          </div>
          <div>
            <label className="block text-xs uppercase text-gray-600 dark:text-gray-400 mb-1">IP / CIDR</label>
            <input
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm font-mono"
              data-testid="static-ban-modal-value"
            />
          </div>
          <div>
            <label className="block text-xs uppercase text-gray-600 dark:text-gray-400 mb-1">Scope</label>
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value as 'Ip' | 'Range')}
              className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
              data-testid="static-ban-modal-scope"
            >
              <option value="Ip">IP</option>
              <option value="Range">Range (CIDR)</option>
            </select>
          </div>
          <div>
            <label className="block text-xs uppercase text-gray-600 dark:text-gray-400 mb-1">Reason</label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
              data-testid="static-ban-modal-reason"
            />
          </div>
          {mut.isError && (
            <div className="rounded-md border border-red-300 bg-red-50 dark:bg-red-900/20 dark:border-red-700 p-2 text-xs text-red-700 dark:text-red-300">
              {mut.error?.message ?? 'Ban failed'}
            </div>
          )}
        </div>
        <div className="border-t border-gray-200 dark:border-gray-700 px-5 py-3 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => mut.mutate({ value, scope, reason: reason.trim() }, { onSuccess: () => onClose() })}
            disabled={!valid || mut.isPending}
            className="rounded-md px-3 py-1.5 text-sm border border-purple-300 bg-purple-600 dark:bg-purple-700 text-white hover:bg-purple-700 dark:hover:bg-purple-600 disabled:opacity-50"
            data-testid="static-ban-modal-submit"
          >
            {mut.isPending ? 'Adding…' : 'Add static ban'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── F4 — WAF rule exclusion tab + Whitelist modal ───────────────────────

interface WhitelistPrefill {
  readonly ruleId: string;
  readonly hostnameRegex: string;
  readonly reason: string;
}

function WhitelistRuleModal({ prefill, onClose }: { prefill: WhitelistPrefill; onClose: () => void }) {
  const [ruleId, setRuleId] = useState(prefill.ruleId);
  const [hostnameRegex, setHostnameRegex] = useState(prefill.hostnameRegex);
  const [scope, setScope] = useState<WafRuleExclusionScope>('args_names_only');
  const [reason, setReason] = useState(prefill.reason);
  const [err, setErr] = useState<string | null>(null);
  const mut = useCreateWafRuleExclusion();

  // Mirror the backend's .refine(regexParseable) so the Submit button
  // doesn't pretend to be enabled for input the backend will reject —
  // a 400 round-trip would otherwise feel like a silent save-fail even
  // though the error banner does eventually surface it.
  const isParseableRegex = (value: string): boolean => {
    try {
      new RegExp(value);
      return true;
    } catch {
      return false;
    }
  };
  const hostnameRegexTrimmed = hostnameRegex.trim();
  const valid =
    /^[0-9]+$/.test(ruleId.trim())
    && hostnameRegexTrimmed.length > 0
    && !hostnameRegexTrimmed.includes('"')
    && !hostnameRegexTrimmed.endsWith('\\')
    && isParseableRegex(hostnameRegexTrimmed)
    && reason.trim().length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-lg rounded-lg bg-white dark:bg-gray-800 p-5 shadow-xl">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">Whitelist WAF rule for host</h3>
        <p className="text-xs text-gray-600 dark:text-gray-400 mb-4">
          Adds a CRS exclusion that scopes <code>{scope === 'full_disable' ? 'ctl:ruleRemoveById' : 'ctl:ruleRemoveTargetById … ARGS_NAMES'}</code> to
          requests whose <code>X-Forwarded-Host</code> matches the regex below. Takes
          effect within ~10s of save (modsec-crs pods roll). Real attacks on
          ARG values and headers still fire when <em>args_names_only</em> is used.
        </p>
        <div className="space-y-3 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-gray-700 dark:text-gray-200">Rule ID</span>
            <input
              value={ruleId}
              onChange={(e) => setRuleId(e.target.value)}
              className="rounded-md border border-gray-300 dark:border-gray-600 dark:bg-gray-900 px-2 py-1 text-sm font-mono"
              data-testid="whitelist-modal-rule-id"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-gray-700 dark:text-gray-200">Host regex (matches X-Forwarded-Host)</span>
            <input
              value={hostnameRegex}
              onChange={(e) => setHostnameRegex(e.target.value)}
              className="rounded-md border border-gray-300 dark:border-gray-600 dark:bg-gray-900 px-2 py-1 text-sm font-mono"
              data-testid="whitelist-modal-host-regex"
            />
            <span className="text-[10px] text-gray-500">Anchor with ^…$ to avoid over-broad matches. No double-quotes.</span>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-gray-700 dark:text-gray-200">Scope</span>
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value as WafRuleExclusionScope)}
              className="rounded-md border border-gray-300 dark:border-gray-600 dark:bg-gray-900 px-2 py-1 text-sm"
              data-testid="whitelist-modal-scope"
            >
              <option value="args_names_only">args_names_only — keep ARG values + headers scanned (recommended)</option>
              <option value="full_disable">full_disable — disable the rule for matching hosts</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-gray-700 dark:text-gray-200">Reason (audit trail)</span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              className="rounded-md border border-gray-300 dark:border-gray-600 dark:bg-gray-900 px-2 py-1 text-sm"
              data-testid="whitelist-modal-reason"
            />
          </label>
        </div>
        {err && (
          <div className="mt-3 rounded-md border border-red-300 bg-red-50 dark:bg-red-900/20 dark:border-red-700 px-3 py-2 text-xs text-red-700 dark:text-red-200">
            {err}
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              setErr(null);
              mut.mutate(
                {
                  ruleId: ruleId.trim(),
                  hostnameRegex: hostnameRegex.trim(),
                  scope,
                  reason: reason.trim(),
                },
                {
                  onSuccess: () => onClose(),
                  onError: (e) => setErr(e instanceof Error ? e.message : String(e)),
                },
              );
            }}
            disabled={!valid || mut.isPending}
            className="rounded-md px-3 py-1.5 text-sm border border-emerald-300 bg-emerald-600 dark:bg-emerald-700 text-white hover:bg-emerald-700 dark:hover:bg-emerald-600 disabled:opacity-50"
            data-testid="whitelist-modal-submit"
          >
            {mut.isPending ? 'Saving…' : 'Add exclusion'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function WafExclusionsTab() {
  const [includeDisabled, setIncludeDisabled] = useState(false);
  const { data, isLoading, isError, error, refetch, isFetching } = useWafRuleExclusions({ includeDisabled });
  const exclusions: ReadonlyArray<WafRuleExclusion> = data?.data?.exclusions ?? [];
  const update = useUpdateWafRuleExclusion();
  const del = useDeleteWafRuleExclusion();

  return (
    <section className="space-y-4" data-testid="waf-exclusions-tab">
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 text-sm text-gray-700 dark:text-gray-200">
        DB-backed CRS rule exclusions. Operators add entries from the
        <strong> WAF Events tab</strong> (Whitelist button on each event row).
        The backend renders the enabled rows into the
        <code className="text-xs mx-1">modsec-crs-exclusions-dynamic</code>
        ConfigMap and rolls the <code className="text-xs">modsec-crs</code>
        Deployment. Companion to the static, repo-versioned exclusions in
        <code className="text-xs mx-1">k8s/base/modsecurity-crs/exclusion-rules-configmap.yaml</code>.
      </div>

      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-200">
          <input
            type="checkbox"
            checked={includeDisabled}
            onChange={(e) => setIncludeDisabled(e.target.checked)}
            data-testid="exclusions-include-disabled"
          />
          Include disabled
        </label>
        <button
          type="button"
          onClick={() => { void refetch(); }}
          disabled={isFetching}
          className="inline-flex items-center gap-1 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
          data-testid="exclusions-refresh"
        >
          <RefreshCw size={12} className={isFetching ? 'animate-spin' : ''} /> Reload
        </button>
      </div>

      {isLoading && <SkeletonLoader />}
      {isError && (
        <div className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-900/20 dark:border-red-700 p-4 text-sm text-red-700 dark:text-red-300">
          Failed to load exclusions: {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      {!isLoading && !isError && (
        <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700 text-sm">
            <thead className="bg-gray-50 dark:bg-gray-900 text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
              <tr>
                <th className="px-4 py-2 text-left">Rule</th>
                <th className="px-4 py-2 text-left">Host regex (X-Forwarded-Host)</th>
                <th className="px-4 py-2 text-left">Scope</th>
                <th className="px-4 py-2 text-left">Reason</th>
                <th className="px-4 py-2 text-left">By / when</th>
                <th className="px-4 py-2 text-left">Status</th>
                <th className="px-4 py-2 text-left">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {exclusions.map((x) => (
                <tr key={x.id} data-testid={`exclusion-row-${x.id}`}>
                  <td className="px-4 py-2 font-mono text-xs text-gray-900 dark:text-gray-100">{x.ruleId}</td>
                  <td className="px-4 py-2 font-mono text-[11px] text-gray-700 dark:text-gray-200 break-all">{x.hostnameRegex}</td>
                  <td className="px-4 py-2 text-xs text-gray-700 dark:text-gray-200">
                    {x.scope === 'full_disable' ? (
                      <span className="rounded bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-200 px-2 py-0.5 text-[10px] uppercase">full disable</span>
                    ) : (
                      <span className="rounded bg-gray-100 dark:bg-gray-700/40 text-gray-700 dark:text-gray-200 px-2 py-0.5 text-[10px] uppercase">args_names</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-700 dark:text-gray-200 max-w-[280px]">{x.reason}</td>
                  <td className="px-4 py-2 text-[11px] text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    {x.createdBy}<br />
                    {new Date(x.createdAt).toISOString().replace('T', ' ').slice(0, 16)}
                  </td>
                  <td className="px-4 py-2 text-xs">
                    {x.disabled ? (
                      <span className="rounded bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300 px-2 py-0.5 text-[10px]">disabled</span>
                    ) : (
                      <span className="rounded bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-200 px-2 py-0.5 text-[10px]">active</span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex flex-col gap-1 sm:flex-row sm:items-center">
                      <button
                        type="button"
                        onClick={() => update.mutate({ id: x.id, patch: { disabled: !x.disabled } })}
                        disabled={update.isPending}
                        className="inline-flex items-center gap-1 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-0.5 text-[11px] font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
                        data-testid={`exclusion-toggle-${x.id}`}
                      >
                        {x.disabled ? 'Enable' : 'Disable'}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (window.confirm(`Delete exclusion for rule ${x.ruleId} on ${x.hostnameRegex}?`)) {
                            del.mutate(x.id);
                          }
                        }}
                        disabled={del.isPending}
                        className="inline-flex items-center gap-1 rounded-md border border-red-300 bg-red-50 dark:bg-red-900/20 dark:border-red-700 px-2 py-0.5 text-[11px] font-medium text-red-700 dark:text-red-200 hover:bg-red-100 dark:hover:bg-red-900/40 disabled:opacity-50"
                        data-testid={`exclusion-delete-${x.id}`}
                      >
                        <Trash2 size={11} /> Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {exclusions.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-sm text-gray-500">
                    No exclusions configured. Use the <strong>Whitelist</strong> button on
                    rows in the <em>WAF Events</em> tab to add surgical exclusions.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ─── F5 — CrowdSec Console enrollment card ────────────────────────────

function CrowdsecConsoleCard() {
  const status = useCrowdsecConsoleStatus();
  const enroll = useEnrollCrowdsecConsole();
  const disenroll = useDisenrollCrowdsecConsole();
  const patchMeta = usePatchCrowdsecConsoleMeta();
  const [enrollKey, setEnrollKey] = useState('');
  const [enrollName, setEnrollName] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const s = status.data?.data;
  // Hidden entirely when meta-flag is disabled (airgapped operators
  // can still flip it back from a direct DB write; the toggle UI
  // appears even when meta-disabled so they can re-enable).
  if (status.isLoading) return null;

  const keyValid =
    enrollKey.trim().length >= 16
    && enrollKey.trim().length <= 128
    && /^[A-Za-z0-9_-]+$/.test(enrollKey.trim());

  return (
    <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50/30 dark:bg-blue-900/10 p-4 space-y-3" data-testid="crowdsec-console-card">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <h4 className="text-sm font-semibold text-gray-900 dark:text-white">
            CrowdSec Console <span className="ml-2 text-[10px] uppercase rounded px-1.5 py-0.5 bg-blue-200/60 dark:bg-blue-800/40 text-blue-800 dark:text-blue-200">opt-in</span>
          </h4>
          <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
            Optional enrollment with <code className="text-[11px]">app.crowdsec.net</code> for the
            cross-cluster dashboard, premium Console blocklists, and alert push notifications.
            Airgapped operators can hide this surface entirely via the meta toggle below.
          </p>
        </div>
        <div>
          {s?.enrolled && (
            <span className="rounded bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-200 px-2 py-0.5 text-[10px] uppercase">enrolled</span>
          )}
          {s && !s.enrolled && s.metaEnabled && (
            <span className="rounded bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 px-2 py-0.5 text-[10px] uppercase">not enrolled</span>
          )}
          {s && !s.metaEnabled && (
            <span className="rounded bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 px-2 py-0.5 text-[10px] uppercase">meta disabled</span>
          )}
        </div>
      </div>

      {s?.metaEnabled && !s.enrolled && (
        <div className="space-y-2">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-gray-700 dark:text-gray-200">Enroll key (from <code>app.crowdsec.net → Add Machine</code>)</span>
            <input
              value={enrollKey}
              onChange={(e) => setEnrollKey(e.target.value)}
              className="rounded-md border border-gray-300 dark:border-gray-600 dark:bg-gray-900 px-2 py-1 font-mono text-[11px]"
              data-testid="console-enroll-key"
              placeholder="lh7tjjpa2lmd6ku5osmd5l3dkyahw7n4dq7ovwbmhx8mtfvz"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-gray-700 dark:text-gray-200">Machine name (optional)</span>
            <input
              value={enrollName}
              onChange={(e) => setEnrollName(e.target.value)}
              className="rounded-md border border-gray-300 dark:border-gray-600 dark:bg-gray-900 px-2 py-1 text-xs"
              data-testid="console-enroll-name"
              placeholder="my-platform-staging"
            />
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} data-testid="console-enroll-overwrite" />
            Overwrite existing enrollment (use only if previously enrolled)
          </label>
          {err && <div className="rounded-md border border-red-300 bg-red-50 dark:bg-red-900/20 dark:border-red-700 px-3 py-2 text-xs text-red-700 dark:text-red-200">{err}</div>}
          <button
            type="button"
            onClick={() => {
              setErr(null);
              enroll.mutate(
                { enrollKey: enrollKey.trim(), name: enrollName.trim() || undefined, overwrite: overwrite || undefined },
                {
                  onSuccess: () => { setEnrollKey(''); setEnrollName(''); setOverwrite(false); },
                  onError: (e) => setErr(e instanceof Error ? e.message : String(e)),
                },
              );
            }}
            disabled={!keyValid || enroll.isPending}
            className="rounded-md px-3 py-1.5 text-xs border border-blue-300 bg-blue-600 dark:bg-blue-700 text-white hover:bg-blue-700 dark:hover:bg-blue-600 disabled:opacity-50"
            data-testid="console-enroll-submit"
          >
            {enroll.isPending ? 'Enrolling…' : 'Enroll with CrowdSec Console'}
          </button>
        </div>
      )}

      {s?.enrolled && (
        <div className="space-y-2 text-xs text-gray-700 dark:text-gray-200">
          {s.consoleUrl && (
            <div>
              Console URL: <a href={s.consoleUrl} target="_blank" rel="noreferrer" className="text-blue-600 dark:text-blue-300 hover:underline">{s.consoleUrl}</a>
            </div>
          )}
          {s.features.length > 0 && (
            <div>
              Features:{' '}
              {s.features.map((f) => (
                <span key={f.name} className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] mr-1 ${f.enabled ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-200' : 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300'}`}>
                  {f.name}
                </span>
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={() => {
              if (window.confirm('Disenroll from CrowdSec Console? The platform LAPI stops pushing alerts upstream.')) {
                disenroll.mutate();
              }
            }}
            disabled={disenroll.isPending}
            className="rounded-md px-3 py-1.5 text-xs border border-red-300 bg-red-50 dark:bg-red-900/20 dark:border-red-700 text-red-700 dark:text-red-200 hover:bg-red-100 dark:hover:bg-red-900/40 disabled:opacity-50"
            data-testid="console-disenroll"
          >
            {disenroll.isPending ? 'Disenrolling…' : 'Disenroll'}
          </button>
        </div>
      )}

      <div className="pt-2 border-t border-blue-200 dark:border-blue-800 flex items-center justify-between text-[11px] text-gray-600 dark:text-gray-400">
        <span>
          Meta flag (airgapped operators):{' '}
          <code className="text-[10px]">platform_settings.security.crowdsec.console_visible</code>
        </span>
        <button
          type="button"
          onClick={() => {
            if (s && window.confirm(`${s.metaEnabled ? 'Hide' : 'Show'} the CrowdSec Console card?`)) {
              patchMeta.mutate({ visible: !s.metaEnabled });
            }
          }}
          disabled={patchMeta.isPending || !s}
          className="rounded-md px-2 py-0.5 text-[10px] border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
          data-testid="console-meta-toggle"
        >
          {s?.metaEnabled ? 'Hide surface' : 'Re-enable surface'}
        </button>
      </div>
    </div>
  );
}

// ─── F3 UI — Auto-ban config + recent runs + calibration card ─────────

function CrowdsecAutobanCard() {
  const cfg = useCrowdsecAutobanConfig();
  const runs = useCrowdsecAutobanRuns(50);
  const patch = usePatchCrowdsecAutobanConfig();
  const calibrate = useCalibrateAutoban();

  const live = cfg.data?.data;
  // Local draft so the operator can adjust multiple fields and Save once.
  const [draft, setDraft] = useState<CrowdsecAutobanConfig | null>(null);
  useEffect(() => {
    if (live && draft === null) setDraft(live);
  }, [live, draft]);

  const [calibHours, setCalibHours] = useState(24);
  const [calibResult, setCalibResult] = useState<CrowdsecAutobanCalibrationResponse | null>(null);
  const [calibError, setCalibError] = useState<string | null>(null);

  if (cfg.isLoading || !draft) {
    return (
      <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50/30 dark:bg-amber-900/10 p-4">
        <SkeletonLoader />
      </div>
    );
  }

  const dirty =
    live !== undefined
    && (live.enabled !== draft.enabled
      || live.windowSeconds !== draft.windowSeconds
      || live.eventThreshold !== draft.eventThreshold
      || live.minSeverity !== draft.minSeverity
      || live.initialBanDuration !== draft.initialBanDuration
      || live.repeatBackoffMultiplier !== draft.repeatBackoffMultiplier
      || live.maxBanDuration !== draft.maxBanDuration
      || live.excludedRuleIds.join(',') !== draft.excludedRuleIds.join(',')
      || live.includeTenantRoutes !== draft.includeTenantRoutes);

  const onSave = () => {
    if (!live) return;
    const patchBody: Partial<CrowdsecAutobanConfig> = {};
    (Object.keys(draft) as Array<keyof CrowdsecAutobanConfig>).forEach((k) => {
      if (JSON.stringify((draft as Record<string, unknown>)[k]) !== JSON.stringify((live as Record<string, unknown>)[k])) {
        (patchBody as Record<string, unknown>)[k] = draft[k];
      }
    });
    patch.mutate(patchBody as never);
  };

  const onCalibrate = () => {
    setCalibError(null);
    setCalibResult(null);
    calibrate.mutate(
      { hours: calibHours, override: draft },
      {
        onSuccess: (r) => setCalibResult(r.data),
        onError: (e) => setCalibError(e instanceof Error ? e.message : String(e)),
      },
    );
  };

  return (
    <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50/30 dark:bg-amber-900/10 p-4 space-y-4" data-testid="crowdsec-autoban-card">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <h4 className="text-sm font-semibold text-gray-900 dark:text-white">
            WAF Auto-Ban <span className="ml-2 text-[10px] uppercase rounded px-1.5 py-0.5 bg-amber-200/60 dark:bg-amber-800/40 text-amber-800 dark:text-amber-200">opt-in</span>
          </h4>
          <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
            Auto-bans source IPs that trip enough WAF rules in the rolling
            window. <strong>Use the Calibrate button below to preview what
            enabling would do</strong> against your real WAF traffic before
            flipping the toggle.
          </p>
        </div>
        <div>
          {draft.enabled ? (
            <span className="rounded bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-200 px-2 py-0.5 text-[10px] uppercase">enabled</span>
          ) : (
            <span className="rounded bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 px-2 py-0.5 text-[10px] uppercase">disabled</span>
          )}
        </div>
      </div>

      {/* Config form */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
        <label className="flex items-center gap-2 col-span-1 sm:col-span-2">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
            data-testid="autoban-enabled"
          />
          <span className="text-gray-700 dark:text-gray-200 font-medium">Enable auto-ban scheduler</span>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-gray-700 dark:text-gray-200">Window (seconds, 60–3600)</span>
          <input
            type="number" min={60} max={3600}
            value={draft.windowSeconds}
            onChange={(e) => setDraft({ ...draft, windowSeconds: Number(e.target.value) || 0 })}
            className="rounded-md border border-gray-300 dark:border-gray-600 dark:bg-gray-900 px-2 py-1"
            data-testid="autoban-window"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-gray-700 dark:text-gray-200">Event threshold (2–100)</span>
          <input
            type="number" min={2} max={100}
            value={draft.eventThreshold}
            onChange={(e) => setDraft({ ...draft, eventThreshold: Number(e.target.value) || 0 })}
            className="rounded-md border border-gray-300 dark:border-gray-600 dark:bg-gray-900 px-2 py-1"
            data-testid="autoban-threshold"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-gray-700 dark:text-gray-200">Min severity</span>
          <select
            value={draft.minSeverity}
            onChange={(e) => setDraft({ ...draft, minSeverity: e.target.value as 'warning' | 'critical' })}
            className="rounded-md border border-gray-300 dark:border-gray-600 dark:bg-gray-900 px-2 py-1"
            data-testid="autoban-severity"
          >
            <option value="critical">critical (only critical events trigger)</option>
            <option value="warning">warning (warning + critical)</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-gray-700 dark:text-gray-200">Initial ban duration</span>
          <input
            value={draft.initialBanDuration}
            onChange={(e) => setDraft({ ...draft, initialBanDuration: e.target.value })}
            placeholder="1h"
            className="rounded-md border border-gray-300 dark:border-gray-600 dark:bg-gray-900 px-2 py-1 font-mono"
            data-testid="autoban-initial-duration"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-gray-700 dark:text-gray-200">Repeat-offender multiplier (1–10)</span>
          <input
            type="number" step={0.5} min={1} max={10}
            value={draft.repeatBackoffMultiplier}
            onChange={(e) => setDraft({ ...draft, repeatBackoffMultiplier: Number(e.target.value) || 1 })}
            className="rounded-md border border-gray-300 dark:border-gray-600 dark:bg-gray-900 px-2 py-1"
            data-testid="autoban-backoff"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-gray-700 dark:text-gray-200">Max ban duration cap</span>
          <input
            value={draft.maxBanDuration}
            onChange={(e) => setDraft({ ...draft, maxBanDuration: e.target.value })}
            placeholder="7d"
            className="rounded-md border border-gray-300 dark:border-gray-600 dark:bg-gray-900 px-2 py-1 font-mono"
            data-testid="autoban-max-duration"
          />
        </label>
        <label className="flex flex-col gap-1 sm:col-span-2">
          <span className="text-gray-700 dark:text-gray-200">Excluded CRS rule IDs (comma-separated, digits only)</span>
          <input
            value={draft.excludedRuleIds.join(',')}
            onChange={(e) => setDraft({
              ...draft,
              excludedRuleIds: e.target.value.split(',').map((s) => s.trim()).filter((s) => /^[0-9]+$/.test(s)),
            })}
            placeholder="949110,913100"
            className="rounded-md border border-gray-300 dark:border-gray-600 dark:bg-gray-900 px-2 py-1 font-mono"
            data-testid="autoban-excluded"
          />
          <span className="text-[10px] text-gray-500">Meta-score rules (949110, 913100) are excluded by default — they accumulate scores and lead to mass false-positive bans if included.</span>
        </label>
        <label className="flex items-center gap-2 col-span-1 sm:col-span-2">
          <input
            type="checkbox"
            checked={draft.includeTenantRoutes}
            onChange={(e) => setDraft({ ...draft, includeTenantRoutes: e.target.checked })}
            data-testid="autoban-tenant-routes"
          />
          <span className="text-gray-700 dark:text-gray-200">
            Include tenant routes <span className="text-gray-500">(default off — a tenant&apos;s own customer base shouldn&apos;t be auto-banned for tripping WAF on the tenant&apos;s site)</span>
          </span>
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-amber-200 dark:border-amber-800">
        <button
          type="button"
          onClick={onSave}
          disabled={!dirty || patch.isPending}
          className="rounded-md px-3 py-1.5 text-xs border border-amber-300 bg-amber-600 dark:bg-amber-700 text-white hover:bg-amber-700 dark:hover:bg-amber-600 disabled:opacity-50"
          data-testid="autoban-save"
        >
          {patch.isPending ? 'Saving…' : dirty ? 'Save config' : 'Saved'}
        </button>
        {dirty && live && (
          <button
            type="button"
            onClick={() => setDraft(live)}
            disabled={patch.isPending}
            className="rounded-md px-3 py-1.5 text-xs border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
          >
            Discard changes
          </button>
        )}
        <span className="grow" />
        <label className="text-[11px] text-gray-700 dark:text-gray-200">
          Calibrate against last
          <input
            type="number"
            min={1}
            max={168}
            value={calibHours}
            onChange={(e) => setCalibHours(Math.max(1, Math.min(168, Number(e.target.value) || 24)))}
            className="ml-1 w-14 rounded-md border border-gray-300 dark:border-gray-600 dark:bg-gray-900 px-1 py-0.5 text-xs"
            data-testid="autoban-calib-hours"
          />
          h of waf_logs
        </label>
        <button
          type="button"
          onClick={onCalibrate}
          disabled={calibrate.isPending}
          className="rounded-md px-3 py-1.5 text-xs border border-blue-300 bg-blue-600 dark:bg-blue-700 text-white hover:bg-blue-700 dark:hover:bg-blue-600 disabled:opacity-50"
          data-testid="autoban-calibrate"
        >
          {calibrate.isPending ? 'Calibrating…' : 'Calibrate (dry-run)'}
        </button>
      </div>

      {calibError && (
        <div className="rounded-md border border-red-300 bg-red-50 dark:bg-red-900/20 dark:border-red-700 px-3 py-2 text-xs text-red-700 dark:text-red-200">
          {calibError}
        </div>
      )}

      {calibResult && (
        <div className="rounded-md border border-blue-200 dark:border-blue-800 bg-blue-50/40 dark:bg-blue-900/10 p-3 space-y-2">
          <div className="text-xs font-semibold text-blue-900 dark:text-blue-200">
            Dry-run result — replayed {calibResult.totalEventsConsidered.toLocaleString()} events
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <CalibStat label="Hypothetical bans" value={calibResult.hypotheticalBans.toLocaleString()} />
            <CalibStat label="Distinct IPs" value={calibResult.distinctSourceIpsAboveThreshold.toLocaleString()} />
            <CalibStat label="Window" value={`${calibResult.windowSeconds}s`} />
            <CalibStat label="Top rules" value={String(calibResult.topRulesInBatch.length)} />
          </div>
          {calibResult.topRulesInBatch.length > 0 && (
            <div className="text-[11px]">
              <div className="text-blue-900 dark:text-blue-200 mt-1 mb-1 font-medium">Top rules driving bans:</div>
              <table className="min-w-full text-[11px]">
                <thead className="text-gray-500 dark:text-gray-400">
                  <tr><th className="text-left pr-3">Rule</th><th className="text-left pr-3">Distinct IPs</th><th className="text-left">Events</th></tr>
                </thead>
                <tbody>
                  {calibResult.topRulesInBatch.map((r) => (
                    <tr key={r.ruleId}>
                      <td className="font-mono pr-3">{r.ruleId}</td>
                      <td className="pr-3">{r.distinctIps}</td>
                      <td>{r.eventCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!draft.enabled && (
            <div className="text-[11px] text-blue-700 dark:text-blue-300 italic">
              Auto-ban is currently disabled — these numbers are what WOULD have happened.
            </div>
          )}
        </div>
      )}

      {/* Recent runs table */}
      <div>
        <div className="text-xs font-semibold text-gray-800 dark:text-gray-200 mb-1">
          Recent decisions (last 50)
        </div>
        {runs.isLoading && <SkeletonLoader />}
        {runs.isError && (
          <div className="text-xs text-red-700 dark:text-red-300">Failed to load runs.</div>
        )}
        {runs.data?.data.runs && runs.data.data.runs.length === 0 && (
          <div className="text-xs text-gray-500 italic">
            No decisions yet. The scheduler runs every 60s; enable it above to start auto-banning.
          </div>
        )}
        {runs.data?.data.runs && runs.data.data.runs.length > 0 && (
          <div className="overflow-x-auto rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
            <table className="min-w-full text-[11px]">
              <thead className="bg-gray-50 dark:bg-gray-900 text-gray-500 dark:text-gray-400 uppercase">
                <tr>
                  <th className="text-left px-3 py-1">When</th>
                  <th className="text-left px-3 py-1">Source IP</th>
                  <th className="text-left px-3 py-1">Host</th>
                  <th className="text-left px-3 py-1">Rules</th>
                  <th className="text-left px-3 py-1">Events</th>
                  <th className="text-left px-3 py-1">Outcome</th>
                  <th className="text-left px-3 py-1">Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {runs.data.data.runs.map((r) => (
                  <AutobanRunRow key={r.id} r={r} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function CalibStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-blue-200 dark:border-blue-800 bg-white dark:bg-gray-800 p-2">
      <div className="text-[10px] uppercase text-gray-500 dark:text-gray-400">{label}</div>
      <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">{value}</div>
    </div>
  );
}

function AutobanRunRow({ r }: { r: CrowdsecAutobanRun }) {
  const outcomeTone: Record<CrowdsecAutobanOutcome, string> = {
    banned: 'bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-200',
    skipped_allowlisted: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-200',
    skipped_excluded_rule: 'bg-gray-100 dark:bg-gray-700/40 text-gray-700 dark:text-gray-300',
    skipped_already_banned: 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200',
    skipped_below_threshold: 'bg-gray-100 dark:bg-gray-700/40 text-gray-600 dark:text-gray-400',
    failed: 'bg-red-200 dark:bg-red-900/60 text-red-900 dark:text-red-100',
  };
  return (
    <tr>
      <td className="px-3 py-1 font-mono text-[10px] text-gray-600 dark:text-gray-400 whitespace-nowrap">
        {new Date(r.triggeredAt).toISOString().replace('T', ' ').slice(0, 19)}
      </td>
      <td className="px-3 py-1 font-mono">{r.sourceIp}</td>
      <td className="px-3 py-1 text-gray-700 dark:text-gray-300">{r.hostname ?? '—'}</td>
      <td className="px-3 py-1 font-mono text-gray-700 dark:text-gray-300">{r.ruleIds.slice(0, 3).join(', ')}{r.ruleIds.length > 3 ? ` +${r.ruleIds.length - 3}` : ''}</td>
      <td className="px-3 py-1">{r.eventCount}</td>
      <td className="px-3 py-1">
        <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] uppercase ${outcomeTone[r.outcome]}`}>
          {r.outcome.replace('skipped_', '')}
        </span>
        {r.outcome === 'banned' && r.banDuration && (
          <span className="ml-1 text-[10px] text-gray-500">{r.banDuration}</span>
        )}
      </td>
      <td className="px-3 py-1 text-gray-500 dark:text-gray-400 text-[10px] truncate max-w-[200px]">{r.outcomeDetail ?? ''}</td>
    </tr>
  );
}

// ─── F1+F6 — CrowdSec L4 enforcement card ────────────────────────────

export function CrowdsecL4Card() {
  const status = useCrowdsecL4Status();
  const patch = usePatchCrowdsecL4Mode();
  const [err, setErr] = useState<string | null>(null);
  const s = status.data?.data;

  const onChangeMode = (newMode: CrowdsecL4Mode) => {
    if (!s) return;
    if (newMode === s.mode) return;
    if (newMode === 'enforce' && !s.operatorIpTrusted) {
      setErr(`Refusing to flip to enforce — your detected IP (${s.operatorIp ?? 'unknown'}) is not in any ClusterTrustedRange or cluster peer set. Add a ClusterTrustedRange covering your source IP before enabling enforce.`);
      return;
    }
    if (newMode === 'enforce') {
      const confirmMsg = `Enabling L4 enforce will write banned IPs into the host firewall on every node.\n\nYour IP: ${s.operatorIp} (TRUSTED — exclusion guard active)\n\nProceed?`;
      if (!window.confirm(confirmMsg)) return;
    }
    setErr(null);
    patch.mutate(
      { mode: newMode },
      {
        onError: (e) => setErr(e instanceof Error ? e.message : String(e)),
      },
    );
  };

  if (status.isLoading || !s) {
    return (
      <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50/30 dark:bg-red-900/10 p-4">
        <SkeletonLoader />
      </div>
    );
  }

  const trustsKnown = s.trustedRangeCount + s.clusterPeerCount;

  return (
    <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50/30 dark:bg-red-900/10 p-4 space-y-3" data-testid="crowdsec-l4-card">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <h4 className="text-sm font-semibold text-gray-900 dark:text-white">
            L4 (Host Firewall) Enforcement
            <span className="ml-2 text-[10px] uppercase rounded px-1.5 py-0.5 bg-red-200/60 dark:bg-red-800/40 text-red-800 dark:text-red-200">opt-in · highest risk</span>
          </h4>
          <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
            Pushes CrowdSec decisions into the host nftables firewall as
            interval+timeout set elements. Banned IPs are dropped at L4
            <strong> before reaching Traefik</strong> — stops attack
            traffic at the kernel boundary. <em>This is the
            highest-risk feature in the platform</em>: a misconfigured
            scenario or poisoned community list can drop legitimate
            traffic, including operator SSH.
          </p>
        </div>
        <ModeBadge mode={s.mode} />
      </div>

      {/* Status panel */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <L4Stat label="Pods rolled" value={`${s.appliedPods} / ${s.totalPods}`} tone="info" />
        <L4Stat label="Trusted ranges" value={String(s.trustedRangeCount)} tone={s.trustedRangeCount > 0 ? 'ok' : 'warn'} />
        <L4Stat label="Cluster peers" value={String(s.clusterPeerCount)} tone={s.clusterPeerCount > 0 ? 'ok' : 'warn'} />
        <L4Stat
          label="Your IP"
          value={s.operatorIp ?? 'unknown'}
          tone={s.operatorIpTrusted ? 'ok' : 'warn'}
        />
      </div>

      {/* Mode toggle */}
      <div className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3 space-y-2">
        <div className="text-xs font-semibold text-gray-800 dark:text-gray-200">Mode</div>
        <div className="flex flex-wrap gap-2">
          {(['disabled', 'dryrun', 'enforce'] as const).map((m) => {
            const active = s.mode === m;
            const dangerous = m === 'enforce';
            const wouldLockOut = dangerous && !s.operatorIpTrusted;
            return (
              <button
                key={m}
                type="button"
                onClick={() => onChangeMode(m)}
                disabled={patch.isPending || wouldLockOut || active}
                title={wouldLockOut ? `Would lock you out — your IP ${s.operatorIp ?? '(unknown)'} isn't trusted` : ''}
                className={[
                  'rounded-md px-3 py-1.5 text-xs font-medium border',
                  active
                    ? 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 border-gray-300 dark:border-gray-600 cursor-default'
                    : dangerous
                    ? wouldLockOut
                      ? 'border-red-300 bg-red-100 dark:bg-red-900/30 dark:border-red-700 text-red-600 dark:text-red-300 opacity-50 cursor-not-allowed'
                      : 'border-red-300 bg-red-600 dark:bg-red-700 text-white hover:bg-red-700 dark:hover:bg-red-600'
                    : 'border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700',
                ].join(' ')}
                data-testid={`l4-mode-${m}`}
              >
                {m}
              </button>
            );
          })}
        </div>
        <div className="text-[11px] text-gray-500 dark:text-gray-400 space-y-1">
          <div><strong>disabled:</strong> reconciler dormant, zero kernel writes (default).</div>
          <div><strong>dryrun:</strong> reads LAPI + computes exclusions + logs what would apply. No kernel writes.</div>
          <div><strong>enforce:</strong> writes nft sets. <span className="text-red-700 dark:text-red-300 font-medium">Refused if your IP is not in trusted_ranges or cluster_peers.</span></div>
        </div>
      </div>

      {/* Lockout warning */}
      {!s.operatorIpTrusted && (
        <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-700 px-3 py-2 text-xs text-amber-800 dark:text-amber-200 space-y-2">
          <div>
            <strong>Lockout protection active:</strong> Your detected IP
            <code className="mx-1">{s.operatorIp ?? '(unknown)'}</code>
            <span className="opacity-70">(via <code>{s.operatorIpSource}</code>)</span>
            {' '}is NOT in any trust source. Flipping to enforce is
            disabled until you add a <code>ClusterTrustedRange</code>
            covering your source IP. {trustsKnown === 0 && (
              <span>The cluster currently has <strong>zero</strong> trust sources — any operator would be locked out.</span>
            )}
          </div>
          {/* The req-ip+pod-CIDR pattern is the Traefik-not-forwarding
              failure mode. Direct the operator to the underlying header
              config rather than to ClusterTrustedRange, because adding
              the pod IP as trusted would let ANY internal pod bypass. */}
          {s.operatorIpSource === 'req-ip' && s.operatorIp != null && /^10\.42\./.test(s.operatorIp) && (
            <div className="rounded border border-amber-400 bg-amber-100 dark:bg-amber-900/40 px-2 py-1.5 text-[11px]">
              <strong>Looks like an in-cluster pod IP.</strong> Your real
              source IP isn't being forwarded by Traefik —
              <code className="mx-1">X-Real-IP</code> and
              <code className="mx-1">X-Forwarded-For</code> are both
              missing on this request. Check the Traefik IngressRoute /
              middleware for the admin host: the
              {' '}<code>plugin.forwardedHeadersStrategy</code> or a
              <code className="mx-1">X-Forwarded-For</code> middleware
              must populate the chain. Do NOT add{' '}
              <code>10.42.0.0/16</code> as a <code>ClusterTrustedRange</code>
              {' '}— that would let any pod bypass the gate.
            </div>
          )}
        </div>
      )}

      {err && (
        <div className="rounded-md border border-red-300 bg-red-100 dark:bg-red-900/40 dark:border-red-700 px-3 py-2 text-xs text-red-800 dark:text-red-200">
          {err}
        </div>
      )}
    </div>
  );
}

function ModeBadge({ mode }: { mode: CrowdsecL4Mode }) {
  const tone =
    mode === 'enforce' ? 'bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-200'
    : mode === 'dryrun' ? 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200'
    : 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300';
  return (
    <span className={`rounded px-2 py-0.5 text-[10px] uppercase ${tone}`}>{mode}</span>
  );
}

function L4Stat({ label, value, tone }: { label: string; value: string; tone: 'ok' | 'warn' | 'info' }) {
  const accent =
    tone === 'ok' ? 'border-emerald-200 dark:border-emerald-800 bg-emerald-50/50 dark:bg-emerald-900/10'
    : tone === 'warn' ? 'border-amber-200 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-900/10'
    : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800';
  return (
    <div className={`rounded border p-2 ${accent}`}>
      <div className="text-[10px] uppercase text-gray-500 dark:text-gray-400">{label}</div>
      <div className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">{value}</div>
    </div>
  );
}

// ─── Manual stale-bouncer prune button (mirrors 24h scheduler) ──────

function CrowdsecBouncerPruneButton({ staleCount }: { staleCount: number }) {
  const mut = usePruneCrowdsecBouncers();
  const [lastPruned, setLastPruned] = useState<number | null>(null);

  if (staleCount <= 0) return null;

  const onClick = () => {
    mut.mutate(undefined, {
      onSuccess: (r) => setLastPruned(r.data.pruned),
    });
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={mut.isPending}
      title={`${staleCount} bouncer(s) haven't pulled in a while. Auto-prune runs every 24h; click to run now.`}
      className="inline-flex items-center gap-1 rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 px-2 py-0.5 text-[10px] font-medium text-amber-800 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/40 disabled:opacity-50"
      data-testid="crowdsec-prune-bouncers"
    >
      <Trash2 size={10} />
      {mut.isPending ? 'Pruning…' : lastPruned !== null ? `Pruned ${lastPruned}` : `Prune ${staleCount} stale`}
    </button>
  );
}
