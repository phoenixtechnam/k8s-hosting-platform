import { useState, type FormEvent } from 'react';
import { GitBranch, Plus, Loader2, Trash2, RefreshCw, AlertCircle, X } from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';
import {
  useWorkloadRepos,
  useAddWorkloadRepo,
  useDeleteWorkloadRepo,
  useSyncWorkloadRepo,
  useRestoreDefaultRepo,
} from '@/hooks/use-workload-repos';
import { useSortable } from '@/hooks/use-sortable';
import SortableHeader from '@/components/ui/SortableHeader';

const INPUT_CLASS =
  'mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2.5 text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-700 placeholder:text-gray-400 dark:placeholder:text-gray-500 dark:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

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
  const restoreDefault = useRestoreDefaultRepo();

  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [branch, setBranch] = useState('main');
  const [authToken, setAuthToken] = useState('');
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<{ id: string; message: string } | null>(null);

  const repos = response?.data ?? [];
  const { sortedData: sortedRepos, sortKey, sortDirection, onSort } = useSortable(repos, 'name');
  const hasDefaultRepo = repos.some((r) =>
    r.url.includes('phoenixtechnam/hosting-platform-workload-catalog'),
  );

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
    setSyncError(null);
    try {
      await syncRepo.mutateAsync(id);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Sync failed';
      setSyncError({ id, message });
    } finally {
      setSyncingId(null);
    }
  };

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm" data-testid="workload-repos-section">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <GitBranch size={20} className="text-gray-600 dark:text-gray-400" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Workload Repositories</h2>
        </div>
        <div className="flex items-center gap-2">
          {!hasDefaultRepo && !isLoading && (
            <button
              type="button"
              onClick={() => restoreDefault.mutate()}
              disabled={restoreDefault.isPending}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 disabled:opacity-50"
              data-testid="restore-default-repo-button"
            >
              {restoreDefault.isPending ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              Restore Default
            </button>
          )}
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
      </div>

      {showForm && (
        <form
          className="mb-4 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-4"
          onSubmit={handleAddSubmit}
          data-testid="add-repo-form"
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="repo-name" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
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
              <label htmlFor="repo-url" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
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
              <label htmlFor="repo-branch" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
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
              <label htmlFor="repo-token" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
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
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2.5" data-testid="add-repo-error">
              <AlertCircle size={16} className="mt-0.5 shrink-0 text-red-500 dark:text-red-400" />
              <p className="text-sm text-red-700 dark:text-red-400">
                {addRepo.error instanceof Error ? addRepo.error.message : 'Failed to add repository. Check the URL, branch, and auth token.'}
              </p>
            </div>
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
          <span className="ml-2 text-sm text-gray-500 dark:text-gray-400">Loading repositories...</span>
        </div>
      )}

      {isError && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-700 dark:text-red-400" data-testid="repos-error">
          <AlertCircle size={16} />
          <span>Failed to load repositories: {error?.message ?? 'Unknown error'}</span>
        </div>
      )}

      {!isLoading && !isError && (
        <div className="overflow-x-auto">
          <table className="w-full" data-testid="repos-table">
            <thead>
              <tr className="border-b border-gray-100 dark:border-gray-700 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                <SortableHeader label="Name" sortKey="name" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
                <SortableHeader label="URL" sortKey="url" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
                <SortableHeader label="Branch" sortKey="branch" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
                <SortableHeader label="Last Synced" sortKey="lastSyncedAt" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="hidden md:table-cell" />
                <SortableHeader label="Status" sortKey="status" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {sortedRepos.map((repo) => (
                <tr key={repo.id} className="transition-colors hover:bg-gray-50 dark:hover:bg-gray-700/50">
                  <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100">{repo.name}</td>
                  <td className="px-4 py-3 text-sm font-mono text-gray-600 dark:text-gray-400 max-w-xs truncate">{repo.url}</td>
                  <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">{repo.branch}</td>
                  <td className="hidden px-4 py-3 text-sm text-gray-500 dark:text-gray-400 md:table-cell">
                    {formatSyncTime(repo.lastSyncedAt)}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge
                      status={mapRepoStatusToBadge(repo.status)}
                      label={repo.status === 'syncing' ? 'Syncing' : undefined}
                    />
                    {repo.status === 'error' && repo.lastError && (
                      <p className="mt-1 max-w-xs truncate text-xs text-red-500 dark:text-red-400" title={repo.lastError}>
                        {repo.lastError}
                      </p>
                    )}
                    {syncError?.id === repo.id && (
                      <p className="mt-1 max-w-xs truncate text-xs text-red-500 dark:text-red-400" data-testid={`sync-error-${repo.id}`} title={syncError.message}>
                        {syncError.message}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="inline-flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleSync(repo.id)}
                        disabled={syncingId === repo.id || repo.status === 'syncing'}
                        className="inline-flex items-center gap-1 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2.5 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 disabled:opacity-50"
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
                            className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2.5 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50"
                            data-testid={`cancel-delete-repo-${repo.id}`}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setDeleteConfirmId(repo.id)}
                          className="inline-flex items-center gap-1 rounded-md border border-red-200 dark:border-red-800 bg-white dark:bg-gray-800 px-2.5 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
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
                  <td colSpan={6} className="px-4 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
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
