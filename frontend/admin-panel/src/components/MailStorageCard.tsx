import { HardDrive, AlertTriangle, Loader2 } from 'lucide-react';
import { useMailPvcStorage } from '@/hooks/use-mail-storage';

/**
 * Mail storage card — used bytes + node free disk only.
 *
 * Phase 3 streamline (2026-05-15): dropped the "PVC capacity" line and
 * the percentage donut. `requests.storage` is informational only on
 * local-path (the provisioner does NOT quota the request) so showing
 * "23% of 20 GiB used" misled operators into thinking the 20 GiB number
 * meant anything — it doesn't. The only meaningful sizing constraint is
 * the node's actual free disk on the local NVMe mount.
 *
 * We show:
 *   - Used (data dir, from `du -sb` exec probe)
 *   - Free  (from `df` on the same mount — bounded by node free disk)
 *   - Storage class
 *
 * If a future variant ever quotas mail storage (network volume, etc.),
 * add capacity + percentage donut behind a `quota_enabled` flag on the
 * MailPvcStorageResponse contract — but not before we have a real
 * quota mechanism.
 */
export default function MailStorageCard() {
  const storage = useMailPvcStorage();

  if (storage.isLoading) {
    return (
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm p-5">
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <Loader2 size={14} className="animate-spin" /> Loading storage…
        </div>
      </div>
    );
  }

  if (storage.isError || !storage.data) {
    return (
      <div className="rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-5">
        <div className="flex items-start gap-2.5">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-red-600" />
          <div className="text-sm text-red-700 dark:text-red-300">
            Could not read mail storage state.{' '}
            {storage.error instanceof Error ? storage.error.message : 'See server logs.'}
          </div>
        </div>
      </div>
    );
  }

  const data = storage.data.data;
  const usedBytes = data.usedBytes;
  const freeBytes = data.freeBytes;

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm p-5 space-y-3">
      <div className="flex items-center gap-3">
        <HardDrive size={20} className="text-gray-700 dark:text-gray-300" />
        <h2
          className="text-lg font-semibold text-gray-900 dark:text-gray-100"
          data-testid="mail-storage-heading"
        >
          Mail Storage
        </h2>
      </div>

      <p className="text-sm text-gray-600 dark:text-gray-400">
        Stalwart RocksDB DataStore lives on a local-path PVC
        (<code>{data.pvcName}</code>) on the active mail node's local NVMe.
        Storage growth is bounded by the node's free disk, not by a PVC quota.
      </p>

      <div className="grid grid-cols-3 gap-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-4">
        <Stat label="Used (data dir)">
          <span className="text-sm font-mono text-gray-900 dark:text-gray-100" data-testid="mail-storage-used">
            {formatBytes(usedBytes)}
          </span>
        </Stat>
        <Stat label="Free on node">
          <span className="text-sm font-mono text-gray-900 dark:text-gray-100" data-testid="mail-storage-free">
            {formatBytes(freeBytes)}
          </span>
        </Stat>
        <Stat label="Storage class">
          <span className="text-sm font-mono text-gray-700 dark:text-gray-300">
            {data.storageClass}
          </span>
        </Stat>
      </div>
    </div>
  );
}

function Stat({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <div className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
        {label}
      </div>
      <div>{children}</div>
    </div>
  );
}

function formatBytes(n: number | null): string {
  if (n == null || !Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}
