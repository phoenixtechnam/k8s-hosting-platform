import { useState } from 'react';
import { HardDrive, AlertTriangle, Loader2, Check, X } from 'lucide-react';
import clsx from 'clsx';
import { useNodeStorage, usePatchNodeDisk, type NodeDiskInfo } from '@/hooks/use-node-storage';

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(1)} TiB`;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MiB`;
  return `${bytes} B`;
}

function gibToBytes(gib: number): number {
  return Math.round(gib * 1024 ** 3);
}
function bytesToGib(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}

interface Props {
  readonly nodeName: string;
}

export default function NodeStorageCard({ nodeName }: Props) {
  const { data, isLoading, error } = useNodeStorage(nodeName);
  const disks = data?.data.disks ?? [];

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 px-5 py-3 text-xs text-gray-500 dark:text-gray-400">
        <Loader2 size={14} className="animate-spin" />
        Loading Longhorn disk inventory…
      </div>
    );
  }

  if (error || disks.length === 0) {
    // Either Longhorn isn't tracking this node yet, or it's a non-Longhorn node.
    // Suppress entirely — no actionable controls to show.
    return null;
  }

  return (
    <div className="border-t border-gray-100 px-5 py-4 dark:border-gray-700" data-testid={`node-storage-${nodeName}`}>
      <div className="mb-3 flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-200">
        <HardDrive size={14} />
        Longhorn disks
      </div>
      <div className="space-y-3">
        {disks.map((d) => (
          <DiskRow key={d.diskKey} nodeName={nodeName} disk={d} />
        ))}
      </div>
    </div>
  );
}

function DiskRow({ nodeName, disk }: { readonly nodeName: string; readonly disk: NodeDiskInfo }) {
  const [editing, setEditing] = useState(false);
  const [reservedGib, setReservedGib] = useState(bytesToGib(disk.storageReserved));
  const [allowScheduling, setAllowScheduling] = useState(disk.allowScheduling);
  const patch = usePatchNodeDisk(nodeName);

  const max = disk.storageMaximum;
  const sched = disk.storageScheduled;
  const reserved = disk.storageReserved;
  const free = disk.freeToSchedule;
  const usedPct = max > 0 ? Math.round(((sched + reserved) / max) * 100) : 0;

  // Over-provisioning: scheduled exceeds physical maximum minus reserved.
  // Longhorn allows over-provisioning by default (sum of replica sizes
  // can exceed disk capacity since most volumes don't fill).
  const overProvisioned = sched > Math.max(0, max - reserved);

  const tone =
    usedPct >= 90 ? 'bg-red-500'
      : usedPct >= 75 ? 'bg-amber-500'
        : 'bg-green-500';

  const onSave = (): void => {
    const reservedBytes = gibToBytes(parseFloat(reservedGib));
    if (Number.isNaN(reservedBytes) || reservedBytes < 0) return;
    const input: { storageReserved?: number; allowScheduling?: boolean } = {};
    if (reservedBytes !== reserved) input.storageReserved = reservedBytes;
    if (allowScheduling !== disk.allowScheduling) input.allowScheduling = allowScheduling;
    if (Object.keys(input).length === 0) {
      setEditing(false);
      return;
    }
    patch.mutate(
      { diskKey: disk.diskKey, input },
      { onSuccess: () => setEditing(false) },
    );
  };

  const onCancel = (): void => {
    setReservedGib(bytesToGib(reserved));
    setAllowScheduling(disk.allowScheduling);
    setEditing(false);
  };

  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm dark:border-gray-700 dark:bg-gray-900/40">
      <div className="flex items-center justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-gray-700 dark:text-gray-200" title={disk.path}>
              {disk.path}
            </span>
            {!disk.allowScheduling && (
              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                scheduling disabled
              </span>
            )}
            {disk.tags.length > 0 && (
              <span className="font-mono text-xs text-gray-500 dark:text-gray-400">
                tags: {disk.tags.join(',')}
              </span>
            )}
          </div>
          <div className="mt-0.5 text-xs tabular-nums text-gray-500 dark:text-gray-400">
            scheduled {formatBytes(sched)} · reserved {formatBytes(reserved)} · free {formatBytes(free)} / max {formatBytes(max)}
          </div>
        </div>
        {!editing ? (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-white dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
            data-testid={`disk-${disk.diskKey}-edit`}
          >
            Edit
          </button>
        ) : (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onSave}
              disabled={patch.isPending}
              className="inline-flex items-center gap-1 rounded bg-brand-500 px-2 py-1 text-xs text-white hover:bg-brand-600 disabled:opacity-50"
              data-testid={`disk-${disk.diskKey}-save`}
            >
              {patch.isPending ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
              Save
            </button>
            <button
              type="button"
              onClick={onCancel}
              disabled={patch.isPending}
              className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-white dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
              data-testid={`disk-${disk.diskKey}-cancel`}
            >
              <X size={12} /> Cancel
            </button>
          </div>
        )}
      </div>

      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
        <div className={clsx('h-full transition-all', tone)} style={{ width: `${Math.min(100, usedPct)}%` }} />
      </div>

      {(overProvisioned || usedPct >= 90) && (
        <div className="mt-2 flex items-start gap-1.5 rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200">
          <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
          <div>
            {overProvisioned && (
              <div>
                <span className="font-semibold">Over-provisioned:</span> sum of replica sizes ({formatBytes(sched)}) exceeds physical capacity minus reserved ({formatBytes(Math.max(0, max - reserved))}). New PVCs may fail to allocate if existing volumes fill.
              </div>
            )}
            {usedPct >= 90 && !overProvisioned && (
              <div>
                <span className="font-semibold">Capacity pressure:</span> {usedPct}% of physical capacity already scheduled or reserved. Consider scaling up storage before next provision.
              </div>
            )}
          </div>
        </div>
      )}

      {editing && (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <label className="text-xs text-gray-600 dark:text-gray-300">
            <span className="block">Reserved (GiB) — operator-only headroom</span>
            <input
              type="number"
              min="0"
              step="0.1"
              value={reservedGib}
              onChange={(e) => setReservedGib(e.target.value)}
              className="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
              data-testid={`disk-${disk.diskKey}-reserved-input`}
            />
          </label>
          <label className="text-xs text-gray-600 dark:text-gray-300">
            <span className="block">Scheduling</span>
            <label className="mt-1 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={allowScheduling}
                onChange={(e) => setAllowScheduling(e.target.checked)}
                data-testid={`disk-${disk.diskKey}-allow-scheduling`}
              />
              Allow new replicas on this disk
            </label>
          </label>
        </div>
      )}

      {patch.isError && (
        <div className="mt-2 text-xs text-red-700 dark:text-red-300">
          Patch failed: {(patch.error as Error).message}
        </div>
      )}
    </div>
  );
}
