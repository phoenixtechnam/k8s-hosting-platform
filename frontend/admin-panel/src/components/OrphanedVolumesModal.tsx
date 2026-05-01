import { useState } from 'react';
import {
  X, Trash2, Camera, Loader2, AlertTriangle, AlertCircle, RefreshCw, CheckCircle, Eraser,
} from 'lucide-react';
import {
  useOrphanedVolumes,
  useSnapshotOrphan,
  useDeleteOrphan,
  usePurgeAllOrphans,
} from '@/hooks/use-orphaned-volumes';
import type { OrphanedVolumeEntry, OrphanReason } from '@k8s-hosting/api-contracts';
import ErrorPanel from '@/components/ErrorPanel';
import { extractOperatorError } from '@/lib/extract-operator-error';

interface OrphanedVolumesModalProps {
  readonly onClose: () => void;
}

const REASON_LABELS: Record<OrphanReason, { label: string; explainer: string; tone: 'red' | 'amber' | 'gray' }> = {
  namespace_deleted: {
    label: 'Namespace deleted',
    explainer: 'The PV references a namespace that no longer exists.',
    tone: 'red',
  },
  client_record_deleted: {
    label: 'Client deleted',
    explainer: 'A client-* namespace exists but no matching client row in the platform DB.',
    tone: 'red',
  },
  pv_released_stale: {
    label: 'Released > threshold',
    explainer: 'PV stuck in Released phase past the stale threshold (default 7 days).',
    tone: 'amber',
  },
  longhorn_volume_unbound: {
    label: 'No PV',
    explainer: 'Longhorn volume CR exists but no PV references it.',
    tone: 'amber',
  },
  namespace_orphaned: {
    label: 'Namespace orphaned',
    explainer: 'A client-* namespace with no matching client row and no backing volume — typically a deprovision that left the namespace standing.',
    tone: 'red',
  },
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let n = bytes; let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 ? 2 : 1)} ${units[i]}`;
}

/**
 * Modal listing every orphaned PV / Longhorn volume cluster-wide.
 *
 * For each row the operator can:
 *   1. Take a Longhorn snapshot (recovery point before delete) — disabled
 *      after one snapshot succeeds in the current session so the operator
 *      doesn't accumulate spam snapshots by clicking twice.
 *   2. Delete (cascades PV + Longhorn volume CR) — guarded by an
 *      "Are you sure?" confirm dialog.
 */
export default function OrphanedVolumesModal({ onClose }: OrphanedVolumesModalProps) {
  const list = useOrphanedVolumes();
  const snap = useSnapshotOrphan();
  const del = useDeleteOrphan();
  const purge = usePurgeAllOrphans();
  const [confirmDelete, setConfirmDelete] = useState<OrphanedVolumeEntry | null>(null);
  const [confirmPurge, setConfirmPurge] = useState(false);
  const [snappedVolumes, setSnappedVolumes] = useState<Set<string>>(new Set());

  const orphans = list.data?.data.orphans ?? [];
  const total = list.data?.data.totalCount ?? 0;
  const totalBytes = list.data?.data.totalBytes ?? 0;
  const stale = list.data?.data.stalePvThresholdDays ?? 7;
  const purgeResult = purge.data?.data ?? null;

  const rowKey = (o: OrphanedVolumeEntry): string =>
    o.longhornVolumeName ?? o.pvName ?? `${o.namespace ?? '-'}/${o.pvcName ?? '-'}`;

  const handleSnapshot = async (entry: OrphanedVolumeEntry): Promise<void> => {
    if (!entry.longhornVolumeName) return; // button is hidden for these rows
    try {
      await snap.mutateAsync(entry.longhornVolumeName);
      setSnappedVolumes((prev) => new Set([...prev, entry.longhornVolumeName!]));
    } catch { /* surfaced below */ }
  };

  const handleDelete = async (): Promise<void> => {
    if (!confirmDelete) return;
    // Three call shapes:
    //   1) Longhorn-backed PV → DELETE /:volumeName?pvName=...
    //   2) Non-Longhorn PV    → DELETE /:pvName (fallback)
    //   3) namespace_orphaned → DELETE /by-namespace/:namespace
    try {
      if (confirmDelete.reason === 'namespace_orphaned') {
        if (!confirmDelete.namespace) {
          setConfirmDelete(null);
          return;
        }
        await del.mutateAsync({ namespace: confirmDelete.namespace });
      } else {
        const volumeName = confirmDelete.longhornVolumeName ?? confirmDelete.pvName;
        if (!volumeName) {
          setConfirmDelete(null);
          return;
        }
        await del.mutateAsync({
          volumeName,
          pvName: confirmDelete.pvName,
        });
      }
      setConfirmDelete(null);
    } catch { /* surfaced below */ }
  };

  const handlePurgeAll = async (): Promise<void> => {
    try {
      // Forward the same threshold the list query was fetched with so
      // the server's purge set matches the rows the operator saw.
      await purge.mutateAsync({ stalePvThresholdDays: stale });
      setConfirmPurge(false);
    } catch { /* surfaced below */ }
  };

  // Drop any prior purge result when the modal closes so the next open
  // doesn't show a stale "Purge: x/y deleted" panel.
  const handleClose = (): void => {
    purge.reset();
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 py-8"
      role="dialog"
      aria-modal="true"
      aria-labelledby="orphaned-volumes-modal-title"
      data-testid="orphaned-volumes-modal"
      onClick={handleClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-5xl rounded-xl bg-white shadow-xl dark:bg-gray-800 max-h-[calc(100vh-4rem)] overflow-y-auto"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <h2 id="orphaned-volumes-modal-title" className="text-base font-semibold text-gray-900 dark:text-gray-100">
              Manage Orphaned Volumes
            </h2>
            {!list.isLoading && (
              <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                {total} · {formatBytes(totalBytes)}
              </span>
            )}
            <button
              type="button"
              onClick={() => list.refetch()}
              disabled={list.isFetching}
              className="ml-1 rounded p-1 text-gray-500 hover:text-gray-700 disabled:opacity-50 dark:text-gray-400 dark:hover:text-gray-200"
              title="Refresh"
              aria-label="Refresh orphan list"
            >
              {list.isFetching ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setConfirmPurge(true)}
              disabled={total === 0 || purge.isPending}
              className="inline-flex items-center gap-1 rounded-md bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
              data-testid="orphans-purge-all-button"
            >
              {purge.isPending ? <Loader2 size={12} className="animate-spin" /> : <Eraser size={12} />}
              Purge All
            </button>
            <button
              type="button"
              onClick={handleClose}
              className="rounded-md p-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
              aria-label="Close"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="space-y-3 px-5 py-4 text-sm">
          {list.isLoading && (
            <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
              <Loader2 size={14} className="animate-spin" /> Scanning cluster…
            </div>
          )}

          {list.error && (
            <ErrorPanel
              error={extractOperatorError(list.error)}
              severity="error"
              compact
              testId="orphans-list-error"
            />
          )}

          {!list.isLoading && !list.error && orphans.length === 0 && (
            <div
              className="flex items-center gap-2 rounded-lg border border-green-300 bg-green-50 p-3 text-green-800 dark:border-green-700 dark:bg-green-900/30 dark:text-green-200"
              data-testid="orphans-empty"
            >
              <CheckCircle size={14} />
              No orphaned volumes detected.
            </div>
          )}

          {!list.isLoading && orphans.length > 0 && (
            <>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Stale-PV threshold: <strong>{stale} day{stale !== 1 ? 's' : ''}</strong>. Snapshot first if you might want to recover the data later — every delete is permanent.
              </p>

              <table className="w-full text-xs" data-testid="orphans-table">
                <thead className="text-gray-500 dark:text-gray-400">
                  <tr>
                    <th className="text-left py-1 pr-2">Owner</th>
                    <th className="text-left py-1 pr-2">PVC / Volume</th>
                    <th className="text-right py-1 pr-2">Size</th>
                    <th className="text-left py-1 pr-2">Node(s)</th>
                    <th className="text-left py-1 pr-2">Reason</th>
                    <th className="text-right py-1 pr-2">Age</th>
                    <th className="text-right py-1">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {orphans.map((o) => {
                    const reasonInfo = REASON_LABELS[o.reason];
                    const key = rowKey(o);
                    const lhName = o.longhornVolumeName;
                    const snapped = lhName ? snappedVolumes.has(lhName) : false;
                    const snapPending = snap.isPending && lhName !== null && (snap.variables === lhName);
                    return (
                      <tr
                        key={key}
                        className="border-t border-gray-200/60 dark:border-gray-700/40"
                        data-testid={`orphan-row-${key}`}
                      >
                        <td className="py-2 pr-2">{o.ownerLabel}</td>
                        <td className="py-2 pr-2 font-mono">
                          {o.reason === 'namespace_orphaned' && o.namespace ? (
                            <div>
                              <div>{o.namespace}</div>
                              <div className="text-[10px] text-gray-400">namespace · no PV</div>
                            </div>
                          ) : o.namespace && o.pvcName ? (
                            <div>
                              <div>{o.namespace}/{o.pvcName}</div>
                              <div className="text-[10px] text-gray-400">{lhName ?? o.pvName ?? key}</div>
                            </div>
                          ) : (
                            <span className="text-gray-500">{lhName ?? o.pvName ?? key}</span>
                          )}
                        </td>
                        <td className="py-2 pr-2 text-right tabular-nums">{formatBytes(o.sizeBytes)}</td>
                        <td className="py-2 pr-2 font-mono text-gray-500 dark:text-gray-400">
                          {o.nodes.length > 0 ? o.nodes.join(', ') : <span className="italic">none</span>}
                        </td>
                        <td className="py-2 pr-2">
                          <ReasonBadge reason={o.reason} title={reasonInfo.explainer} />
                        </td>
                        <td className="py-2 pr-2 text-right tabular-nums text-gray-500 dark:text-gray-400">
                          {o.ageDays !== null ? `${o.ageDays}d` : '—'}
                        </td>
                        <td className="py-2 text-right whitespace-nowrap">
                          {lhName && (
                            <button
                              type="button"
                              onClick={() => handleSnapshot(o)}
                              disabled={snapPending || snapped}
                              className="mr-1 inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-0.5 text-xs hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:hover:bg-gray-700/50"
                              data-testid={`orphan-snapshot-${key}`}
                            >
                              {snapPending ? <Loader2 size={10} className="animate-spin" /> : <Camera size={10} />}
                              {snapped ? 'Snapped' : 'Snapshot'}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => setConfirmDelete(o)}
                            className="inline-flex items-center gap-1 rounded bg-red-600 px-2 py-0.5 text-xs text-white hover:bg-red-700"
                            data-testid={`orphan-delete-${key}`}
                          >
                            <Trash2 size={10} /> Delete
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}

          {snap.error && (
            <ErrorPanel
              error={extractOperatorError(snap.error)}
              severity="error"
              compact
              testId="orphan-snapshot-error"
            />
          )}

          {/* Purge All result panel: shown only after a completed purge.
              Per-row failures are aggregated server-side so partial
              success surfaces here without rejecting the mutation. */}
          {purgeResult && (
            <div
              className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs dark:border-gray-700 dark:bg-gray-900/40"
              data-testid="orphans-purge-result"
            >
              <div className="font-medium text-gray-700 dark:text-gray-200">
                Purge: {purgeResult.deleted}/{purgeResult.attempted} deleted · {formatBytes(purgeResult.bytesReclaimed)} reclaimed
              </div>
              {purgeResult.failures.length > 0 && (
                <ul className="mt-1 space-y-0.5 text-amber-700 dark:text-amber-300">
                  {purgeResult.failures.map((f) => (
                    <li key={f.key} className="font-mono">
                      {f.key} ({f.reason}): {f.error}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {purge.error && (
            <ErrorPanel
              error={extractOperatorError(purge.error)}
              severity="error"
              compact
              testId="orphan-purge-error"
            />
          )}
        </div>

        {/* Confirm delete dialog */}
        {confirmDelete && (
          <div
            className="absolute inset-0 z-10 flex items-center justify-center bg-black/40 p-4"
            data-testid="orphan-confirm-delete"
          >
            <div className="w-full max-w-md rounded-xl border border-red-300 bg-white p-5 shadow-xl dark:border-red-700 dark:bg-gray-800">
              <h3 className="flex items-center gap-2 text-base font-semibold text-red-700 dark:text-red-300">
                <AlertTriangle size={16} /> Are you sure?
              </h3>
              {confirmDelete.reason === 'namespace_orphaned' ? (
                <p className="mt-2 text-sm text-gray-700 dark:text-gray-200">
                  This will permanently delete the Kubernetes namespace{' '}
                  <strong className="font-mono">{confirmDelete.namespace}</strong> and every
                  resource still inside it (configmaps, secrets, services, PVCs).
                  PVCs whose StorageClass uses <code>reclaimPolicy=Retain</code> may
                  resurface as Released-PV orphans on the next scan — purge again
                  to reclaim those.
                </p>
              ) : (
                <p className="mt-2 text-sm text-gray-700 dark:text-gray-200">
                  This will permanently delete the Persistent Volume <strong>{confirmDelete.pvName ?? '(none)'}</strong>{' '}
                  and Longhorn volume <strong className="font-mono">{confirmDelete.longhornVolumeName}</strong>{' '}
                  ({formatBytes(confirmDelete.sizeBytes)}). The data on every replica will be gone.
                </p>
              )}
              {confirmDelete.longhornVolumeName && !snappedVolumes.has(confirmDelete.longhornVolumeName) && (
                <div className="mt-2 flex items-start gap-1.5 rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200">
                  <AlertCircle size={12} className="mt-0.5 shrink-0" />
                  No snapshot was taken first — recovery will not be possible after delete.
                </div>
              )}
              {del.error && (
                <div className="mt-2">
                  <ErrorPanel
                    error={extractOperatorError(del.error)}
                    severity="error"
                    compact
                    testId="orphan-delete-error"
                  />
                </div>
              )}
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmDelete(null)}
                  className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={del.isPending}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                  data-testid="orphan-delete-confirm"
                >
                  {del.isPending ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                  Yes, delete
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Purge All confirm dialog. No per-row snapshot is taken — the
            operator opted to bulk-clean and any pre-snapshot would need
            to scan every row and is intentionally manual. */}
        {confirmPurge && (
          <div
            className="absolute inset-0 z-10 flex items-center justify-center bg-black/40 p-4"
            data-testid="orphan-confirm-purge"
          >
            <div className="w-full max-w-md rounded-xl border border-red-300 bg-white p-5 shadow-xl dark:border-red-700 dark:bg-gray-800">
              <h3 className="flex items-center gap-2 text-base font-semibold text-red-700 dark:text-red-300">
                <AlertTriangle size={16} /> Purge every orphan?
              </h3>
              <p className="mt-2 text-sm text-gray-700 dark:text-gray-200">
                This will cascade-delete{' '}
                <strong>{total}</strong> orphan{total === 1 ? '' : 's'}{' '}
                (~<strong>{formatBytes(totalBytes)}</strong>) — every Persistent Volume,
                Longhorn volume CR, and orphaned namespace currently in the list. No
                snapshots will be taken. The data is unrecoverable.
              </p>
              <div className="mt-2 flex items-start gap-1.5 rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200">
                <AlertCircle size={12} className="mt-0.5 shrink-0" />
                Per-row failures will be reported below the list. The purge will not
                abort if a single delete fails.
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmPurge(false)}
                  disabled={purge.isPending}
                  className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handlePurgeAll}
                  disabled={purge.isPending}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                  data-testid="orphan-purge-confirm"
                >
                  {purge.isPending ? <Loader2 size={12} className="animate-spin" /> : <Eraser size={12} />}
                  Yes, purge all
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ReasonBadge({ reason, title }: { readonly reason: OrphanReason; readonly title: string }) {
  const info = REASON_LABELS[reason];
  const cls =
    info.tone === 'red'
      ? 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300'
      : info.tone === 'amber'
        ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
        : 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300';
  return (
    <span className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium ${cls}`} title={title}>
      {info.label}
    </span>
  );
}
