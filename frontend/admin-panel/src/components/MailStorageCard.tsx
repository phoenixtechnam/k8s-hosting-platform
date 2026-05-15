import { HardDrive, AlertTriangle, Loader2 } from 'lucide-react';
import { useMailPvcStorage } from '@/hooks/use-mail-storage';

/**
 * Read-only mail-server storage card.
 *
 * The 2026-05-14 streamline removed the online-grow PATCH because the
 * Stalwart PVC is local-path-only (local-path does not quota
 * `requests.storage` — it's informational only after creation, so
 * resize was never a meaningful operation post-RocksDB-migration).
 *
 * Phase-5 of the streamline will fold this card into a unified
 * "Storage & Blob Store" section. For now it shows just the live
 * data-dir bytes-used and the PVC's reported capacity.
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
  const used = data.usedBytes ?? 0;
  const cap = data.capacityBytes ?? 0;
  const pct = cap > 0 ? Math.round((used / cap) * 100) : 0;
  const dotColor =
    pct < 70 ? 'bg-green-500'
    : pct < 90 ? 'bg-amber-500'
    : 'bg-red-500';

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
        (<code>{data.pvcName}</code>). local-path doesn't enforce or
        quota the requested storage size — these numbers report what
        the data dir is using on the node's local NVMe.
      </p>

      <div className="grid grid-cols-2 gap-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-4">
        <Stat label="Used (data dir)">
          <span className="text-sm font-mono text-gray-900 dark:text-gray-100">
            {formatBytes(used)}
          </span>
        </Stat>
        <Stat label="PVC capacity (informational)">
          <span className="text-sm font-mono text-gray-900 dark:text-gray-100">
            {formatBytes(cap)}
          </span>
        </Stat>
        <Stat label="Usage">
          <div className="flex items-center gap-1.5">
            <span className={`inline-block w-2 h-2 rounded-full ${dotColor}`} />
            <span className="text-sm font-mono text-gray-900 dark:text-gray-100">
              {pct}%
            </span>
          </div>
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

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}
