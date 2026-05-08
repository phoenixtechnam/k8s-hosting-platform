// Client-panel TaskCenterChip — mirror of admin-panel chip with a
// reduced surface: no modal registry (the admin-panel-only progress
// modals don't exist in client-panel), so all task targets that arrive
// here should be `type: 'route'`. Tasks of `type: 'modal'` ARE possible
// in theory but practically a client_admin never triggers an admin
// bulk op or per-client transition, so we render them as inert info
// rows in the popover (no click action) — defensive, not common.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Loader2, CheckCircle2, AlertTriangle, Activity, X, Trash2, ChevronRight,
} from 'lucide-react';
import clsx from 'clsx';
import type { TaskRow } from '@k8s-hosting/api-contracts';
import { useTaskCenter, useClearTasks } from '@/hooks/use-task-center';

const RECENT_TERMINAL_WINDOW_MS = 5 * 60 * 1000;

export default function TaskCenterChip() {
  const { data, isLoading } = useTaskCenter();
  const clearTasks = useClearTasks();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const tasks = data?.data?.tasks ?? [];
  const running = useMemo(
    () => tasks.filter((t) => t.status === 'running' || t.status === 'queued'),
    [tasks],
  );
  const recentTerminal = useMemo(() => {
    const cutoff = Date.now() - RECENT_TERMINAL_WINDOW_MS;
    return tasks.filter((t) => {
      if (t.status === 'running' || t.status === 'queued') return false;
      if (!t.finishedAt) return false;
      const ts = new Date(t.finishedAt).getTime();
      return ts >= cutoff && !t.clearedAt;
    });
  }, [tasks]);

  const runningCount = running.length;
  const failedCount = recentTerminal.filter((t) => t.status === 'failed').length;
  const succeededCount = recentTerminal.filter((t) => t.status === 'succeeded').length;

  // Always-visible chip (Phase 3 UX): even when nothing is in flight,
  // render as a neutral icon-only pill so operators always see where
  // long-running ops will surface. Hide only during the first-load
  // flicker.
  if (isLoading) return null;

  const tone =
    failedCount > 0 ? 'red'
    : runningCount > 0 ? 'blue'
    : succeededCount > 0 ? 'green'
    : 'gray';

  const chipClass = clsx(
    'relative flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors',
    tone === 'red' && 'bg-red-50 text-red-700 hover:bg-red-100 dark:bg-red-900/30 dark:text-red-300 dark:hover:bg-red-900/50',
    tone === 'blue' && 'bg-brand-50 text-brand-700 hover:bg-brand-100 dark:bg-brand-900/30 dark:text-brand-300 dark:hover:bg-brand-900/50',
    tone === 'green' && 'bg-green-50 text-green-700 hover:bg-green-100 dark:bg-green-900/30 dark:text-green-300 dark:hover:bg-green-900/50',
    tone === 'gray' && 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600',
  );

  const ChipIcon =
    failedCount > 0 ? AlertTriangle
    : runningCount > 0 ? Loader2
    : succeededCount > 0 ? CheckCircle2
    : Activity;

  const chipLabel = runningCount > 0
    ? `${runningCount} running`
    : failedCount > 0
      ? `${failedCount} failed`
      : succeededCount > 0
        ? `${succeededCount} done`
        : 'Tasks';

  const onSelect = (task: TaskRow) => {
    if (task.target.type === 'route') {
      navigate(task.target.href);
      setOpen(false);
    }
    // type='modal' fall-through: the client-panel doesn't carry the
    // admin-panel modal registry. The popover row stays clickable but
    // does nothing — practically unreachable for a client_admin.
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((p) => !p)}
        className={chipClass}
        data-testid="task-center-chip"
        aria-label={`Task center — ${chipLabel}`}
        aria-expanded={open}
      >
        <ChipIcon
          size={14}
          className={runningCount > 0 ? 'animate-spin' : undefined}
        />
        <span>{chipLabel}</span>
      </button>

      {open && (
        <div
          className="absolute right-0 z-50 mt-2 w-96 rounded-xl border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-800"
          data-testid="task-center-popover"
        >
          <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3 dark:border-gray-700">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              Tasks
            </h3>
            <div className="flex items-center gap-2">
              {recentTerminal.length > 0 && (
                <button
                  type="button"
                  onClick={() => clearTasks.mutate(undefined)}
                  disabled={clearTasks.isPending}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:text-gray-300 dark:hover:bg-gray-700"
                  data-testid="task-center-clear-completed"
                >
                  <Trash2 size={12} /> Clear completed
                </button>
              )}
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-200"
                aria-label="Close"
              >
                <X size={14} />
              </button>
            </div>
          </div>

          <div className="max-h-96 overflow-y-auto">
            {tasks.length === 0 ? (
              <div className="px-4 py-8 text-center text-xs text-gray-500 dark:text-gray-400">
                No tasks running.
              </div>
            ) : (
              <ul className="divide-y divide-gray-100 dark:divide-gray-700" data-testid="task-center-list">
                {[...running, ...recentTerminal].map((task) => (
                  <TaskRowItem key={task.id} task={task} onSelect={onSelect} />
                ))}
              </ul>
            )}
          </div>

          <div className="border-t border-gray-100 px-4 py-2 text-[10px] text-gray-400 dark:border-gray-700 dark:text-gray-500">
            Updates every {runningCount > 0 ? '3' : '30'} seconds. Completed tasks auto-expire after 5 minutes.
          </div>
        </div>
      )}
    </div>
  );
}

function TaskRowItem({ task, onSelect }: { task: TaskRow; onSelect: (t: TaskRow) => void }) {
  const tone =
    task.status === 'failed' ? 'red'
    : task.status === 'succeeded' ? 'green'
    : task.status === 'running' || task.status === 'queued' ? 'blue'
    : 'gray';

  const Icon =
    task.status === 'failed' ? AlertTriangle
    : task.status === 'succeeded' ? CheckCircle2
    : task.status === 'running' || task.status === 'queued' ? Loader2
    : Activity;

  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(task)}
        className="flex w-full items-start gap-2 px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-700/40"
        data-testid={`task-center-row-${task.id}`}
      >
        <Icon
          size={14}
          className={clsx(
            'mt-0.5 shrink-0',
            tone === 'red' && 'text-red-600 dark:text-red-400',
            tone === 'green' && 'text-green-600 dark:text-green-400',
            tone === 'blue' && 'text-brand-600 dark:text-brand-400 animate-spin',
            tone === 'gray' && 'text-gray-400',
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-gray-900 dark:text-gray-100">
            {task.label}
          </div>
          <div className="truncate text-[11px] text-gray-500 dark:text-gray-400">
            {task.errorMessage ?? task.progressText ?? task.kind}
          </div>
          {task.progressPct != null && (task.status === 'running' || task.status === 'queued') && (
            <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
              <div
                className={clsx(
                  'h-full transition-all',
                  tone === 'red' && 'bg-red-500',
                  tone !== 'red' && 'bg-brand-500',
                )}
                style={{ width: `${task.progressPct}%` }}
              />
            </div>
          )}
        </div>
        <ChevronRight size={12} className="mt-1 shrink-0 text-gray-300 dark:text-gray-600" />
      </button>
    </li>
  );
}
