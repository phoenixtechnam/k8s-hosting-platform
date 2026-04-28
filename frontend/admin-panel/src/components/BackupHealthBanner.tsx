import { AlertCircle } from 'lucide-react';
import type { BackupHealthSummary } from '@k8s-hosting/api-contracts';

interface BackupHealthBannerProps {
  readonly summaries: ReadonlyArray<BackupHealthSummary> | undefined;
}

/**
 * Yellow/red warning banner above the Backups page when any
 * DR-category backup is in `failing` state. Hidden when everything
 * is healthy or no jobs are watched yet.
 */
export default function BackupHealthBanner({ summaries }: BackupHealthBannerProps) {
  if (!summaries) return null;
  const failingDR = summaries.filter(
    (s) => s.state === 'failing' && s.category === 'dr',
  );
  if (failingDR.length === 0) return null;

  const isCritical = failingDR.some((s) => s.severity === 'critical');
  const palette = isCritical
    ? 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200'
    : 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200';

  const names = failingDR.map((s) => s.displayName).join(', ');

  return (
    <div
      className={`mb-4 flex items-start gap-3 rounded-md border px-4 py-3 ${palette}`}
      role="alert"
      data-testid="backup-health-banner"
    >
      <AlertCircle size={20} className="mt-0.5 flex-shrink-0" />
      <div className="text-sm">
        <p className="font-semibold">
          {failingDR.length} backup {failingDR.length === 1 ? 'job' : 'jobs'} failing
        </p>
        <p className="mt-1">
          {names}. Review the DR Job Health table below for the failure
          reason and remediate the underlying issue.
        </p>
      </div>
    </div>
  );
}
