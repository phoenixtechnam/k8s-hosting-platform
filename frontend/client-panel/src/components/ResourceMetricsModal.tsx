import { Loader2, RefreshCw, X, Cpu, MemoryStick, HardDrive } from 'lucide-react';
import { useResourceMetrics, useRefreshMetrics } from '@/hooks/use-resource-metrics';

interface ResourceMetricsModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

/** Format CPU values: e.g. 0.02 cores, 1.0 cores */
function formatCpu(value: number): string {
  if (value >= 10) return `${value.toFixed(0)} cores`;
  if (value >= 1) return `${value.toFixed(1)} cores`;
  return `${value.toFixed(2)} cores`;
}

/** Smart format for memory/storage: < 1 Gi show as Mi, else Gi */
function formatBytes(valueGi: number): string {
  if (valueGi <= 0) return '0 Mi';
  if (valueGi < 0.001) {
    const mb = valueGi * 1024;
    return `${mb.toFixed(2)} Mi`;
  }
  if (valueGi < 1) {
    const mi = valueGi * 1024;
    if (mi >= 100) return `${mi.toFixed(0)} Mi`;
    if (mi >= 10) return `${mi.toFixed(1)} Mi`;
    return `${mi.toFixed(2)} Mi`;
  }
  if (valueGi >= 10) return `${valueGi.toFixed(0)} Gi`;
  return `${valueGi.toFixed(1)} Gi`;
}

/** Compact format for header tags */
function formatCpuCompact(value: number): string {
  if (value >= 10) return value.toFixed(0);
  if (value >= 1) return value.toFixed(1);
  return value.toFixed(2);
}

function formatBytesCompact(valueGi: number): string {
  if (valueGi <= 0) return '0Mi';
  if (valueGi < 1) {
    const mi = valueGi * 1024;
    if (mi >= 100) return `${mi.toFixed(0)}Mi`;
    if (mi >= 10) return `${mi.toFixed(1)}Mi`;
    return `${mi.toFixed(2)}Mi`;
  }
  if (valueGi >= 10) return `${valueGi.toFixed(0)}Gi`;
  return `${valueGi.toFixed(1)}Gi`;
}

/** Format relative time from ISO string */
function relativeTime(isoString: string): string {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs = now - then;

  if (diffMs < 0) return 'just now';

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return 'just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;

  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function ProgressBar({ ratio }: { readonly ratio: number }) {
  const pct = Math.min(Math.max(ratio * 100, 0), 100);

  let barColor: string;
  if (ratio >= 0.8) {
    barColor = 'bg-red-500 dark:bg-red-400';
  } else if (ratio >= 0.5) {
    barColor = 'bg-amber-500 dark:bg-amber-400';
  } else {
    barColor = 'bg-green-500 dark:bg-green-400';
  }

  return (
    <div className="h-2.5 w-full rounded-full bg-gray-200 dark:bg-gray-700">
      <div
        className={`h-2.5 rounded-full transition-all ${barColor}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function ResourceSection({
  icon,
  label,
  inUse,
  reserved,
  available,
  formatValue,
  inUseLabel,
  reservedLabel,
  availableLabel,
}: {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly inUse: number;
  readonly reserved: number;
  readonly available: number;
  readonly formatValue: (v: number) => string;
  readonly inUseLabel: string;
  readonly reservedLabel: string;
  readonly availableLabel: string;
}) {
  const ratio = available > 0 ? inUse / available : 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        {icon}
        <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">{label}</span>
      </div>
      <ProgressBar ratio={ratio} />
      <p className="text-xs text-gray-600 dark:text-gray-400">
        {formatValue(inUse)} / {formatValue(available)}
      </p>
      <div className="space-y-1 pl-1">
        <div className="flex justify-between text-xs">
          <span className="text-gray-500 dark:text-gray-400">In Use</span>
          <span className="font-medium text-gray-700 dark:text-gray-300">
            {formatValue(inUse)}
            <span className="ml-1 text-gray-400 dark:text-gray-500">({inUseLabel})</span>
          </span>
        </div>
        <div className="flex justify-between text-xs">
          <span className="text-gray-500 dark:text-gray-400">Reserved</span>
          <span className="font-medium text-gray-700 dark:text-gray-300">
            {formatValue(reserved)}
            <span className="ml-1 text-gray-400 dark:text-gray-500">({reservedLabel})</span>
          </span>
        </div>
        <div className="flex justify-between text-xs">
          <span className="text-gray-500 dark:text-gray-400">Available</span>
          <span className="font-medium text-gray-700 dark:text-gray-300">
            {formatValue(available)}
            <span className="ml-1 text-gray-400 dark:text-gray-500">({availableLabel})</span>
          </span>
        </div>
      </div>
    </div>
  );
}

export default function ResourceMetricsModal({ open, onClose }: ResourceMetricsModalProps) {
  const { data, isLoading } = useResourceMetrics();
  const refreshMetrics = useRefreshMetrics();

  if (!open) return null;

  const metrics = data?.data;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        data-testid="resource-metrics-modal"
      >
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            Resource Usage Details
          </h2>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-600 dark:hover:text-gray-300"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {isLoading && (
          <div className="flex items-center justify-center py-10">
            <Loader2 size={24} className="animate-spin text-gray-400" />
          </div>
        )}

        {!isLoading && !metrics && (
          <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-10">
            No metrics data available.
          </p>
        )}

        {metrics && (
          <div className="space-y-5">
            <ResourceSection
              icon={<Cpu size={16} className="text-blue-500 dark:text-blue-400" />}
              label="CPU"
              inUse={metrics.cpu.inUse}
              reserved={metrics.cpu.reserved}
              available={metrics.cpu.available}
              formatValue={formatCpu}
              inUseLabel="actual current consumption"
              reservedLabel="allocated by deployments"
              availableLabel="subscription plan limit"
            />

            <div className="border-t border-gray-100 dark:border-gray-700" />

            <ResourceSection
              icon={<MemoryStick size={16} className="text-purple-500 dark:text-purple-400" />}
              label="Memory"
              inUse={metrics.memory.inUse}
              reserved={metrics.memory.reserved}
              available={metrics.memory.available}
              formatValue={formatBytes}
              inUseLabel="actual current consumption"
              reservedLabel="allocated by deployments"
              availableLabel="subscription plan limit"
            />

            <div className="border-t border-gray-100 dark:border-gray-700" />

            <ResourceSection
              icon={<HardDrive size={16} className="text-emerald-500 dark:text-emerald-400" />}
              label="Storage"
              inUse={metrics.storage.inUse}
              reserved={metrics.storage.reserved}
              available={metrics.storage.available}
              formatValue={formatBytes}
              inUseLabel="actual disk space used"
              reservedLabel="PVC allocated capacity"
              availableLabel="subscription plan limit"
            />

            <div className="border-t border-gray-100 dark:border-gray-700" />

            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-400 dark:text-gray-500">
                Last updated: {relativeTime(metrics.lastUpdatedAt)}
              </span>
              <button
                onClick={() => refreshMetrics.mutate()}
                disabled={refreshMetrics.isPending}
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
                data-testid="refresh-metrics-button"
              >
                <RefreshCw size={12} className={refreshMetrics.isPending ? 'animate-spin' : ''} />
                Refresh
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Re-export compact formatters for use in Header tags
export { formatCpuCompact, formatBytesCompact };
