import type { LucideIcon } from 'lucide-react';
import clsx from 'clsx';

interface StatCardProps {
  readonly title: string;
  readonly value: string | number;
  readonly subtitle?: string;
  readonly icon: LucideIcon;
  readonly trend?: 'up' | 'down' | 'neutral';
  readonly accent?: 'brand' | 'green' | 'amber' | 'red';
}

const accentColors = {
  brand: 'border-l-brand-500 bg-brand-50/50',
  green: 'border-l-green-500 bg-green-50/50',
  amber: 'border-l-amber-500 bg-amber-50/50',
  red: 'border-l-red-500 bg-red-50/50',
} as const;

const iconColors = {
  brand: 'text-brand-500',
  green: 'text-green-600',
  amber: 'text-amber-600',
  red: 'text-red-600',
} as const;

export default function StatCard({
  title,
  value,
  subtitle,
  icon: Icon,
  accent = 'brand',
}: StatCardProps) {
  return (
    <div
      className={clsx(
        'rounded-xl border border-gray-200 border-l-4 bg-white p-5 shadow-sm transition-shadow hover:shadow-md',
        accentColors[accent],
      )}
      data-testid="stat-card"
    >
      <div className="flex items-start justify-between">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-gray-500">{title}</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{value}</p>
          {subtitle && <p className="mt-1 text-xs text-gray-500">{subtitle}</p>}
        </div>
        <div className={clsx('rounded-lg p-2', iconColors[accent])}>
          <Icon size={22} />
        </div>
      </div>
    </div>
  );
}
