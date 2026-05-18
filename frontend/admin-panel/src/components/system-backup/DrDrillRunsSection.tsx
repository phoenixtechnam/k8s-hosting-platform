/**
 * DR Drill Runs section (DR-bundle roadmap, Phase 1).
 *
 * Rendered at the top of DrDrillTab. Shows the rolling 12-run history
 * + summary chips (rolling pass rate, last success, consecutive-streak).
 * Populated by `POST /admin/system-backup/dr-drill/runs` from CI
 * (the weekly GitHub Actions workflow + any manual triggers).
 */

import { CheckCircle2, XCircle, Clock, AlertTriangle } from 'lucide-react';
import type { DrDrillRun } from '@k8s-hosting/api-contracts';
import { useDrDrillRuns, useDrDrillSummary } from '@/hooks/use-system-backup';

export default function DrDrillRunsSection() {
  const runsQ = useDrDrillRuns();
  const summaryQ = useDrDrillSummary();

  const runs = runsQ.data ?? [];
  const summary = summaryQ.data;

  return (
    <section className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 space-y-3" data-testid="dr-drill-runs">
      <header className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Drill execution history</h3>
        {runsQ.isFetching && <Clock size={14} className="text-gray-400 animate-pulse" />}
      </header>

      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <SummaryStat
            label="Rolling pass rate"
            value={`${(summary.rollingPassRate * 100).toFixed(0)}%`}
            tone={summary.rollingPassRate >= 0.9 ? 'good' : summary.rollingPassRate >= 0.5 ? 'warn' : 'bad'}
          />
          <SummaryStat
            label="Consecutive successes"
            value={summary.consecutiveSuccessCount > 0 ? `${summary.consecutiveSuccessCount} ✓` : '—'}
            tone={summary.consecutiveSuccessCount > 0 ? 'good' : 'neutral'}
          />
          <SummaryStat
            label="Last success"
            value={summary.lastSuccessAt ? relative(summary.lastSuccessAt) : 'never'}
            tone={summary.lastSuccessAt ? 'good' : 'bad'}
          />
          <SummaryStat
            label="Last failure"
            value={summary.lastFailureAt ? relative(summary.lastFailureAt) : 'never'}
            tone={summary.lastFailureAt ? 'warn' : 'good'}
          />
        </div>
      )}

      {summary?.consecutiveFailureCount && summary.consecutiveFailureCount >= 2 ? (
        <div className="flex items-center gap-2 rounded-md border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-900 dark:text-red-200" data-testid="dr-drill-streak-warning">
          <AlertTriangle size={14} />
          <strong>{summary.consecutiveFailureCount} consecutive drill failures.</strong>
          Investigate before relying on DR. See the most-recent failure's report below.
        </div>
      ) : null}

      {runs.length === 0 ? (
        <div className="text-sm text-gray-500 italic py-4">
          No drills recorded yet. CI runs weekly (Mondays 04:00 UTC); first row will appear after the
          next scheduled execution or manual <code>workflow_dispatch</code>.
        </div>
      ) : (
        <table className="min-w-full text-sm" data-testid="dr-drill-runs-table">
          <thead className="bg-gray-50 dark:bg-gray-900/50 text-gray-600 dark:text-gray-400 text-xs uppercase">
            <tr>
              <th className="px-3 py-2 text-left">When</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th className="px-3 py-2 text-left">Trigger</th>
              <th className="px-3 py-2 text-left">Duration</th>
              <th className="px-3 py-2 text-left">Secrets restored</th>
              <th className="px-3 py-2 text-left">Failure</th>
              <th className="px-3 py-2 text-left">Runner</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {runs.map((r) => (
              <tr key={r.id}>
                <td className="px-3 py-2 font-mono text-xs text-gray-700 dark:text-gray-200">
                  {new Date(r.startedAt).toISOString().slice(0, 19).replace('T', ' ')}
                </td>
                <td className="px-3 py-2"><StatusBadge status={r.status} /></td>
                <td className="px-3 py-2 text-xs text-gray-700 dark:text-gray-200">{r.trigger}</td>
                <td className="px-3 py-2 text-xs text-gray-700 dark:text-gray-200">
                  {r.durationSeconds !== null ? `${r.durationSeconds}s` : '—'}
                </td>
                <td className="px-3 py-2 text-xs text-gray-700 dark:text-gray-200">
                  {r.secretsRestoredCount ?? '—'}
                </td>
                <td className="px-3 py-2 text-xs text-red-700 dark:text-red-300 max-w-xs truncate" title={r.failureReason ?? ''}>
                  {r.failureReason ?? ''}
                </td>
                <td className="px-3 py-2 font-mono text-xs text-gray-500 truncate max-w-xs" title={r.runner}>
                  {r.runner}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function StatusBadge({ status }: { status: DrDrillRun['status'] }) {
  const base = 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium';
  switch (status) {
    case 'success':
      return <span className={`${base} bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200`}><CheckCircle2 size={12} /> success</span>;
    case 'failed':
      return <span className={`${base} bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-200`}><XCircle size={12} /> failed</span>;
    case 'running':
      return <span className={`${base} bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-200`}><Clock size={12} /> running</span>;
    case 'cancelled':
      return <span className={`${base} bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-200`}>cancelled</span>;
  }
}

function SummaryStat({ label, value, tone }: { label: string; value: string; tone: 'good' | 'bad' | 'warn' | 'neutral' }) {
  const cls =
    tone === 'good'
      ? 'border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-900 dark:text-emerald-200'
      : tone === 'bad'
        ? 'border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 text-red-900 dark:text-red-200'
        : tone === 'warn'
          ? 'border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 text-amber-900 dark:text-amber-200'
          : 'border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-200';
  return (
    <div className={`rounded-md border ${cls} p-3`}>
      <div className="text-xs uppercase">{label}</div>
      <div className="text-lg font-semibold mt-1">{value}</div>
    </div>
  );
}

function relative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
