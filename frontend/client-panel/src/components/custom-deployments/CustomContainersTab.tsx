// "Custom Containers" tab content inside Applications.tsx.
//
// Lists every custom-source deployment for the current client with
// a lazy-loaded "Updates available?" pill, an action menu (Restart /
// Upgrade tag / Manage PAT / Delete), and two top-right "New …"
// buttons that open the simple-form wizard or the compose editor.
//
// The check-updates-batch query fires once on mount (per render of
// this tab) and the result lives in TanStack Query's cache; the
// backend already serves stale results from its 60-min cache row.

import { useMemo, useState } from 'react';
import { AlertCircle, ArrowUpCircle, FileText, Loader2, MoreVertical, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import {
  useCustomDeployments,
  useCheckUpdatesBatch,
  useDeleteCustomDeployment,
  useUpdateCustomDeployment,
  useUpgradeTag,
  type CustomDeploymentRow,
} from '@/hooks/use-custom-deployments';
import { getStatusColor } from '@/lib/status-colors';
import { SimpleContainerWizard } from './SimpleContainerWizard';
import { ComposeEditor } from './ComposeEditor';
import { PrivateRegistryPanel } from './PrivateRegistryPanel';
import { UpdatesPill } from './UpdatesPill';

interface CustomContainersTabProps {
  readonly clientId: string;
  readonly canManage: boolean;
}

type ActiveModal =
  | { kind: 'none' }
  | { kind: 'simple-wizard' }
  | { kind: 'compose-editor' }
  | { kind: 'pat'; row: CustomDeploymentRow }
  | { kind: 'upgrade'; row: CustomDeploymentRow };

export function CustomContainersTab({ clientId, canManage }: CustomContainersTabProps) {
  const [activeModal, setActiveModal] = useState<ActiveModal>({ kind: 'none' });
  const [actionMenuOpen, setActionMenuOpen] = useState<string | null>(null);

  const { data, isLoading, error, refetch } = useCustomDeployments(clientId);
  const rows = useMemo(() => data?.data ?? [], [data]);

  // Lazy: fire the batch check once on mount, scoped to currently-
  // visible deployments. Cache TTL is 30 min in the hook, matching
  // the backend's 60-min server cache.
  const deploymentIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const updatesQuery = useCheckUpdatesBatch(clientId, deploymentIds);

  const deleteMutation = useDeleteCustomDeployment(clientId);
  const restartMutation = useUpdateCustomDeployment(clientId);

  const onRestart = (row: CustomDeploymentRow) => {
    setActionMenuOpen(null);
    restartMutation.mutate({ id: row.id, restart: true });
  };

  const onDelete = (row: CustomDeploymentRow) => {
    setActionMenuOpen(null);
    if (!confirm(`Delete custom deployment "${row.name}"? This removes the Pod, Services, and any stored PAT. Volume data on the tenant PVC is preserved.`)) {
      return;
    }
    deleteMutation.mutate(row.id);
  };

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => setActiveModal({ kind: 'simple-wizard' })}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
            data-testid="custom-new-container"
          >
            New Container
          </button>
          <button
            type="button"
            onClick={() => setActiveModal({ kind: 'compose-editor' })}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
            data-testid="custom-new-stack"
          >
            <FileText size={14} />
            New Stack (compose)
          </button>
        </div>
      )}

      {isLoading && (
        <div className="flex items-center justify-center gap-2 py-12 text-sm text-gray-500 dark:text-gray-400">
          <Loader2 size={16} className="animate-spin" />
          Loading custom containers…
        </div>
      )}
      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <div>
            <strong>Failed to load custom containers.</strong>
            <div>{error instanceof Error ? error.message : String(error)}</div>
          </div>
        </div>
      )}

      {!isLoading && !error && rows.length === 0 && (
        <EmptyState canManage={canManage} onSimple={() => setActiveModal({ kind: 'simple-wizard' })} onCompose={() => setActiveModal({ kind: 'compose-editor' })} />
      )}

      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
          <table className="min-w-full divide-y divide-gray-200 text-sm dark:divide-gray-700" data-testid="custom-deployments-table">
            <thead className="bg-gray-50 dark:bg-gray-800">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-700 dark:text-gray-300">Name</th>
                <th className="px-4 py-3 text-left font-medium text-gray-700 dark:text-gray-300">Mode</th>
                <th className="px-4 py-3 text-left font-medium text-gray-700 dark:text-gray-300">Image / Services</th>
                <th className="px-4 py-3 text-left font-medium text-gray-700 dark:text-gray-300">Status</th>
                <th className="px-4 py-3 text-left font-medium text-gray-700 dark:text-gray-300">Updates</th>
                <th className="px-4 py-3 text-right font-medium text-gray-700 dark:text-gray-300">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white dark:divide-gray-700 dark:bg-gray-900">
              {rows.map((row) => {
                const serviceCount = Object.keys(row.customSpec?.services ?? {}).length;
                const firstImage = Object.values(row.customSpec?.services ?? {})[0]?.image;
                const updates = updatesQuery.data?.data.results?.[row.id];
                return (
                  <tr key={row.id} data-testid={`custom-row-${row.id}`}>
                    <td className="px-4 py-3 font-medium text-gray-900 dark:text-gray-100">{row.name}</td>
                    <td className="px-4 py-3 text-gray-700 dark:text-gray-300">{row.customSpec?.sourceMode ?? '—'}</td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-700 dark:text-gray-300">
                      {row.customSpec?.sourceMode === 'compose' ? `${serviceCount} services` : firstImage ?? '—'}
                    </td>
                    <td className="px-4 py-3">
                      <span className={clsx('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', getStatusColor(row.status))}>
                        {row.status}
                      </span>
                      {row.lastError && (
                        <div className="mt-1 text-xs text-red-600 dark:text-red-400" title={row.lastError}>
                          {row.lastError.slice(0, 80)}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <UpdatesPill
                        result={updates}
                        loading={updatesQuery.isLoading}
                        canManage={canManage}
                        onUpgrade={() => setActiveModal({ kind: 'upgrade', row })}
                      />
                    </td>
                    <td className="px-4 py-3 text-right">
                      {canManage && (
                        <div className="relative inline-block">
                          <button
                            type="button"
                            onClick={() => setActionMenuOpen(actionMenuOpen === row.id ? null : row.id)}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
                            data-testid={`custom-actions-${row.id}`}
                          >
                            <MoreVertical size={16} />
                          </button>
                          {actionMenuOpen === row.id && (
                            <div className="absolute right-0 z-10 mt-1 w-48 rounded-md border border-gray-200 bg-white py-1 text-sm shadow-lg dark:border-gray-600 dark:bg-gray-800">
                              <button
                                type="button"
                                onClick={() => onRestart(row)}
                                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
                              >
                                <RefreshCw size={14} /> Restart
                              </button>
                              {row.customSpec?.sourceMode === 'simple' && (
                                <button
                                  type="button"
                                  onClick={() => { setActionMenuOpen(null); setActiveModal({ kind: 'upgrade', row }); }}
                                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
                                >
                                  <ArrowUpCircle size={14} /> Upgrade tag
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => { setActionMenuOpen(null); setActiveModal({ kind: 'pat', row }); }}
                                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
                              >
                                <Pencil size={14} /> Manage PAT
                              </button>
                              <button
                                type="button"
                                onClick={() => onDelete(row)}
                                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
                              >
                                <Trash2 size={14} /> Delete
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {activeModal.kind === 'simple-wizard' && (
        <SimpleContainerWizard
          clientId={clientId}
          existingNames={rows.map((r) => r.name)}
          onClose={() => setActiveModal({ kind: 'none' })}
          onCreated={() => { setActiveModal({ kind: 'none' }); refetch(); }}
        />
      )}
      {activeModal.kind === 'compose-editor' && (
        <ComposeEditor
          clientId={clientId}
          existingNames={rows.map((r) => r.name)}
          onClose={() => setActiveModal({ kind: 'none' })}
          onCreated={() => { setActiveModal({ kind: 'none' }); refetch(); }}
        />
      )}
      {activeModal.kind === 'pat' && (
        <PrivateRegistryPanel
          clientId={clientId}
          deploymentId={activeModal.row.id}
          deploymentName={activeModal.row.name}
          onClose={() => setActiveModal({ kind: 'none' })}
        />
      )}
      {activeModal.kind === 'upgrade' && (
        <UpgradeTagModal
          clientId={clientId}
          row={activeModal.row}
          suggestedImage={
            (() => {
              const s = Object.values(activeModal.row.customSpec?.services ?? {})[0];
              const updates = updatesQuery.data?.data.results?.[activeModal.row.id];
              if (s && updates?.latest && updates.status !== 'unknown' && updates.status !== 'no-update') {
                // Replace the tag in `image:1.0.0` with the new tag.
                const idx = s.image.lastIndexOf(':');
                return idx > 0 && !s.image.includes('@') ? `${s.image.slice(0, idx)}:${updates.latest}` : s.image;
              }
              return s?.image ?? '';
            })()
          }
          onClose={() => setActiveModal({ kind: 'none' })}
        />
      )}
    </div>
  );
}

// ─── Empty state ────────────────────────────────────────────────────────────

function EmptyState({ canManage, onSimple, onCompose }: { canManage: boolean; onSimple: () => void; onCompose: () => void }) {
  return (
    <div className="rounded-lg border border-dashed border-gray-300 px-6 py-12 text-center dark:border-gray-700">
      <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">No custom containers yet</h3>
      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
        Run any Docker image or compose stack alongside your catalog applications. Data lives on your tenant PVC; private registries are supported via PAT.
      </p>
      {canManage && (
        <div className="mt-4 flex justify-center gap-2">
          <button
            type="button"
            onClick={onSimple}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            New Container
          </button>
          <button
            type="button"
            onClick={onCompose}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            <FileText size={14} />
            New Stack (compose)
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Upgrade-tag modal (inline — small enough not to warrant a file) ────────

function UpgradeTagModal({
  clientId,
  row,
  suggestedImage,
  onClose,
}: {
  clientId: string;
  row: CustomDeploymentRow;
  suggestedImage: string;
  onClose: () => void;
}) {
  const [image, setImage] = useState(suggestedImage);
  const [error, setError] = useState<string | null>(null);
  const mutation = useUpgradeTag(clientId);

  const submit = async () => {
    setError(null);
    try {
      await mutation.mutateAsync({ id: row.id, image });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upgrade failed');
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl dark:bg-gray-900">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Upgrade tag</h3>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Replace the image for <span className="font-mono">{row.name}</span>. The Pod restarts immediately.
        </p>
        <label className="mt-4 block text-sm font-medium text-gray-700 dark:text-gray-300">New image</label>
        <input
          type="text"
          className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
          value={image}
          onChange={(e) => setImage(e.target.value)}
          placeholder="nginx:1.27.5"
          autoFocus
        />
        {error && <div className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</div>}
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={mutation.isPending || !image.trim()}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {mutation.isPending ? 'Upgrading…' : 'Upgrade'}
          </button>
        </div>
      </div>
    </div>
  );
}
