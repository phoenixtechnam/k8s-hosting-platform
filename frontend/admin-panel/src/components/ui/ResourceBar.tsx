import clsx from 'clsx';

interface ResourceBarProps {
  readonly used: number;
  readonly total: number;
  readonly label?: string;
  readonly unit?: string;
}

export default function ResourceBar({ used, total, label, unit = '' }: ResourceBarProps) {
  const percentage = total > 0 ? Math.min((used / total) * 100, 100) : 0;
  const color =
    percentage >= 90 ? 'bg-red-500' : percentage >= 70 ? 'bg-amber-500' : 'bg-brand-500';

  return (
    <div data-testid="resource-bar">
      {label && (
        <div className="mb-1 flex items-center justify-between text-sm">
          <span className="text-gray-600 dark:text-gray-400">{label}</span>
          <span className="font-medium text-gray-900 dark:text-gray-100">
            {used}
            {unit} / {total}
            {unit}
          </span>
        </div>
      )}
      <div className="h-2 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
        <div
          className={clsx('h-full rounded-full transition-all', color)}
          style={{ width: `${percentage}%` }}
          role="progressbar"
          aria-valuenow={percentage}
          aria-valuemin={0}
          aria-valuemax={100}
        />
      </div>
    </div>
  );
}
