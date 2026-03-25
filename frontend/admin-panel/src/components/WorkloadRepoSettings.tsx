import { useState, type FormEvent } from 'react';
import { GitBranch, Plus, Loader2, Trash2, RefreshCw, AlertCircle, X } from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';
import {
  useWorkloadRepos,
  useAddWorkloadRepo,
  useDeleteWorkloadRepo,
  useSyncWorkloadRepo,
} from '@/hooks/use-workload-repos';

const INPUT_CLASS =
  'mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

function formatSyncTime(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  const date = new Date(dateStr);
  return date.toLocaleString();
}

function mapRepoStatusToBadge(status: 'active' | 'error' | 'syncing'): 'active' | 'error' | 'pending' {
  if (status === 'syncing') return 'pending';
  return status;
}

export default function WorkloadRepoSettings() {
  const { data: response, isLoading, isError, error } = useWorkloadRepos();
  const addRepo = useAddWorkloadRepo();
  const deleteRepo = useDeleteWorkloadRepo();
  const syncRepo = useSyncWorkloadRepo();

  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [branch, setBranch] = useState('main');
  const [authToken, setAuthToken] = useState('');
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);

  const repos = response?.data ?? [];

  const handleAddSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !url.trim()) return;

    try {
      await addRepo.mutateAsync({
        name: name.trim(),
        url: url.trim(),
        branch: branch.trim() || 'main',
        auth_token: authToken.trim() || undefined,
      });
      setName('');
      setUrl('');
      setBranch('main');
      setAuthToken('');
      setShowForm(false);
    } catch {
      // Error is available via addRepo.error
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteRepo.mutateAsync(id);
      setDeleteConfirmId(null);
    } catch {
      // Error is available via deleteRepo.error
    }
  };

  const handleSync = async (id: string) => {
    setSyncingId(id);
    try {
      await syncRepo.mutateAsync(id);
    } catch {
      // Error is available via syncRepo.error
    } finally {
      setSyncingId(null);
    }
  };

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm" data-testid="workload-repos-section">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <GitBranch size={20} className="text-gray-600" />
          <h2 className="text-lg font-semibold text-gray-900">Workload Repositories</h2>
        </div>
        <button
          type="button"
          onClick={() => setShowForm((prev) => !prev)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-2 text-sm font-medium text-white hover:bg-brand-600"
          data-testid="add-repo-button"
        >
          {showForm ? <X size={14} /> : <Plus size={14} />}
          {showForm ? 'Cancel' : 'Add Repository'}
        </button>
      </div>

      {showForm && (
        <form
          className="mb-4 rounded-lg border border-gray-200 bg-gray-50 p-4"
          onSubmit={handleAddSubmit}
          data-testid="add-repo-form"
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="repo-name" className="block text-sm font-medium text-gray-700">
                Name
              </label>
              <input
                id="repo-name"
                type="text"
                className={INPUT_CLASS}
                placeholder="my-workloads"
                value={name}
                onChange={(e) => setName(e.target.value)}
                data-testid="repo-name-input"
                required
              />
            </div>
            <div>
              <label htmlFor="repo-url" className="block text-sm font-medium text-gray-700">
                URL
              </label>
              <input
                id="repo-url"
                type="text"
                className={INPUT_CLASS}
                placeholder="https://github.com/org/repo"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                data-testid="repo-url-input"
                required
              />
            </div>
            <div>
              <label htmlFor="repo-branch" className="block text-sm font-medium text-gray-700">
                Branch
              </label>
              <input
                id="repo-branch"
                type="text"
                className={INPUT_CLASS}
                placeholder="main"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                data-testid="repo-branch-input"
              />
            </div>
            <div>
              <label htmlFor="repo-token" className="block text-sm font-medium text-gray-700">
                Auth Token <span className="text-xs text-gray-400">(optional, for private repos)</span>
              </label>
              <input
                id="repo-token"
                type="password"
                className={INPUT_CLASS}
                placeholder="ghp_xxxxxxxxxxxx"
                value={authToken}
                onChange={(e) => setAuthToken(e.target.value)}
                data-testid="repo-token-input"
              />
            </div>
          </div>
          {addRepo.error && (
            <p className="mt-2 text-sm text-red-600" data-testid="add-repo-error">
              {addRepo.error instanceof Error ? addRepo.error.message : 'Failed to add repository'}
            </p>
          )}
          <div className="mt-3 flex justify-end">
            <button
              type="submit"
              disabled={addRepo.isPending}
              className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
              data-testid="submit-repo-button"
            >
              {addRepo.isPending && <Loader2 size={14} className="animate-spin" />}
              Add Repository
            </button>
          </div>
        </form>
      )}

      {isLoading && (
        <div className="flex items-center justify-center py-8" data-testid="repos-loading">
          <Loader2 size={20} className="animate-spin text-brand-500" />
          <span className="ml-2 text-sm text-gray-500">Loading repositories...</span>
        </div>
      )}

      {isError && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" data-testid="repos-error">
          <AlertCircle size={16} />
          <span>Failed to load repositories: {error?.message ?? 'Unknown error'}</span>
        </div>
      )}

      {!isLoading && !isError && (
        <div className="overflow-x-auto">
          <table className="w-full" data-testid="repos-table">
            <thead>
              <tr className="border-b border-gray-100 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">URL</th>
                <th className="px-4 py-3">Branch</th>
                <th className="hidden px-4 py-3 md:table-cell">Last Synced</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {repos.map((repo) => (
                <tr key={repo.id} className="transition-colors hover:bg-gray-50">
                  <td className="px-4 py-3 text-sm font-medium text-gray-900">{repo.name}</td>
                  <td className="px-4 py-3 text-sm font-mono text-gray-600 max-w-xs truncate">{repo.url}</td>
                  <td className="px-4 py-3 text-sm text-gray-600">{repo.branch}</td>
                  <td className="hidden px-4 py-3 text-sm text-gray-500 md:table-cell">
                    {formatSyncTime(repo.lastSyncedAt)}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge
                      status={mapRepoStatusToBadge(repo.status)}
                      label={repo.status === 'syncing' ? 'Syncing' : undefined}
                    />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="inline-flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleSync(repo.id)}
                        disabled={syncingId === repo.id || repo.status === 'syncing'}
                        className="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                        title="Sync repository"
                        data-testid={`sync-repo-${repo.id}`}
                      >
                        <RefreshCw
                          size={12}
                          className={syncingId === repo.id ? 'animate-spin' : ''}
                        />
                        Sync
                      </button>
                      {deleteConfirmId === repo.id ? (
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => handleDelete(repo.id)}
                            disabled={deleteRepo.isPending}
                            className="inline-flex items-center gap-1 rounded-md bg-red-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                            data-testid={`confirm-delete-repo-${repo.id}`}
                          >
                            {deleteRepo.isPending && <Loader2 size={12} className="animate-spin" />}
                            Confirm
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeleteConfirmId(null)}
                            className="rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
                            data-testid={`cancel-delete-repo-${repo.id}`}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setDeleteConfirmId(repo.id)}
                          className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-2.5 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50"
                          title="Delete repository"
                          data-testid={`delete-repo-${repo.id}`}
                        >
                          <Trash2 size={12} />
                          Delete
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {repos.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-sm text-gray-500">
                    No workload repositories configured. Add one to get started.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
