import { useState, useMemo } from 'react';
import { Server, Container, Rocket, Search, Loader2, AlertCircle, RefreshCw } from 'lucide-react';
import StatCard from '@/components/ui/StatCard';
import StatusBadge from '@/components/ui/StatusBadge';
import { useContainerImages } from '@/hooks/use-container-images';
import { useWorkloadRepos, useSyncWorkloadRepo } from '@/hooks/use-workload-repos';

export default function Workloads() {
  const [search, setSearch] = useState('');
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
    if (!search.trim()) return images;
    const term = search.toLowerCase();
    return images.filter(
      (img) =>
        img.name.toLowerCase().includes(term) ||
        img.code.toLowerCase().includes(term),
    );
  }, [search, images]);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Server size={28} className="text-brand-500" />
        <h1 className="text-2xl font-bold text-gray-900">Workloads</h1>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard title="Total Images" value={images.length} icon={Container} accent="brand" />
        <StatCard title="Active Workloads" value={12} icon={Server} accent="green" />
        <StatCard title="Deployments Today" value={3} icon={Rocket} accent="amber" />
      </div>

      <div className="space-y-4">
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
    </div>
  );
}
