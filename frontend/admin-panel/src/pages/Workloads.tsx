import { useState, useMemo } from 'react';
import { Server, Container, Rocket, Search, Loader2, AlertCircle, RefreshCw } from 'lucide-react';
import clsx from 'clsx';
import StatCard from '@/components/ui/StatCard';
import StatusBadge from '@/components/ui/StatusBadge';
import SearchableClientSelect from '@/components/ui/SearchableClientSelect';
import WorkloadRepoSettings from '@/components/WorkloadRepoSettings';
import { useContainerImages } from '@/hooks/use-container-images';
import { useWorkloadRepos, useSyncWorkloadRepo } from '@/hooks/use-workload-repos';
import { useWorkloads } from '@/hooks/use-workloads';

type Tab = 'deployed' | 'available' | 'repos';

const TABS: readonly { readonly id: Tab; readonly label: string }[] = [
  { id: 'deployed', label: 'Deployed Workloads' },
  { id: 'available', label: 'Available Workloads' },
  { id: 'repos', label: 'Repositories' },
] as const;

export default function Workloads() {
  const [activeTab, setActiveTab] = useState<Tab>('deployed');

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Server size={28} className="text-brand-500" />
        <h1 className="text-2xl font-bold text-gray-900">Workloads</h1>
      </div>

      <div className="border-b border-gray-200">
        <nav className="-mb-px flex gap-6" data-testid="tab-bar">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={clsx(
                'whitespace-nowrap border-b-2 px-1 py-3 text-sm font-medium transition-colors',
                activeTab === tab.id
                  ? 'border-brand-500 text-brand-600'
                  : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700',
              )}
              data-testid={`tab-${tab.id}`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {activeTab === 'deployed' && <DeployedWorkloadsTab />}
      {activeTab === 'available' && <AvailableWorkloadsTab />}
      {activeTab === 'repos' && <RepositoriesTab />}
    </div>
  );
}

