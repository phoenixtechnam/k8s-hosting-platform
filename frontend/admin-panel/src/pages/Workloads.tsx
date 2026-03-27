import { useState, useMemo, type FormEvent } from 'react';
import { Server, Container, Rocket, Search, Loader2, AlertCircle, RefreshCw, Plus, Trash2, X, Play, Square } from 'lucide-react';
import clsx from 'clsx';
import StatCard from '@/components/ui/StatCard';
import StatusBadge from '@/components/ui/StatusBadge';
import SearchableClientSelect from '@/components/ui/SearchableClientSelect';
import WorkloadRepoSettings from '@/components/WorkloadRepoSettings';
import { useContainerImages } from '@/hooks/use-container-images';
import { useWorkloadRepos, useSyncWorkloadRepo } from '@/hooks/use-workload-repos';
import { useWorkloads, useCreateWorkload, useUpdateWorkload, useDeleteWorkload } from '@/hooks/use-workloads';

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
  const createWorkload = useCreateWorkload(selectedClientId ?? undefined);
  const updateWorkload = useUpdateWorkload(selectedClientId ?? undefined);
  const deleteWorkload = useDeleteWorkload(selectedClientId ?? undefined);
  const { data: imagesResponse } = useContainerImages();

  const workloads = response?.data ?? [];
  const images = imagesResponse?.data ?? [];

  const [showDeploy, setShowDeploy] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deployForm, setDeployForm] = useState({
    name: '',
    image_id: '',
    replica_count: '1',
    cpu_request: '0.25',
    memory_request: '256Mi',
  });

  const handleDeploy = async (e: FormEvent) => {
    e.preventDefault();
    if (!deployForm.name.trim() || !deployForm.image_id) return;
    try {
      await createWorkload.mutateAsync({
        name: deployForm.name.trim(),
        image_id: deployForm.image_id,
        replica_count: Number(deployForm.replica_count) || 1,
        cpu_request: deployForm.cpu_request || '0.25',
        memory_request: deployForm.memory_request || '256Mi',
      });
      setDeployForm({ name: '', image_id: '', replica_count: '1', cpu_request: '0.25', memory_request: '256Mi' });
      setShowDeploy(false);
    } catch { /* error via createWorkload.error */ }
  };

  const handleDelete = async (id: string) => {
    try { await deleteWorkload.mutateAsync(id); setDeleteConfirmId(null); }
    catch { /* error via deleteWorkload.error */ }
  };

  const handleToggleStatus = (id: string, currentStatus: string) => {
    const newStatus = currentStatus === 'running' ? 'stopped' : 'running';
    updateWorkload.mutate({ workloadId: id, status: newStatus as 'running' | 'stopped' });
  };

  return (
    <div className="space-y-4" data-testid="deployed-tab">
      <div className="flex items-center gap-3">
        <SearchableClientSelect
          selectedClientId={selectedClientId}
          onSelect={setSelectedClientId}
          placeholder="Search clients..."
        />
        {selectedClientId && (
          <button
            type="button"
            onClick={() => setShowDeploy((p) => !p)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-2 text-sm font-medium text-white hover:bg-brand-600"
            data-testid="deploy-workload-button"
          >
            {showDeploy ? <X size={14} /> : <Plus size={14} />}
            {showDeploy ? 'Cancel' : 'Deploy Workload'}
          </button>
        )}
      </div>

      {showDeploy && selectedClientId && (
        <form onSubmit={handleDeploy} className="rounded-lg border border-gray-200 bg-gray-50 p-4" data-testid="deploy-form">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-5">
            <div>
              <label htmlFor="wl-name" className="block text-xs font-medium text-gray-700">Name</label>
              <input id="wl-name" type="text" className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="my-app" value={deployForm.name} onChange={(e) => setDeployForm({ ...deployForm, name: e.target.value })} required data-testid="deploy-name-input" />
            </div>
            <div>
              <label htmlFor="wl-image" className="block text-xs font-medium text-gray-700">Image</label>
              <select id="wl-image" className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" value={deployForm.image_id} onChange={(e) => setDeployForm({ ...deployForm, image_id: e.target.value })} required data-testid="deploy-image-select">
                <option value="">Select image...</option>
                {images.map((img) => <option key={img.id} value={img.id}>{img.name}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="wl-replicas" className="block text-xs font-medium text-gray-700">Replicas</label>
              <input id="wl-replicas" type="number" min={1} max={10} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" value={deployForm.replica_count} onChange={(e) => setDeployForm({ ...deployForm, replica_count: e.target.value })} data-testid="deploy-replicas-input" />
            </div>
            <div>
              <label htmlFor="wl-cpu" className="block text-xs font-medium text-gray-700">CPU</label>
              <input id="wl-cpu" type="text" className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" value={deployForm.cpu_request} onChange={(e) => setDeployForm({ ...deployForm, cpu_request: e.target.value })} data-testid="deploy-cpu-input" />
            </div>
            <div className="flex items-end">
              <button type="submit" disabled={createWorkload.isPending} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50" data-testid="submit-deploy">
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
                  <th className="px-5 py-3 text-right">Actions</th>
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
                    <td className="px-5 py-3.5 text-right">
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => handleToggleStatus(workload.id, workload.status)}
                          disabled={workload.status === 'pending' || workload.status === 'failed'}
                          className="rounded-md border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                          title={workload.status === 'running' ? 'Stop' : 'Start'}
                          data-testid={`toggle-workload-${workload.id}`}
                        >
                          {workload.status === 'running' ? <Square size={12} /> : <Play size={12} />}
                        </button>
                        {deleteConfirmId === workload.id ? (
                          <>
                            <button type="button" onClick={() => handleDelete(workload.id)} disabled={deleteWorkload.isPending} className="rounded-md bg-red-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50" data-testid={`confirm-delete-wl-${workload.id}`}>Confirm</button>
                            <button type="button" onClick={() => setDeleteConfirmId(null)} className="rounded-md border border-gray-200 px-2.5 py-1.5 text-xs text-gray-600 hover:bg-gray-50">Cancel</button>
                          </>
                        ) : (
                          <button type="button" onClick={() => setDeleteConfirmId(workload.id)} className="rounded-md border border-red-200 bg-white px-2 py-1.5 text-xs text-red-600 hover:bg-red-50" data-testid={`delete-workload-${workload.id}`}>
                            <Trash2 size={12} />
                          </button>
                        )}
                      </div>
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
  const [expandedImageId, setExpandedImageId] = useState<string | null>(null);
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

                  const isExpanded = expandedImageId === image.id;
                  const resourceCpu = imageRecord.resourceCpu as string | undefined;
                  const resourceMemory = imageRecord.resourceMemory as string | undefined;
                  const minPlan = imageRecord.minPlan as string | undefined;
                  const hasDockerfile = imageRecord.hasDockerfile as number | undefined;
                  const envVars = imageRecord.envVars as Record<string, string>[] | undefined;

                  return (
                    <tr key={image.id} className="transition-colors hover:bg-gray-50 cursor-pointer" onClick={() => setExpandedImageId(isExpanded ? null : image.id)}>
                      <td colSpan={5} className="p-0">
                        <div className="flex items-center">
                          <div className="flex-1 px-5 py-3.5">
                            <div className="flex items-center gap-2">
                              <Container size={14} className="text-gray-400" />
                              <span className="font-medium text-gray-900">{image.name}</span>
                              {tags && tags.length > 0 && (
                                <div className="flex gap-1">{tags.map((tag) => (
                                  <span key={tag} className="inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500">{tag}</span>
                                ))}</div>
                              )}
                            </div>
                          </div>
                          <div className="px-5 py-3.5 text-sm text-gray-600">{image.imageType}</div>
                          <div className="hidden px-5 py-3.5 text-sm font-mono text-gray-500 md:block">{image.registryUrl ?? '—'}</div>
                          <div className="px-5 py-3.5 text-sm text-gray-600">{sourceName}</div>
                          <div className="px-5 py-3.5"><StatusBadge status={image.status as 'active' | 'pending' | 'error'} /></div>
                        </div>
                        {isExpanded && (
                          <div className="border-t border-gray-100 bg-gray-50 px-5 py-4" data-testid={`image-detail-${image.id}`}>
                            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                              <div><span className="text-xs font-medium text-gray-500">CPU</span><p className="text-sm text-gray-900">{resourceCpu ?? 'Default'}</p></div>
                              <div><span className="text-xs font-medium text-gray-500">Memory</span><p className="text-sm text-gray-900">{resourceMemory ?? 'Default'}</p></div>
                              <div><span className="text-xs font-medium text-gray-500">Min Plan</span><p className="text-sm text-gray-900">{minPlan ?? 'Any'}</p></div>
                              <div><span className="text-xs font-medium text-gray-500">Dockerfile</span><p className="text-sm text-gray-900">{hasDockerfile ? 'Yes' : 'No'}</p></div>
                            </div>
                            {envVars && envVars.length > 0 && (
                              <div className="mt-3">
                                <span className="text-xs font-medium text-gray-500">Environment Variables</span>
                                <div className="mt-1 flex flex-wrap gap-1">{envVars.map((v, i) => (
                                  <span key={i} className="rounded bg-gray-200 px-2 py-0.5 text-xs font-mono text-gray-700">{Object.keys(v)[0]}</span>
                                ))}</div>
                              </div>
                            )}
                            <div className="mt-3"><span className="text-xs font-medium text-gray-500">Code</span><p className="text-sm font-mono text-gray-700">{image.code}</p></div>
                          </div>
                        )}
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
