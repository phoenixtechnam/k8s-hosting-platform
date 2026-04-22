import { HardDrive, Server, Cloud, Loader2, AlertTriangle, CheckCircle, XCircle } from 'lucide-react';
import { usePlatformStorage, formatBytes } from '@/hooks/use-platform-storage';

/**
 * Storage Inventory — Longhorn nodes, volumes, backup target at a glance.
 *
 * Four stat tiles arranged in a grid. Covers:
 *   - Node count with ready/schedulable breakdown
 *   - Volume count with attached/degraded flags
 *   - Aggregate capacity and allocated bytes across all volumes
 *   - Backup target status (available/unavailable + URL + message)
 *
 * Rendered on the Storage Configuration page above the active backup
 * target summary. Falls back to an "unavailable" card when Longhorn
 * isn't installed or the k8s API call fails — never errors out.
 */
export default function StorageInventoryCard() {
  const { data, isLoading, isError } = usePlatformStorage();

  if (isLoading) {
    return (
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm">
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <Loader2 size={14} className="animate-spin" /> Loading Longhorn inventory…
        </div>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm">
        <div className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-300">
          <AlertTriangle size={14} /> Storage inventory unavailable.
        </div>
      </div>
    );
  }

  if (!data.available) {
    return (
      <div
        className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm"
        data-testid="storage-inventory-unavailable"
      >
        <div className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-300">
          <AlertTriangle size={14} />
          Longhorn inventory: {data.message ?? 'unavailable'}
        </div>
      </div>
    );
  }

  return (
    <div
      className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm space-y-4"
      data-testid="storage-inventory-card"
    >
      <div className="flex items-center gap-3">
        <HardDrive size={20} className="text-gray-700 dark:text-gray-300" />
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Storage Inventory</h2>
      </div>

      <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          icon={<Server size={16} />}
          label="Longhorn Nodes"
          primary={String(data.nodes.total)}
          secondary={`${data.nodes.ready} ready · ${data.nodes.schedulable} schedulable`}
          testId="stat-nodes"
        />
        <StatTile
          icon={<HardDrive size={16} />}
          label="Volumes"
          primary={String(data.volumes.total)}
          secondary={`${data.volumes.attached} attached${data.volumes.degraded > 0 ? ` · ${data.volumes.degraded} degraded` : ''}`}
          accent={data.volumes.degraded > 0 ? 'warn' : undefined}
          testId="stat-volumes"
        />
        <StatTile
          icon={<HardDrive size={16} />}
          label="Capacity"
          primary={formatBytes(data.volumes.capacityBytes)}
          secondary={`${formatBytes(data.volumes.allocatedBytes)} allocated`}
          testId="stat-capacity"
        />
        <StatTile
          icon={<Cloud size={16} />}
          label="Backup Target"
          primary={
            data.backupTarget.available
              ? <span className="inline-flex items-center gap-1"><CheckCircle size={14} className="text-green-600 dark:text-green-400" /> Available</span>
              : <span className="inline-flex items-center gap-1"><XCircle size={14} className="text-red-600 dark:text-red-400" /> {data.backupTarget.message}</span>
          }
          secondary={data.backupTarget.url || 'none configured'}
          accent={data.backupTarget.available ? undefined : 'warn'}
          testId="stat-backup-target"
        />
      </dl>
    </div>
  );
}

interface StatTileProps {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly primary: React.ReactNode;
  readonly secondary?: string;
  readonly accent?: 'warn';
  readonly testId: string;
}

function StatTile({ icon, label, primary, secondary, accent, testId }: StatTileProps) {
  const accentClass = accent === 'warn'
    ? 'border-amber-200 dark:border-amber-800'
    : 'border-gray-200 dark:border-gray-700';
  return (
    <div
      className={`rounded-lg border ${accentClass} bg-gray-50 dark:bg-gray-900/30 p-3`}
      data-testid={testId}
    >
      <dt className="flex items-center gap-1 text-xs font-medium text-gray-500 dark:text-gray-400">
        {icon}
        {label}
      </dt>
      <dd className="mt-1 text-lg font-semibold text-gray-900 dark:text-gray-100">{primary}</dd>
      {secondary && (
        <dd className="mt-0.5 text-xs text-gray-500 dark:text-gray-400 truncate" title={secondary}>
          {secondary}
        </dd>
      )}
    </div>
  );
}