function DeployedWorkloadsTab() {
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
  const { data: response, isLoading, isError, error } = useWorkloads(selectedClientId ?? undefined);

  const workloads = response?.data ?? [];

  return (
    <div className="space-y-4" data-testid="deployed-tab">
      <div className="flex items-center gap-3">
        <SearchableClientSelect
          selectedClientId={selectedClientId}
          onSelect={setSelectedClientId}
          placeholder="Search clients..."
        />
      </div>

      {!selectedClientId && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 px-5 py-10 text-center text-sm text-gray-500" data-testid="select-client-prompt">
          Select a client to view their deployed workloads.
        </div>
      )}

      {selectedClientId && isLoading && (
        <div className="flex items-center justify-center py-12" data-testid="loading-spinner">
          <Loader2 size={24} className="animate-spin text-brand-500" />
          <span className="ml-2 text-sm text-gray-500">Loading workloads...</span>
        </div>
      )}

      {selectedClientId && isError && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" data-testid="error-message">
          <AlertCircle size={16} />
          <span>Failed to load workloads: {error?.message ?? 'Unknown error'}</span>
        </div>
      )}

      {selectedClientId && !isLoading && !isError && (
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full" data-testid="workloads-table">
              <thead>
                <tr className="border-b border-gray-100 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  <th className="px-5 py-3">Name</th>
                  <th className="px-5 py-3">Image</th>
                  <th className="px-5 py-3">Status</th>
                  <th className="px-5 py-3">Replicas</th>
                  <th className="hidden px-5 py-3 md:table-cell">CPU</th>
                  <th className="hidden px-5 py-3 md:table-cell">Memory</th>
                  <th className="hidden px-5 py-3 lg:table-cell">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {workloads.map((workload) => (
                  <tr key={workload.id} className="transition-colors hover:bg-gray-50">
                    <td className="px-5 py-3.5 font-medium text-gray-900">{workload.name}</td>
                    <td className="px-5 py-3.5 text-sm text-gray-600">{workload.containerImageId ?? '—'}</td>
                    <td className="px-5 py-3.5">
                      <StatusBadge status={workload.status} />
                    </td>
                    <td className="px-5 py-3.5 text-sm text-gray-600">{workload.replicaCount}</td>
                    <td className="hidden px-5 py-3.5 text-sm text-gray-600 md:table-cell">{workload.cpuRequest}</td>
                    <td className="hidden px-5 py-3.5 text-sm text-gray-600 md:table-cell">{workload.memoryRequest}</td>
                    <td className="hidden px-5 py-3.5 text-sm text-gray-500 lg:table-cell">
                      {new Date(workload.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
                {workloads.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-5 py-10 text-center text-sm text-gray-500">
                      No deployed workloads for this client.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="border-t border-gray-100 px-5 py-3 text-sm text-gray-500">
            {workloads.length} workload{workloads.length !== 1 ? 's' : ''}
          </div>
        </div>
      )}
    </div>
  );
}

function AvailableWorkloadsTab() {
  const [search, setSearch] = useState('');
  const [repoFilter, setRepoFilter] = useState('');
  const [isSyncingAll, setIsSyncingAll] = useState(false);
  const { data: response, isLoading, isError, error } = useContainerImages();
  const { data: reposResponse } = useWorkloadRepos();
  const syncRepo = useSyncWorkloadRepo();

  const images = response?.data ?? [];
  const repos = reposResponse?.data ?? [];

  const repoMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const repo of repos) {
      map.set(repo.id, repo.name);
    }
    return map;
  }, [repos]);

  const handleSyncAll = async () => {
    setIsSyncingAll(true);
    try {
      await Promise.allSettled(repos.map((repo) => syncRepo.mutateAsync(repo.id)));
    } finally {
      setIsSyncingAll(false);
    }
  };

  const filteredImages = useMemo(() => {
    let result = images;

    if (search.trim()) {
      const term = search.toLowerCase();
      result = result.filter(
        (img) =>
          img.name.toLowerCase().includes(term) ||
          img.code.toLowerCase().includes(term),
      );
    }

    if (repoFilter) {
      result = result.filter((img) => {
        const imageRecord = img as unknown as Record<string, unknown>;
        const sourceRepoId = imageRecord.source_repo_id as string | undefined;
        return sourceRepoId === repoFilter;
      });
    }

    return result;
  }, [search, repoFilter, images]);

  return (
    <div className="space-y-4" data-testid="available-tab">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard title="Total Images" value={images.length} icon={Container} accent="brand" />
        <StatCard title="Active Workloads" value={12} icon={Server} accent="green" />
        <StatCard title="Deployments Today" value={3} icon={Rocket} accent="amber" />
      </div>

      <div className="flex items-center gap-3">
        <div className="relative max-w-sm flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="search"
            placeholder="Search images..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border border-gray-200 bg-white py-2 pl-9 pr-4 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            data-testid="image-search"
          />
        </div>
        {repos.length > 0 && (
          <select
            value={repoFilter}
            onChange={(e) => setRepoFilter(e.target.value)}
            className="rounded-lg border border-gray-200 bg-white py-2 pl-3 pr-8 text-sm text-gray-700 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            data-testid="repo-filter"
          >
            <option value="">All repositories</option>
            {repos.map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repo.name}
              </option>
            ))}
          </select>
        )}
        {repos.length > 0 && (
          <button
            type="button"
            onClick={handleSyncAll}
            disabled={isSyncingAll}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            data-testid="sync-all-button"
          >
            <RefreshCw size={14} className={isSyncingAll ? 'animate-spin' : ''} />
            Sync All
          </button>
        )}
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-12" data-testid="loading-spinner">
          <Loader2 size={24} className="animate-spin text-brand-500" />
          <span className="ml-2 text-sm text-gray-500">Loading images...</span>
        </div>
      )}

      {isError && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" data-testid="error-message">
          <AlertCircle size={16} />
          <span>Failed to load container images: {error?.message ?? 'Unknown error'}</span>
        </div>
      )}

      {!isLoading && !isError && (
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full" data-testid="images-table">
              <thead>
                <tr className="border-b border-gray-100 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  <th className="px-5 py-3">Name</th>
                  <th className="px-5 py-3">Type</th>
                  <th className="hidden px-5 py-3 md:table-cell">Registry URL</th>
                  <th className="px-5 py-3">Source</th>
                  <th className="px-5 py-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filteredImages.map((image) => {
                  const imageRecord = image as unknown as Record<string, unknown>;
                  const sourceRepoId = imageRecord.source_repo_id as string | undefined;
                  const sourceName = sourceRepoId ? repoMap.get(sourceRepoId) ?? 'Repository' : 'Built-in';
                  const tags = imageRecord.tags as readonly string[] | undefined;

                  return (
                    <tr key={image.id} className="transition-colors hover:bg-gray-50">
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-2">
                          <Container size={14} className="text-gray-400" />
                          <span className="font-medium text-gray-900">{image.name}</span>
                          {tags && tags.length > 0 && (
                            <div className="flex gap-1">
                              {tags.map((tag) => (
                                <span
                                  key={tag}
                                  className="inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500"
                                >
                                  {tag}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="px-5 py-3.5 text-sm text-gray-600">{image.imageType}</td>
                      <td className="hidden px-5 py-3.5 text-sm font-mono text-gray-500 md:table-cell">
                        {image.registryUrl ?? '—'}
                      </td>
                      <td className="px-5 py-3.5 text-sm text-gray-600" data-testid="image-source">
                        {sourceName}
                      </td>
                      <td className="px-5 py-3.5">
                        <StatusBadge status={image.status as 'active' | 'pending' | 'error'} />
                      </td>
                    </tr>
                  );
                })}
                {filteredImages.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-5 py-10 text-center text-sm text-gray-500">
                      No images found matching your search.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="border-t border-gray-100 px-5 py-3 text-sm text-gray-500">
            {filteredImages.length} image{filteredImages.length !== 1 ? 's' : ''}
          </div>
        </div>
      )}
    </div>
  );
}

function RepositoriesTab() {
  return (
    <div data-testid="repos-tab">
      <WorkloadRepoSettings />
    </div>
  );
}
