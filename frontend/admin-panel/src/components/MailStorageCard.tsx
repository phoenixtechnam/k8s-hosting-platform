import { useState } from 'react';
import {
  HardDrive,
  AlertTriangle,
  Loader2,
  Info,
  X,
  Check,
  ArrowDownToLine,
} from 'lucide-react';
import { useMailPvcStorage, useResizeMailPvc } from '@/hooks/use-mail-storage';
import { useStartMailMigration } from '@/hooks/use-mail-migration';
import { useMailPlacement } from '@/hooks/use-mail-placement';
import MailMigrationProgressModal from '@/components/MailMigrationProgressModal';

const STORAGE_WARN_PCT = 65;
const STORAGE_CRIT_PCT = 85;

export default function MailStorageCard() {
  const storage = useMailPvcStorage();
  const resize = useResizeMailPvc();
  const migrate = useStartMailMigration();
  const placement = useMailPlacement();

  const [newGiB, setNewGiB] = useState<string>('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [shrinkOpen, setShrinkOpen] = useState(false);
  const [shrinkGiB, setShrinkGiB] = useState<string>('');
  const [shrinkTarget, setShrinkTarget] = useState<string>('');
  const [postSuccess, setPostSuccess] = useState(false);
  const [migrationRunId, setMigrationRunId] = useState<string | null>(null);

  if (storage.isLoading) {
    return (
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm p-5">
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <Loader2 size={14} className="animate-spin" /> Loading mail storage…
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
            Could not read mail storage PVC state.{' '}
            {storage.error instanceof Error ? storage.error.message : 'See server logs.'}
          </div>
        </div>
      </div>
    );
  }

  const data = storage.data.data;
  const currentGiB = bytesToGiB(data.requestedBytes);
  const capacityGiB = bytesToGiB(data.capacityBytes);
  const expandingFs = data.requestedBytes > data.capacityBytes;
  const usedPct =
    data.usedBytes != null && data.capacityBytes > 0
      ? Math.round((data.usedBytes / data.capacityBytes) * 100)
      : null;

  const newGiBNum = Number.parseInt(newGiB, 10);
  const inputValid = Number.isInteger(newGiBNum) && newGiBNum >= 1 && newGiBNum <= 2048;
  const wouldShrink = inputValid && newGiBNum < currentGiB;
  const wouldNoOp = inputValid && newGiBNum === currentGiB;
  const canGrow = inputValid && !wouldShrink && !wouldNoOp && data.expansionAllowed && !resize.isPending;

  const candidates = placement.data?.data.candidateNodes ?? [];
  const shrinkGiBNum = Number.parseInt(shrinkGiB, 10);
  const shrinkValid = Number.isInteger(shrinkGiBNum) && shrinkGiBNum >= 1 && shrinkGiBNum < currentGiB;
  const canShrink = shrinkValid && !!shrinkTarget && !migrate.isPending;

  const storageWarn = usedPct != null && usedPct >= STORAGE_WARN_PCT;
  const storageCrit = usedPct != null && usedPct >= STORAGE_CRIT_PCT;

  async function handleShrink() {
    if (!shrinkTarget || !shrinkValid) return;
    try {
      const result = await migrate.mutateAsync({
        targetNode: shrinkTarget,
        newGiB: shrinkGiBNum,
        confirm: true,
      });
      setMigrationRunId(result.data.runId);
      setShrinkOpen(false);
      setShrinkGiB('');
      setShrinkTarget('');
    } catch {
      // surfaced via migrate.isError
    }
  }

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm p-5 space-y-4">
      <div className="flex items-center gap-3">
        <HardDrive size={20} className="text-gray-700 dark:text-gray-300" />
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100" data-testid="mail-storage-heading">
          Mail Server Storage
        </h2>
        <span className="rounded-full bg-blue-100 dark:bg-blue-900/30 px-2 py-0.5 text-xs font-semibold text-blue-700 dark:text-blue-300">
          RocksDB
        </span>
      </div>

      <p className="text-sm text-gray-600 dark:text-gray-400">
        Local-path PVC backing the Stalwart RocksDB DataStore (
        <code className="rounded bg-gray-100 dark:bg-gray-800 px-1">{data.pvcName}</code> in{' '}
        <code className="rounded bg-gray-100 dark:bg-gray-800 px-1">mail</code> namespace).
        Embedded, single-node — does not affect per-client mailbox storage.
      </p>

      {/* Utilization bar */}
      {usedPct != null && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-gray-600 dark:text-gray-400">Storage utilization</span>
            <span
              data-testid="mail-storage-used-pct"
              className={`font-semibold ${
                storageCrit
                  ? 'text-red-700 dark:text-red-300'
                  : storageWarn
                  ? 'text-amber-700 dark:text-amber-300'
                  : 'text-gray-700 dark:text-gray-300'
              }`}
            >
              {usedPct}%
            </span>
          </div>
          <div className="h-2 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${
                storageCrit
                  ? 'bg-red-500'
                  : storageWarn
                  ? 'bg-amber-500'
                  : 'bg-green-500'
              }`}
              style={{ width: `${Math.min(usedPct, 100)}%` }}
            />
          </div>
          {storageWarn && (
            <div
              role="alert"
              data-testid="mail-storage-warn-banner"
              className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 text-xs ${
                storageCrit
                  ? 'border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-200'
                  : 'border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-200'
              }`}
            >
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              <span>
                {storageCrit
                  ? `Critical: mail storage is ${usedPct}% full — grow or migrate to a larger PVC immediately.`
                  : `Warning: mail storage is ${usedPct}% full (threshold: ${STORAGE_WARN_PCT}%). Consider growing or migrating.`}
              </span>
            </div>
          )}
        </div>
      )}

      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-4 grid grid-cols-2 gap-3 text-sm">
        <KvRow label="Requested" value={`${currentGiB} GiB`} testId="mail-storage-requested" />
        <KvRow label="Capacity (live)" value={`${capacityGiB} GiB`} testId="mail-storage-capacity" />
        <KvRow
          label="Used"
          value={
            data.usedBytes != null
              ? `${formatBytes(data.usedBytes)} (${usedPct ?? '?'}%)`
              : 'unknown (df probe failed)'
          }
          testId="mail-storage-used"
        />
        <KvRow
          label="Free"
          value={data.freeBytes != null ? formatBytes(data.freeBytes) : 'unknown'}
          testId="mail-storage-free"
        />
        <KvRow label="StorageClass" value={data.storageClass} testId="mail-storage-sc" />
        <KvRow
          label="Last resized"
          value={data.lastResizedAt ? new Date(data.lastResizedAt).toLocaleString() : 'never'}
          testId="mail-storage-last-resized"
        />
      </div>

      {expandingFs && (
        <div
          role="status"
          data-testid="mail-storage-expanding"
          className="flex items-start gap-2.5 rounded-lg border border-blue-200 dark:border-blue-900/50 bg-blue-50 dark:bg-blue-900/20 px-3 py-2.5 text-sm text-blue-900 dark:text-blue-200"
        >
          <Loader2 size={14} className="mt-0.5 shrink-0 animate-spin" />
          <span>Filesystem expansion in progress — capacity will catch up within 30-120s.</span>
        </div>
      )}

      {!data.expansionAllowed && (
        <div className="flex items-start gap-2.5 rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 px-3 py-2.5 text-sm text-amber-800 dark:text-amber-200">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>
            StorageClass <code>{data.storageClass}</code> has{' '}
            <code>allowVolumeExpansion=false</code>. Grow is disabled. Use{' '}
            <em>Shrink / Migrate</em> below to move to a fresh PVC at a different size.
          </span>
        </div>
      )}

      {/* Grow section */}
      <div className="space-y-2">
        <label htmlFor="mail-pvc-new-size-gib" className="block text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
          Grow — new size (GiB) must be &gt; current {currentGiB} GiB
        </label>
        <div className="flex items-center gap-3">
          <input
            id="mail-pvc-new-size-gib"
            type="number"
            min={1}
            max={2048}
            step={1}
            value={newGiB}
            onChange={(e) => setNewGiB(e.target.value)}
            disabled={!data.expansionAllowed || resize.isPending}
            data-testid="mail-pvc-new-size-gib"
            placeholder={`${currentGiB + 10}`}
            className="w-32 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-1.5 text-sm font-mono text-gray-900 dark:text-gray-100 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
          />
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            disabled={!canGrow}
            data-testid="mail-pvc-resize-button"
            className="inline-flex items-center gap-2 rounded-lg border border-brand-500 bg-brand-500 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {resize.isPending ? <Loader2 size={14} className="animate-spin" /> : <HardDrive size={14} />}
            {resize.isPending ? 'Patching…' : 'Grow'}
          </button>
        </div>
        {wouldShrink && (
          <p className="text-xs text-amber-700 dark:text-amber-300" data-testid="mail-pvc-shrink-hint">
            To reduce size, use <strong>Shrink via migration</strong> below.
          </p>
        )}
        {wouldNoOp && (
          <p className="text-xs text-amber-700 dark:text-amber-300" data-testid="mail-pvc-no-op-warning">
            Already at {currentGiB} GiB — no change.
          </p>
        )}
      </div>

      {postSuccess && !resize.isPending && (
        <div
          role="status"
          data-testid="mail-pvc-resize-success"
          className="flex items-start gap-2.5 rounded-lg border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 px-3 py-2.5 text-sm text-green-800 dark:text-green-200"
        >
          <Check size={14} className="mt-0.5 shrink-0" />
          <span>Patch landed. Watch "Capacity (live)" above — converges within 30-120s.</span>
        </div>
      )}

      {resize.isError && (
        <div
          role="alert"
          data-testid="mail-pvc-resize-error"
          className="flex items-start gap-2.5 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2.5 text-sm text-red-700 dark:text-red-300"
        >
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>{resize.error instanceof Error ? resize.error.message : 'Resize failed — see server logs.'}</span>
        </div>
      )}

      {/* Shrink via migration */}
      <div className="border-t border-gray-200 dark:border-gray-700 pt-4 space-y-2">
        <button
          type="button"
          onClick={() => setShrinkOpen(!shrinkOpen)}
          className="flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100"
          data-testid="mail-pvc-shrink-toggle"
        >
          <ArrowDownToLine size={14} className="shrink-0" />
          Shrink / Migrate via rsync
        </button>

        {shrinkOpen && (
          <div className="space-y-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-4">
            <p className="text-xs text-gray-600 dark:text-gray-400">
              Creates a new local-path PVC at the target size, rsyncs data, then
              hot-swaps Stalwart. Stalwart is offline for the duration of the rsync.
              Works for both shrink and grow; also moves Stalwart to a new node.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                  Target size (GiB)
                </label>
                <input
                  type="number"
                  min={1}
                  max={2048}
                  step={1}
                  value={shrinkGiB}
                  onChange={(e) => setShrinkGiB(e.target.value)}
                  data-testid="mail-pvc-shrink-gib"
                  placeholder={`${Math.max(1, currentGiB - 5)}`}
                  className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-1.5 text-sm font-mono text-gray-900 dark:text-gray-100 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                  Target node
                </label>
                <select
                  value={shrinkTarget}
                  onChange={(e) => setShrinkTarget(e.target.value)}
                  data-testid="mail-pvc-shrink-target"
                  className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                >
                  <option value="">— same or different node —</option>
                  {candidates.map((c) => (
                    <option key={c.hostname} value={c.hostname}>
                      {c.hostname} ({bytesToGiB(c.freeDiskBytes)} GiB free)
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {shrinkValid && shrinkGiBNum < (data.usedBytes != null ? Math.ceil(data.usedBytes / (1024 ** 3)) + 2 : 0) && (
              <div className="flex items-start gap-2 text-xs text-red-700 dark:text-red-300">
                <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                Target size may be too small for the current data ({formatBytes(data.usedBytes ?? 0)} used).
              </div>
            )}
            <button
              type="button"
              onClick={handleShrink}
              disabled={!canShrink}
              data-testid="mail-pvc-shrink-button"
              className="inline-flex items-center gap-2 rounded-lg bg-amber-600 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {migrate.isPending ? <Loader2 size={14} className="animate-spin" /> : <ArrowDownToLine size={14} />}
              {migrate.isPending ? 'Starting migration…' : 'Start migration'}
            </button>
            {migrate.isError && (
              <div role="alert" className="flex items-start gap-2.5 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2.5 text-xs text-red-700 dark:text-red-300">
                <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                {migrate.error instanceof Error ? migrate.error.message : 'Migration failed — see server logs.'}
              </div>
            )}
          </div>
        )}
      </div>

      {confirmOpen && (
        <ResizeConfirmModal
          currentGiB={currentGiB}
          newGiB={newGiBNum}
          pending={resize.isPending}
          error={resize.error}
          onClose={() => {
            if (!resize.isPending) {
              setConfirmOpen(false);
              resize.reset();
            }
          }}
          onConfirm={async () => {
            try {
              await resize.mutateAsync({ newGiB: newGiBNum });
              setConfirmOpen(false);
              setPostSuccess(true);
              setNewGiB('');
              resize.reset();
              setTimeout(() => setPostSuccess(false), 8_000);
            } catch {
              // error surfaces via resize.error inside the modal
            }
          }}
        />
      )}

      {migrationRunId && (
        <MailMigrationProgressModal
          runId={migrationRunId}
          onClose={() => setMigrationRunId(null)}
        />
      )}
    </div>
  );
}

interface KvRowProps {
  readonly label: string;
  readonly value: string;
  readonly testId: string;
}
function KvRow({ label, value, testId }: KvRowProps) {
  return (
    <div className="space-y-0.5">
      <div className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
        {label}
      </div>
      <div data-testid={testId} className="font-mono text-sm text-gray-900 dark:text-gray-100">
        {value}
      </div>
    </div>
  );
}

interface ResizeConfirmModalProps {
  readonly currentGiB: number;
  readonly newGiB: number;
  readonly pending: boolean;
  readonly error: unknown;
  readonly onClose: () => void;
  readonly onConfirm: () => Promise<void>;
}
function ResizeConfirmModal({ currentGiB, newGiB, pending, error, onClose, onConfirm }: ResizeConfirmModalProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      data-testid="mail-pvc-resize-modal"
    >
      <div className="relative w-full max-w-md bg-white dark:bg-gray-900 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 p-6 space-y-4">
        <div className="flex items-start gap-3">
          <div className="shrink-0 rounded-full bg-blue-100 dark:bg-blue-900/30 p-2">
            <HardDrive size={20} className="text-blue-600" />
          </div>
          <div className="flex-1">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Grow mail storage to {newGiB} GiB?
            </h3>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
              Patches the PVC spec. The local-path CSI driver extends the volume online;
              Stalwart stays running. Filesystem converges within 30-120s.
            </p>
            <ul className="mt-2 ml-5 list-disc text-sm text-gray-600 dark:text-gray-400 space-y-1">
              <li>{currentGiB} GiB → {newGiB} GiB (+{newGiB - currentGiB} GiB)</li>
              <li>No restart, no downtime.</li>
              <li>To shrink, use <strong>Shrink / Migrate via rsync</strong>.</li>
            </ul>
          </div>
        </div>

        <div className="flex items-start gap-2 rounded-lg border border-blue-200 dark:border-blue-900/50 bg-blue-50 dark:bg-blue-900/20 px-3 py-2 text-xs text-blue-900 dark:text-blue-200">
          <Info size={12} className="mt-0.5 shrink-0" />
          <span>Capacity field may lag by 30-120s while the CSI driver extends + kubelet runs resize.</span>
        </div>

        {error != null && (
          <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-700 dark:text-red-300">
            {error instanceof Error ? error.message : 'Resize failed — see server logs.'}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            data-testid="mail-pvc-resize-cancel"
            className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            data-testid="mail-pvc-resize-confirm"
            className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-brand-700 disabled:opacity-50"
          >
            {pending && <Loader2 size={14} className="animate-spin" />}
            {pending ? 'Growing…' : 'Grow'}
          </button>
        </div>

        <button
          type="button"
          onClick={onClose}
          disabled={pending}
          aria-label="Close"
          className="absolute top-3 right-3 rounded-md p-1 text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

function bytesToGiB(b: number): number {
  return Math.round((b / 1024 ** 3) * 100) / 100;
}

function formatBytes(b: number): string {
  if (b >= 1024 ** 4) return `${(b / 1024 ** 4).toFixed(2)} TiB`;
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GiB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(2)} MiB`;
  if (b >= 1024) return `${(b / 1024).toFixed(2)} KiB`;
  return `${b} B`;
}
