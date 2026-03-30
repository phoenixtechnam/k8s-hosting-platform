import clsx from 'clsx';

type BadgeStatus = 'active' | 'suspended' | 'pending' | 'cancelled' | 'expired' | 'error' | 'failed' | 'healthy' | 'warning' | 'running' | 'stopped'
  | 'deploying' | 'upgrading' | 'deleting' | 'completed' | 'rolled_back' | 'rolling_back' | 'backing_up' | 'pre_check' | 'health_check';

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
