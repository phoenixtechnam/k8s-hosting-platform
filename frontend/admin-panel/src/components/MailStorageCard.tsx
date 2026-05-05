import { useState } from 'react';
import {
  HardDrive,
  AlertTriangle,
  Loader2,
  Info,
  X,
  Check,
} from 'lucide-react';
import { useMailPvcStorage, useResizeMailPvc } from '@/hooks/use-mail-storage';

/**
 * Email Management → Mail Server Storage card.
 *
 * Renders the live mail-pg-1 PVC state (requested + capacity + used)
 * and lets a super_admin grow the PVC online (Longhorn supports it
 * without a Stalwart/PG restart).
 *
 * Three explicit reject paths are surfaced from the backend with
 * operator-actionable error text:
 *   - MAIL_PVC_SHRINK_NOT_SUPPORTED
 *   - MAIL_PVC_SAME_SIZE
 *   - STORAGE_CLASS_NO_EXPANSION
 *
 * The PATCH returns immediately after the K8s patch lands; capacity
 * convergence takes 30-120s (Longhorn extend + kubelet fs grow). The
 * card auto-refetches every poll-tick while requested > capacity so
 * the user sees the convergence happen.
 */
export default function MailStorageCard() {
  const storage = useMailPvcStorage();
  const resize = useResizeMailPvc();
  const [newGiB, setNewGiB] = useState<string>('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [postSuccess, setPostSuccess] = useState(false);

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
            Could not read mail-pg-1 PVC state.{' '}
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
  const usedPct = data.usedBytes != null && data.capacityBytes > 0
    ? Math.round((data.usedBytes / data.capacityBytes) * 100)
    : null;

  const newGiBNum = Number.parseInt(newGiB, 10);
  const inputValid = Number.isInteger(newGiBNum) && newGiBNum >= 1 && newGiBNum <= 2048;
  const wouldShrink = inputValid && newGiBNum < currentGiB;
  const wouldNoOp = inputValid && newGiBNum === currentGiB;
  const canSubmit =
    inputValid && !wouldShrink && !wouldNoOp && data.expansionAllowed && !resize.isPending;

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm p-5 space-y-4">
      <div className="flex items-center gap-3">
        <HardDrive size={20} className="text-gray-700 dark:text-gray-300" />
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100" data-testid="mail-storage-heading">
          Mail Server Storage
        </h2>
      </div>

      <p className="text-sm text-gray-600 dark:text-gray-400">
        Persistent volume backing the platform mail database
        (<code className="rounded bg-gray-100 dark:bg-gray-800 px-1">mail-pg-1</code> in{' '}
        <code className="rounded bg-gray-100 dark:bg-gray-800 px-1">mail</code> namespace).
        Single-tenant — does not affect per-client mailbox storage.
      </p>

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

      {expandingFs ? (
        <div
          role="status"
          data-testid="mail-storage-expanding"
          className="flex items-start gap-2.5 rounded-lg border border-blue-200 dark:border-blue-900/50 bg-blue-50 dark:bg-blue-900/20 px-3 py-2.5 text-sm text-blue-900 dark:text-blue-200"
        >
          <Loader2 size={14} className="mt-0.5 shrink-0 animate-spin" />
          <span>
            Filesystem expansion in progress — Longhorn extending volume + kubelet
            running <code>xfs_growfs</code>/<code>resize2fs</code>. Capacity will catch
            up within 30-120s.
          </span>
        </div>
      ) : null}

      {!data.expansionAllowed ? (
        <div className="flex items-start gap-2.5 rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 px-3 py-2.5 text-sm text-amber-800 dark:text-amber-200">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>
            StorageClass <code>{data.storageClass}</code> has{' '}
            <code>allowVolumeExpansion=false</code>. Resize is disabled — operator must
            change the SC before this card becomes usable.
          </span>
        </div>
      ) : null}

      <div className="space-y-2">
        <label htmlFor="mail-pvc-new-size-gib" className="block text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
          New size (GiB) — must be greater than current {currentGiB} GiB
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
            placeholder={`${currentGiB + 5}`}
            className="w-32 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-1.5 text-sm font-mono text-gray-900 dark:text-gray-100 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
          />
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            disabled={!canSubmit}
            data-testid="mail-pvc-resize-button"
            className="inline-flex items-center gap-2 rounded-lg border border-brand-500 bg-brand-500 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {resize.isPending ? <Loader2 size={14} className="animate-spin" /> : <HardDrive size={14} />}
            {resize.isPending ? 'Patching…' : 'Resize'}
          </button>
        </div>
        {wouldShrink ? (
          <p className="text-xs text-red-700 dark:text-red-300" data-testid="mail-pvc-shrink-warning">
            Shrinking is NOT supported — would require snapshot+restore into a fresh smaller cluster.
          </p>
        ) : null}
        {wouldNoOp ? (
          <p className="text-xs text-amber-700 dark:text-amber-300" data-testid="mail-pvc-no-op-warning">
            Already at {currentGiB} GiB — no change.
          </p>
        ) : null}
      </div>

      {postSuccess && !resize.isPending ? (
        <div
          role="status"
          data-testid="mail-pvc-resize-success"
          className="flex items-start gap-2.5 rounded-lg border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 px-3 py-2.5 text-sm text-green-800 dark:text-green-200"
        >
          <Check size={14} className="mt-0.5 shrink-0" />
          <span>
            Patch landed. Watch &quot;Capacity (live)&quot; above — it converges to the new
            value once Longhorn + kubelet finish.
          </span>
        </div>
      ) : null}

      {resize.isError ? (
        <div
          role="alert"
          data-testid="mail-pvc-resize-error"
          className="flex items-start gap-2.5 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2.5 text-sm text-red-700 dark:text-red-300"
        >
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>
            {resize.error instanceof Error ? resize.error.message : 'Resize failed — see server logs.'}
          </span>
        </div>
      ) : null}

      {confirmOpen ? (
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
      ) : null}
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
function ResizeConfirmModal({
  currentGiB,
  newGiB,
  pending,
  error,
  onClose,
  onConfirm,
}: ResizeConfirmModalProps) {
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
              Resize mail-pg-1 storage to {newGiB} GiB?
            </h3>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
              Online expansion via Longhorn — Stalwart and PG stay running throughout.
              The new size lands as <code>requests.storage</code> on the PVC; Longhorn
              extends the underlying volume and kubelet grows the filesystem within
              30-120s.
            </p>
            <ul className="mt-2 ml-5 list-disc text-sm text-gray-600 dark:text-gray-400 space-y-1">
              <li>Current: {currentGiB} GiB → new: {newGiB} GiB ({newGiB - currentGiB > 0 ? '+' : ''}{newGiB - currentGiB} GiB)</li>
              <li>No restart, no downtime.</li>
              <li><strong>Shrinking is NOT supported.</strong> This is one-way.</li>
            </ul>
          </div>
        </div>

        <div className="flex items-start gap-2 rounded-lg border border-blue-200 dark:border-blue-900/50 bg-blue-50 dark:bg-blue-900/20 px-3 py-2 text-xs text-blue-900 dark:text-blue-200">
          <Info size={12} className="mt-0.5 shrink-0" />
          <span>
            Capacity field above will lag by 30-120s while Longhorn extends + kubelet
            runs <code>xfs_growfs</code>/<code>resize2fs</code>. Refresh the page to see convergence.
          </span>
        </div>

        {error ? (
          <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-700 dark:text-red-300">
            {error instanceof Error ? error.message : 'Resize failed — see server logs.'}
          </div>
        ) : null}

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
            {pending ? 'Resizing…' : 'Resize'}
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
