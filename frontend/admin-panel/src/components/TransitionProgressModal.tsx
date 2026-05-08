import { useEffect, useMemo, useState } from 'react';
import { X, Loader2, CheckCircle, AlertTriangle, RotateCw } from 'lucide-react';
import {
  useClientLifecycleTransitions,
  useRetryHookRun,
  type LifecycleTransitionRow,
  type LifecycleHookRunRow,
} from '@/hooks/use-lifecycle';

interface Props {
  readonly clientId: string;
  /** Transition kind to follow (active|suspended|archived|restored|deleted).
   *  Modal latches onto the most-recent transition of that kind started
   *  AFTER `since` so concurrent transitions don't bleed into the view. */
  readonly transition: LifecycleTransitionRow['transitionKind'];
  /** Time the operator triggered the operation (ms epoch). */
  readonly since: number;
  /** When provided, the modal latches onto this transition row directly
   *  without waiting for kind+since matching — eliminates the 1-2 s
   *  "No matching transition" gap. The DELETE / bulk endpoints return
   *  this; PATCH does not yet (storage-lifecycle thread doesn't
   *  surface it). */
  readonly transitionId?: string | null;
  readonly onClose: () => void;
}

const STATE_BADGE: Record<LifecycleHookRunRow['state'], string> = {
  pending: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
  running: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  ok: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  noop: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
};

const TRANSITION_BADGE: Record<LifecycleTransitionRow['state'], { label: string; cls: string; icon: typeof Loader2 }> = {
  running: { label: 'Running', cls: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300', icon: Loader2 },
  completed: { label: 'Completed', cls: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300', icon: CheckCircle },
  failed_partial: { label: 'Completed with retries', cls: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300', icon: AlertTriangle },
  failed_blocking: { label: 'Failed', cls: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300', icon: AlertTriangle },
};

export default function TransitionProgressModal({ clientId, transition, since, transitionId, onClose }: Props) {
  const [paused, setPaused] = useState(false);
  // Faster initial polling so the gap between "open modal" and "first
  // hook_runs visible" is sub-second in the common case.
  const data = useClientLifecycleTransitions(clientId, 800, paused);
  const retry = useRetryHookRun();

  // Pick the matching transition: prefer explicit transitionId when
  // the caller knows it (DELETE/bulk endpoints return it). Otherwise
  // fall back to (kind + since) latching for PATCH paths that don't
  // yet thread the id through storage-lifecycle.
  const tx = useMemo<LifecycleTransitionRow | null>(() => {
    const rows = data.data?.data.transitions ?? [];
    if (transitionId) return rows.find((r) => r.id === transitionId) ?? null;
    const candidates = rows.filter((r) => r.transitionKind === transition
      && new Date(r.startedAt).getTime() >= since - 5000);
    if (candidates.length === 0) return null;
    return candidates.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())[0];
  }, [data.data, transition, since, transitionId]);

  // Memoise so the effect's dep array doesn't churn on every render.
  const runs = useMemo<LifecycleHookRunRow[]>(() => {
    if (!tx) return [];
    return data.data?.data.hookRuns[tx.id] ?? [];
  }, [tx, data.data]);

  useEffect(() => {
    if (!tx) return;
    const stillActive = tx.state === 'running'
      || runs.some((r) => r.state === 'pending' || r.state === 'running' || r.state === 'failed');
    if (!stillActive) setPaused(true);
  }, [tx, runs]);

  const onRetry = (runId: string): void => {
    retry.mutate(runId);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 py-8"
      role="dialog"
      aria-modal="true"
      data-testid="transition-progress-modal"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl rounded-xl bg-white shadow-xl dark:bg-gray-800 max-h-[calc(100vh-4rem)] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
              Lifecycle: <span className="font-mono">{transition}</span>
            </h2>
            {tx && (() => {
              const b = TRANSITION_BADGE[tx.state];
              const Icon = b.icon;
              return (
                <span className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium ${b.cls}`}>
                  <Icon size={12} className={tx.state === 'running' ? 'animate-spin' : ''} /> {b.label}
                </span>
              );
            })()}
            {paused && (
              <span className="text-xs text-gray-500 dark:text-gray-400">(polling stopped)</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* "Run in Background" button — the underlying op is decoupled
                from the modal so closing here never cancels work. The
                label only changes once the transition is terminal. */}
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
              data-testid="transition-progress-dismiss"
            >
              {tx && (tx.state === 'completed' || tx.state === 'failed_partial' || tx.state === 'failed_blocking')
                ? 'Close'
                : 'Run in Background'}
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

        <div className="space-y-3 px-5 py-4 text-sm">
          {!tx && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-blue-700 dark:text-blue-300">
                <Loader2 size={14} className="animate-spin" />
                Dispatching <span className="font-mono">{transition}</span> transition…
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                Hook execution begins in &lt;1 s. If this stays here for more
                than ~10 s, the dispatcher may have failed to open a
                transition row — check platform-api logs.
              </div>
            </div>
          )}

          {tx && runs.length === 0 && (
            <div className="text-gray-500 dark:text-gray-400">
              No hook_runs recorded for this transition yet.
            </div>
          )}

          {tx && runs.length > 0 && (
            <table className="w-full text-xs">
              <thead className="text-gray-500 dark:text-gray-400">
                <tr>
                  <th className="text-left py-1">#</th>
                  <th className="text-left py-1">Hook</th>
                  <th className="text-left py-1">Blocking</th>
                  <th className="text-right py-1">Attempts</th>
                  <th className="text-left py-1">State</th>
                  <th className="text-right py-1">Action</th>
                </tr>
              </thead>
              <tbody>
                {runs.sort((a, b) => a.hookOrder - b.hookOrder).map((r) => (
                  <tr key={r.id} className="border-t border-gray-200/60 dark:border-gray-700/40">
                    <td className="py-1 tabular-nums text-gray-500">{r.hookOrder}</td>
                    <td className="py-1 font-mono text-gray-900 dark:text-gray-100">{r.hookName}</td>
                    <td className="py-1 text-gray-500">{r.blocking}</td>
                    <td className="py-1 text-right tabular-nums">{r.attempts}/{r.maxAttempts}</td>
                    <td className="py-1">
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${STATE_BADGE[r.state]}`}>{r.state}</span>
                    </td>
                    <td className="py-1 text-right">
                      {r.state === 'failed' && (
                        <button
                          type="button"
                          onClick={() => onRetry(r.id)}
                          disabled={retry.isPending}
                          className="inline-flex items-center gap-1 rounded bg-blue-600 px-2 py-0.5 text-[10px] text-white hover:bg-blue-700 disabled:opacity-50"
                        >
                          <RotateCw size={10} /> Retry
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {tx && runs.filter((r) => r.state === 'failed' && r.lastError).map((r) => {
            const env = r.lastError!;
            return (
              <div key={r.id} className="rounded border border-red-300 bg-red-50 p-2 text-xs dark:border-red-700/60 dark:bg-red-900/30">
                <div className="font-medium text-red-800 dark:text-red-200">{r.hookName}: {env.title ?? 'failure'}</div>
                {env.detail && <div className="mt-0.5 text-red-700 dark:text-red-300">{env.detail}</div>}
                {env.remediation && env.remediation.length > 0 && (
                  <ul className="mt-1 list-disc pl-4 text-[11px] text-red-700 dark:text-red-300">
                    {env.remediation.map((step, i) => <li key={i}>{step}</li>)}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
