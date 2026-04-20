import clsx from 'clsx';

type BadgeStatus = 'active' | 'suspended' | 'pending' | 'cancelled' | 'expired' | 'error' | 'failed' | 'healthy' | 'warning' | 'running' | 'stopped'
  | 'deploying' | 'upgrading' | 'deleting' | 'completed' | 'rolled_back' | 'rolling_back' | 'backing_up' | 'pre_check' | 'health_check'
  // Client lifecycle (extends clients.status)
  | 'archived'
  // Storage lifecycle transient states — rendered as their own pill on the clients list.
  | 'idle' | 'snapshotting' | 'quiescing' | 'resizing' | 'replacing' | 'restoring' | 'unquiescing' | 'archiving';

const statusStyles: Record<BadgeStatus, string> = {
  active: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  healthy: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  running: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  completed: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  suspended: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  stopped: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400',
  cancelled: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400',
  error: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  rolled_back: 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300',
  expired: 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300',
  pending: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  warning: 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300',
  deploying: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  upgrading: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  deleting: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  rolling_back: 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300',
  backing_up: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  pre_check: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  health_check: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  // Archived clients read like "parked" — neutral slate.
  archived: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
  // Storage lifecycle transient states.
  idle: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400',
  snapshotting: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  quiescing: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  resizing: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300',
  replacing: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300',
  restoring: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300',
  unquiescing: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  archiving: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
};

interface StatusBadgeProps {
  readonly status: BadgeStatus;
  readonly label?: string;
}

export default function StatusBadge({ status, label }: StatusBadgeProps) {
  const displayLabel = label ?? status.charAt(0).toUpperCase() + status.slice(1);

  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium capitalize',
        statusStyles[status],
      )}
      data-testid="status-badge"
    >
      {displayLabel}
    </span>
  );
}
