import { useEffect, useMemo, useState } from 'react';
import { X, Loader2, CheckCircle, AlertTriangle } from 'lucide-react';
import { useBulkOpProgress, type LifecycleTransitionRow, type LifecycleHookRunRow } from '@/hooks/use-lifecycle';

interface Props {
  readonly bulkOpId: string;
  readonly action: 'suspend' | 'reactivate' | 'delete';
  readonly clientCount: number;
  readonly onClose: () => void;
}

const TRANSITION_BADGE: Record<LifecycleTransitionRow['state'], { label: string; cls: string }> = {
  running: { label: 'Running', cls: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300' },
  completed: { label: 'Completed', cls: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300' },
  failed_partial: { label: 'Partial', cls: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300' },
  failed_blocking: { label: 'Failed', cls: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300' },
};

function summarise(transitions: LifecycleTransitionRow[], hookRuns: Record<string, LifecycleHookRunRow[]>): {
  total: number;
  completed: number;
  partial: number;
  failed: number;
  running: number;
  pendingHooks: number;
  failedHooks: number;
} {
  const counts = { total: transitions.length, completed: 0, partial: 0, failed: 0, running: 0, pendingHooks: 0, failedHooks: 0 };
  for (const t of transitions) {
    if (t.state === 'completed') counts.completed++;
    else if (t.state === 'failed_partial') counts.partial++;
    else if (t.state === 'failed_blocking') counts.failed++;
    else if (t.state === 'running') counts.running++;
    for (const r of hookRuns[t.id] ?? []) {
      if (r.state === 'pending' || r.state === 'running') counts.pendingHooks++;
      if (r.state === 'failed') counts.failedHooks++;
    }
  }
  return counts;
}

export default function BulkProgressModal({ bulkOpId, action, clientCount, onClose }: Props) {
  const [paused, setPaused] = useState(false);
  const data = useBulkOpProgress(bulkOpId, 2000, paused);
  // Memoise the derived arrays so summarise's deps don't churn on
  // every render (would otherwise fire setPaused repeatedly).
  const transitions = useMemo(() => data.data?.data.transitions ?? [], [data.data]);
  const hookRuns = useMemo(() => data.data?.data.hookRuns ?? {}, [data.data]);
  const stats = useMemo(() => summarise(transitions, hookRuns), [transitions, hookRuns]);

  useEffect(() => {
    const stillActive = stats.running > 0 || stats.pendingHooks > 0 || stats.failedHooks > 0;
    if (!stillActive && stats.total >= clientCount) setPaused(true);
  }, [stats, clientCount]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 py-8"
      role="dialog"
      aria-modal="true"
      data-testid="bulk-progress-modal"
      onClick={onClose}
    >
      <div
        className="w-full max-w-4xl rounded-xl bg-white shadow-xl dark:bg-gray-800 max-h-[calc(100vh-4rem)] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3 dark:border-gray-700">
          <div className="flex items-center gap-3">
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
              Bulk {action} — {clientCount} client{clientCount === 1 ? '' : 's'}
            </h2>
            <span className="font-mono text-[10px] text-gray-500 dark:text-gray-400">{bulkOpId.slice(0, 8)}…</span>
            {paused && (
              <span className="inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
                <CheckCircle size={12} className="text-green-500" /> done
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
              data-testid="bulk-progress-dismiss"
            >
              {paused ? 'Close' : 'Run in Background'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
              aria-label="Close"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Aggregate stats strip */}
        <div className="flex flex-wrap items-center gap-3 border-b border-gray-200 px-5 py-2 text-xs dark:border-gray-700">
          <span className="text-gray-500 dark:text-gray-400">{stats.total}/{clientCount} dispatched</span>
          <span className="text-green-700 dark:text-green-300">{stats.completed} ok</span>
          {stats.partial > 0 && <span className="text-amber-700 dark:text-amber-300">{stats.partial} partial</span>}
          {stats.failed > 0 && <span className="text-red-700 dark:text-red-300">{stats.failed} failed</span>}
          {stats.running > 0 && <span className="inline-flex items-center gap-1 text-blue-700 dark:text-blue-300"><Loader2 size={10} className="animate-spin" /> {stats.running} running</span>}
          {stats.failedHooks > 0 && <span className="inline-flex items-center gap-1 text-red-700 dark:text-red-300"><AlertTriangle size={10} /> {stats.failedHooks} hook failure(s)</span>}
        </div>

        {/* Per-client rows */}
        <div className="divide-y divide-gray-200 dark:divide-gray-700">
          {transitions.length === 0 && (
            <div className="px-5 py-6 text-sm text-gray-500 dark:text-gray-400">
              {data.isLoading ? (
                <div className="flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Waiting for first transition row…</div>
              ) : (
                'No transitions visible yet.'
              )}
            </div>
          )}
          {transitions.map((t) => {
            const runs = hookRuns[t.id] ?? [];
            const ok = runs.filter((r) => r.state === 'ok' || r.state === 'noop').length;
            const failed = runs.filter((r) => r.state === 'failed').length;
            const pending = runs.filter((r) => r.state === 'pending' || r.state === 'running').length;
            const badge = TRANSITION_BADGE[t.state];
            return (
              <details key={t.id} className="px-5 py-2 text-xs">
                <summary className="flex cursor-pointer items-center gap-3">
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${badge.cls}`}>{badge.label}</span>
                  <span className="font-mono text-gray-700 dark:text-gray-200">{t.transitionKind}</span>
                  <span className="text-gray-500 dark:text-gray-400">client {t.clientId.slice(0, 8)}…</span>
                  {t.namespace && <span className="text-gray-400 dark:text-gray-500">ns {t.namespace}</span>}
                  <span className="ml-auto text-gray-500 dark:text-gray-400">
                    {ok} ok{failed > 0 && <>, <span className="text-red-700 dark:text-red-300">{failed} failed</span></>}{pending > 0 && <>, <span className="text-blue-700 dark:text-blue-300">{pending} pending</span></>}
                  </span>
                </summary>
                <ul className="mt-1 space-y-0.5 pl-4 text-gray-700 dark:text-gray-300">
                  {runs.sort((a, b) => a.hookOrder - b.hookOrder).map((r) => (
                    <li key={r.id} className="flex items-center gap-2">
                      <span className="font-mono">{r.hookName}</span>
                      <span className={`text-[10px] ${
                        r.state === 'failed' ? 'text-red-700 dark:text-red-300'
                          : r.state === 'pending' || r.state === 'running' ? 'text-blue-700 dark:text-blue-300'
                            : 'text-gray-500 dark:text-gray-400'
                      }`}>{r.state} ({r.attempts}/{r.maxAttempts})</span>
                      {r.lastError && (
                        <span className="text-[10px] text-red-700 dark:text-red-300">
                          {r.lastError.title ?? 'error'}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </details>
            );
          })}
        </div>
      </div>
    </div>
  );
}
