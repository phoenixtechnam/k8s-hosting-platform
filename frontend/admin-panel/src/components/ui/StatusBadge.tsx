import clsx from 'clsx';

type BadgeStatus = 'active' | 'suspended' | 'pending' | 'cancelled' | 'expired' | 'error' | 'healthy' | 'warning';

const statusStyles: Record<BadgeStatus, string> = {
  active: 'bg-green-100 text-green-800',
  healthy: 'bg-green-100 text-green-800',
  suspended: 'bg-red-100 text-red-800',
  cancelled: 'bg-gray-100 text-gray-600',
  error: 'bg-red-100 text-red-800',
  expired: 'bg-gray-100 text-gray-800',
  pending: 'bg-amber-100 text-amber-800',
  warning: 'bg-orange-100 text-orange-800',
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
