import { useState, type FormEvent } from 'react';
import { Server, Plus, Loader2, AlertCircle, Trash2, X, Play, Square } from 'lucide-react';
import { useClientContext } from '@/hooks/use-client-context';
import { useWorkloads, useContainerImages, useCreateWorkload, useUpdateWorkload, useDeleteWorkload } from '@/hooks/use-workloads';

function StatusBadge({ status }: { readonly status: string }) {
  const colorMap: Record<string, string> = {
    running: 'bg-green-50 text-green-700 border-green-200 dark:bg-green-900/40 dark:text-green-300 dark:border-green-700',
    stopped: 'bg-gray-50 text-gray-600 border-gray-200 dark:bg-gray-700 dark:text-gray-400 dark:border-gray-600',
    pending: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-700',
    failed: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-900/40 dark:text-red-300 dark:border-red-700',
  };
  const colors = colorMap[status] ?? 'bg-gray-50 text-gray-600 border-gray-200 dark:bg-gray-700 dark:text-gray-400 dark:border-gray-600';
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${colors}`}>
      {status}
    </span>
  );
}

const INPUT_CLASS = 'w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500';

export default function Workloads() {
  const { clientId } = useClientContext();
  const { data: response, isLoading, isError, error } = useWorkloads(clientId ?? undefined);
  const { data: imagesResponse } = useContainerImages();
  const createWorkload = useCreateWorkload(clientId ?? undefined);
  const updateWorkload = useUpdateWorkload(clientId ?? undefined);
  const deleteWorkload = useDeleteWorkload(clientId ?? undefined);

  const workloads = response?.data ?? [];
  const images = imagesResponse?.data ?? [];

  const [showDeploy, setShowDeploy] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', image_id: '', replica_count: '1' });

  const handleDeploy = async (e: FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.image_id) return;
    try {
      await createWorkload.mutateAsync({
        name: form.name.trim(),
        image_id: form.image_id,
        replica_count: Number(form.replica_count) || 1,
      });
      setForm({ name: '', image_id: '', replica_count: '1' });
      setShowDeploy(false);
    } catch { /* error via createWorkload.error */ }
  };

  const handleDelete = async (id: string) => {
    try { await deleteWorkload.mutateAsync(id); setDeleteConfirmId(null); }
    catch { /* error via deleteWorkload.error */ }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-purple-50 text-purple-600 dark:bg-purple-900/40 dark:text-purple-400">
            <Server size={20} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100" data-testid="workloads-heading">Workloads</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400">Deploy and manage your applications.</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setShowDeploy((p) => !p)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
          data-testid="deploy-workload-button"
        >
          {showDeploy ? <X size={14} /> : <Plus size={14} />}
          {showDeploy ? 'Cancel' : 'Deploy'}
        </button>
      </div>

      {showDeploy && (
        <form onSubmit={handleDeploy} className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-4" data-testid="deploy-form">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <div>
              <label htmlFor="wl-name" className="block text-xs font-medium text-gray-700 dark:text-gray-300">Name</label>
              <input id="wl-name" type="text" className={INPUT_CLASS + ' mt-1'} placeholder="my-app" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required data-testid="deploy-name-input" />
            </div>
            <div>
              <label htmlFor="wl-image" className="block text-xs font-medium text-gray-700 dark:text-gray-300">Image</label>
              <select id="wl-image" className={INPUT_CLASS + ' mt-1'} value={form.image_id} onChange={(e) => setForm({ ...form, image_id: e.target.value })} required data-testid="deploy-image-select">
                <option value="">Select image...</option>
                {images.map((img) => <option key={img.id} value={img.id}>{img.name}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="wl-replicas" className="block text-xs font-medium text-gray-700 dark:text-gray-300">Replicas</label>
              <input id="wl-replicas" type="number" min={1} max={10} className={INPUT_CLASS + ' mt-1'} value={form.replica_count} onChange={(e) => setForm({ ...form, replica_count: e.target.value })} data-testid="deploy-replicas-input" />
            </div>
            <div className="flex items-end">
              <button type="submit" disabled={createWorkload.isPending} className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50" data-testid="submit-deploy">
                {createWorkload.isPending && <Loader2 size={14} className="animate-spin" />}
                Deploy
              </button>
            </div>
          </div>
          {createWorkload.error && (
            <div className="mt-3 flex items-center gap-2 text-sm text-red-600" data-testid="deploy-error">
              <AlertCircle size={14} />
              {createWorkload.error instanceof Error ? createWorkload.error.message : 'Failed to deploy'}
            </div>
          )}
        </form>
      )}

      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm">
        {isLoading && (
          <div className="flex items-center justify-center py-16" data-testid="workloads-loading">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-200 border-t-blue-600" />
            <span className="ml-3 text-sm text-gray-500 dark:text-gray-400">Loading workloads...</span>
          </div>
        )}

        {isError && (
          <div className="px-6 py-16 text-center" data-testid="workloads-error">
            <p className="text-sm text-red-600">Failed to load workloads: {error instanceof Error ? error.message : 'Unknown error'}</p>
          </div>
        )}

        {!isLoading && !isError && workloads.length === 0 && (
          <div className="px-6 py-16 text-center" data-testid="workloads-empty">
            <Server size={40} className="mx-auto text-gray-300 dark:text-gray-600" />
            <p className="mt-3 text-sm font-medium text-gray-900 dark:text-gray-100">No workloads yet</p>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Click "Deploy" to launch your first application.</p>
          </div>
        )}

        {!isLoading && !isError && workloads.length > 0 && (
          <div className="overflow-x-auto" data-testid="workloads-table">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/50">
                  <th className="px-6 py-3 font-medium text-gray-500 dark:text-gray-400">Name</th>
                  <th className="px-6 py-3 font-medium text-gray-500 dark:text-gray-400">Status</th>
                  <th className="px-6 py-3 font-medium text-gray-500 dark:text-gray-400">Replicas</th>
                  <th className="hidden px-6 py-3 font-medium text-gray-500 dark:text-gray-400 md:table-cell">CPU</th>
                  <th className="hidden px-6 py-3 font-medium text-gray-500 dark:text-gray-400 md:table-cell">Memory</th>
                  <th className="px-6 py-3 font-medium text-gray-500 dark:text-gray-400">Actions</th>
                </tr>
              </thead>
              <tbody>
                {workloads.map((w) => (
                  <tr key={w.id} className="border-b border-gray-100 dark:border-gray-700 last:border-0">
                    <td className="px-6 py-4 font-medium text-gray-900 dark:text-gray-100">{w.name}</td>
                    <td className="px-6 py-4"><StatusBadge status={w.status} /></td>
                    <td className="px-6 py-4 text-gray-600 dark:text-gray-400">{w.replicaCount}</td>
                    <td className="hidden px-6 py-4 text-gray-600 dark:text-gray-400 md:table-cell">{w.cpuRequest}</td>
                    <td className="hidden px-6 py-4 text-gray-600 dark:text-gray-400 md:table-cell">{w.memoryRequest}</td>
                    <td className="px-6 py-4">
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => updateWorkload.mutate({ workloadId: w.id, status: w.status === 'running' ? 'stopped' : 'running' })}
                          disabled={w.status === 'pending' || w.status === 'failed'}
                          className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1.5 text-xs text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 disabled:opacity-50"
                          title={w.status === 'running' ? 'Stop' : 'Start'}
                          data-testid={`toggle-workload-${w.id}`}
                        >
                          {w.status === 'running' ? <Square size={12} /> : <Play size={12} />}
                        </button>
                        {deleteConfirmId === w.id ? (
                          <>
                            <button type="button" onClick={() => handleDelete(w.id)} disabled={deleteWorkload.isPending} className="rounded-md bg-red-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50" data-testid={`confirm-delete-wl-${w.id}`}>Confirm</button>
                            <button type="button" onClick={() => setDeleteConfirmId(null)} className="rounded-md border border-gray-200 dark:border-gray-700 px-2.5 py-1.5 text-xs text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50">Cancel</button>
                          </>
                        ) : (
                          <button type="button" onClick={() => setDeleteConfirmId(w.id)} className="rounded-md border border-red-200 dark:border-red-700 bg-white dark:bg-gray-800 px-2 py-1.5 text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30" data-testid={`delete-workload-${w.id}`}>
                            <Trash2 size={12} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
