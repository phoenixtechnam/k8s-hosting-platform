// Compact "Updates available?" pill. Five visual states:
//
//   no-update   → silent green checkmark
//   patch       → blue "patch available"
//   minor       → amber "minor available"
//   major       → red "major available"
//   unknown     → muted "—" with the registry's reason on hover
//
// Clicking a non-no-update pill opens the upgrade modal (handled by
// the parent — this component just exposes onUpgrade).

import { ArrowUpCircle, Check, HelpCircle, Loader2 } from 'lucide-react';
import clsx from 'clsx';
import type { UpdateCheckResult } from '@k8s-hosting/api-contracts';

interface UpdatesPillProps {
  readonly result: UpdateCheckResult | undefined;
  readonly loading: boolean;
  readonly canManage: boolean;
  readonly onUpgrade: () => void;
}

export function UpdatesPill({ result, loading, canManage, onUpgrade }: UpdatesPillProps) {
  if (loading && !result) {
    return <Loader2 size={14} className="animate-spin text-gray-400" />;
  }
  if (!result) {
    return <span className="text-xs text-gray-400">—</span>;
  }

  const baseCls = 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium';

  if (result.status === 'no-update') {
    return (
      <span className={clsx(baseCls, 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300')}>
        <Check size={12} /> up to date
      </span>
    );
  }

  if (result.status === 'unknown') {
    return (
      <span
        className={clsx(baseCls, 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400')}
        title={result.reason ?? 'Could not check the registry'}
      >
        <HelpCircle size={12} /> unknown
      </span>
    );
  }

  const palette = result.status === 'major'
    ? 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300'
    : result.status === 'minor'
      ? 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
      : 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300';

  return (
    <button
      type="button"
      disabled={!canManage}
      onClick={onUpgrade}
      className={clsx(baseCls, palette, canManage ? 'cursor-pointer hover:brightness-95' : 'cursor-default')}
      title={`Latest: ${result.latest ?? '?'} (current ${result.current ?? '?'})`}
    >
      <ArrowUpCircle size={12} />
      {result.status} → {result.latest}
    </button>
  );
}
