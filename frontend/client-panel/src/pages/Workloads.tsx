import { useState, useMemo, type FormEvent } from 'react';
import { Server, Container, Search, Loader2, AlertCircle, Plus, Trash2, X, Play, Square, Cpu, Heart, Settings2, Rocket } from 'lucide-react';
import clsx from 'clsx';
import { useClientContext } from '@/hooks/use-client-context';
import { useCatalog } from '@/hooks/use-catalog';
import { useDeployments, useUpdateDeployment, useDeleteDeployment } from '@/hooks/use-deployments';
import { useSortable } from '@/hooks/use-sortable';
import SortableHeader from '@/components/ui/SortableHeader';
import DeployWorkloadModal from '@/components/DeployWorkloadModal';
import type { CatalogEntry } from '@/types/api';

type Tab = 'available' | 'deployed';

const TABS: readonly { readonly id: Tab; readonly label: string }[] = [
  { id: 'available', label: 'Available' },
  { id: 'deployed', label: 'Deployed' },
] as const;

export default function Workloads() {
  const [activeTab, setActiveTab] = useState<Tab>('available');
  const [deployModalOpen, setDeployModalOpen] = useState(false);
  const [deployPreSelectedImage, setDeployPreSelectedImage] = useState<string | null>(null);

  const openDeployModal = (imageId?: string) => {
    setDeployPreSelectedImage(imageId ?? null);
    setDeployModalOpen(true);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-purple-50 text-purple-600 dark:bg-purple-900/40 dark:text-purple-400">
          <Server size={20} />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100" data-testid="workloads-heading">Workloads</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">Browse available workloads and manage deployed instances.</p>
        </div>
      </div>

      <div className="border-b border-gray-200 dark:border-gray-700">
        <nav className="-mb-px flex gap-6" data-testid="tab-bar">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={clsx(
                'whitespace-nowrap border-b-2 px-1 py-3 text-sm font-medium transition-colors',
                activeTab === tab.id
                  ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                  : 'border-transparent text-gray-500 hover:border-gray-300 dark:hover:border-gray-600 hover:text-gray-700 dark:hover:text-gray-300',
              )}
              data-testid={`tab-${tab.id}`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {activeTab === 'available' && <AvailableTab onDeploy={openDeployModal} />}
      {activeTab === 'deployed' && <DeployedTab onDeploy={() => openDeployModal()} />}

      <DeployWorkloadModal
        open={deployModalOpen}
        onClose={() => { setDeployModalOpen(false); setDeployPreSelectedImage(null); }}
        preSelectedImageId={deployPreSelectedImage}
      />
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

interface HealthCheckData {
  readonly path?: string | null;
  readonly command?: readonly string[] | null;
  readonly port?: number | null;
  readonly initial_delay_seconds?: number;
  readonly period_seconds?: number;
}

function asHealthCheck(val: unknown): HealthCheckData {
  return (val && typeof val === 'object' ? val : {}) as HealthCheckData;
}

// ─── Available Tab ──────────────────────────────────────────────────────────

function AvailableTab({ onDeploy }: { readonly onDeploy: (imageId: string) => void }) {
  const [search, setSearch] = useState('');
  const [selectedImage, setSelectedImage] = useState<CatalogEntry | null>(null);
  const { data: response, isLoading, isError, error } = useCatalog();

  const images = response?.data ?? [];

  const filteredImages = useMemo(() => {
    if (!search.trim()) return images;
    const term = search.toLowerCase();
    return images.filter(
      (img) =>
        img.name.toLowerCase().includes(term) ||
        img.code.toLowerCase().includes(term),
    );
  }, [search, images]);

  const { sortedData: sortedImages, sortKey: imgSortKey, sortDirection: imgSortDir, onSort: onImgSort } = useSortable(filteredImages, 'name');

  return (
    <div className="space-y-4" data-testid="available-tab">
      <div className="flex items-center gap-3">
        <div className="relative max-w-sm flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="search"
            placeholder="Search images..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 py-2 pl-9 pr-4 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            data-testid="image-search"
          />
        </div>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-12" data-testid="loading-spinner">
          <Loader2 size={24} className="animate-spin text-blue-600" />
          <span className="ml-2 text-sm text-gray-500 dark:text-gray-400">Loading images...</span>
        </div>
      )}

      {isError && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-700 dark:text-red-400" data-testid="error-message">
          <AlertCircle size={16} />
          <span>Failed to load container images: {error?.message ?? 'Unknown error'}</span>
        </div>
      )}

      {!isLoading && !isError && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full" data-testid="images-table">
              <thead>
                <tr className="border-b border-gray-100 dark:border-gray-700 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  <SortableHeader label="Name" sortKey="name" currentKey={imgSortKey} direction={imgSortDir} onSort={onImgSort} />
                  <SortableHeader label="Type" sortKey="imageType" currentKey={imgSortKey} direction={imgSortDir} onSort={onImgSort} />
                  <SortableHeader label="Version" sortKey="version" currentKey={imgSortKey} direction={imgSortDir} onSort={onImgSort} className="hidden md:table-cell" />
                  <SortableHeader label="Status" sortKey="status" currentKey={imgSortKey} direction={imgSortDir} onSort={onImgSort} />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {sortedImages.map((image) => {
                  const tags: readonly string[] = Array.isArray(image.tags) ? image.tags : [];

                  return (
                    <tr
                      key={image.id}
                      className="cursor-pointer transition-colors hover:bg-gray-50 dark:hover:bg-gray-700/50"
                      onClick={() => setSelectedImage(image)}
                      data-testid={`image-row-${image.id}`}
                    >
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-2">
                          <Container size={14} className="text-gray-400" />
                          <span className="font-medium text-gray-900 dark:text-gray-100">{image.name}</span>
                          {tags.length > 0 && (
                            <div className="flex gap-1">
                              {tags.map((tag) => (
                                <span key={tag} className="inline-flex rounded-full bg-gray-100 dark:bg-gray-700 px-2 py-0.5 text-xs text-gray-500 dark:text-gray-400">{tag}</span>
                              ))}
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="px-5 py-3.5 text-sm text-gray-600 dark:text-gray-400">{image.type}</td>
                      <td className="hidden px-5 py-3.5 text-sm text-gray-600 dark:text-gray-400 md:table-cell">{image.version ?? '-'}</td>
                      <td className="px-5 py-3.5">
                        <span className={clsx(
                          'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium',
                          image.status === 'active'
                            ? 'bg-green-50 text-green-700 border-green-200 dark:bg-green-900/40 dark:text-green-300 dark:border-green-700'
                            : 'bg-gray-50 text-gray-600 border-gray-200 dark:bg-gray-700 dark:text-gray-400 dark:border-gray-600',
                        )}>
                          {image.status}
                        </span>
                      </td>
                    </tr>
                  );
                })}
                {sortedImages.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-5 py-10 text-center text-sm text-gray-500 dark:text-gray-400">
                      No images found matching your search.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="border-t border-gray-100 dark:border-gray-700 px-5 py-3 text-sm text-gray-500 dark:text-gray-400">
            {sortedImages.length} image{sortedImages.length !== 1 ? 's' : ''}
          </div>
        </div>
      )}

      {selectedImage && (
        <WorkloadDetailPanel image={selectedImage} onClose={() => setSelectedImage(null)} onDeploy={onDeploy} />
      )}
    </div>
  );
}

// ─── Workload Detail Panel ──────────────────────────────────────────────────

function SectionHeading({ icon: Icon, title }: { readonly icon: React.ElementType; readonly title: string }) {
  return (
    <h4 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">
      <Icon size={16} className="text-blue-600 dark:text-blue-400" />
      {title}
    </h4>
  );
}

function ExposesSection({ image }: { readonly image: CatalogEntry }) {
  const exposes = image.provides as { ports?: { port: number; protocol: string; name: string; publishable: boolean }[]; volumes?: { description: string; local_path: string; container_path: string }[]; env_vars?: { configurable?: string[]; generated?: string[]; fixed?: Record<string, string> }; services?: Record<string, { engine?: string; version?: string; protocol?: string }> } | null | undefined;
  if (!exposes) return null;

  return (
    <div className="space-y-4">
      <h4 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
        <Server size={16} className="text-blue-600 dark:text-blue-400" /> Exposes
      </h4>
      {exposes.ports && exposes.ports.length > 0 && (
        <div>
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Ports</p>
          <div className="flex flex-wrap gap-2">
            {exposes.ports.map((p) => (
              <div key={p.port} className="inline-flex items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-sm">
                <span className="font-mono font-medium text-gray-900 dark:text-gray-100">{p.port}</span>
                <span className="text-gray-500 dark:text-gray-400">{p.protocol}</span>
                <span className="text-xs text-gray-400 dark:text-gray-500">{p.name}</span>
                {p.publishable ? (
                  <span className="rounded bg-green-100 dark:bg-green-900/20 px-1.5 py-0.5 text-xs font-medium text-green-700 dark:text-green-300">Publishable</span>
                ) : (
                  <span className="rounded bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 text-xs text-gray-500 dark:text-gray-400">Internal</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {exposes.volumes && exposes.volumes.length > 0 && (
        <div>
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Volumes</p>
          <div className="space-y-1">
            {exposes.volumes.map((v) => (
              <div key={v.local_path} className="flex items-center gap-3 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 text-sm">
                <span className="font-mono text-gray-900 dark:text-gray-100">{v.container_path}</span>
                <span className="text-gray-400 dark:text-gray-500">→</span>
                <span className="font-mono text-blue-600 dark:text-blue-400">{v.local_path}</span>
                <span className="text-xs text-gray-500 dark:text-gray-400">({v.description})</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {exposes.env_vars && (
        <div>
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Environment</p>
          <div className="space-y-2">
            {exposes.env_vars.configurable && exposes.env_vars.configurable.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {exposes.env_vars.configurable.map((v) => <span key={v} className="rounded bg-blue-100 dark:bg-blue-900/20 px-2 py-0.5 text-xs font-mono text-blue-700 dark:text-blue-300">{v}</span>)}
              </div>
            )}
            {exposes.env_vars.generated && exposes.env_vars.generated.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {exposes.env_vars.generated.map((v) => <span key={v} className="rounded bg-amber-100 dark:bg-amber-900/20 px-2 py-0.5 text-xs font-mono text-amber-700 dark:text-amber-300">{v} (auto)</span>)}
              </div>
            )}
            {exposes.env_vars.fixed && Object.keys(exposes.env_vars.fixed).length > 0 && (
              <div className="flex flex-wrap gap-1">
                {Object.entries(exposes.env_vars.fixed).map(([k, v]) => <span key={k} className="rounded bg-gray-200 dark:bg-gray-600 px-2 py-0.5 text-xs font-mono text-gray-700 dark:text-gray-300">{k}={v}</span>)}
              </div>
            )}
          </div>
        </div>
      )}
      {exposes.services && Object.keys(exposes.services).length > 0 && (
        <div>
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Services Provided</p>
          <div className="flex flex-wrap gap-2">
            {Object.entries(exposes.services).map(([type, svc]) => (
              <div key={type} className="inline-flex items-center gap-2 rounded-lg border border-emerald-200 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-900/20 px-3 py-1.5 text-sm">
                <span className="font-medium text-emerald-700 dark:text-emerald-300">{type}</span>
                {svc.engine && <span className="text-emerald-600 dark:text-emerald-400">{svc.engine}</span>}
                {svc.version && <span className="text-xs text-emerald-500 dark:text-emerald-400">v{svc.version}</span>}
                {svc.protocol && <span className="text-xs text-emerald-400 dark:text-emerald-500">({svc.protocol})</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function WorkloadDetailPanel({
  image,
  onClose,
  onDeploy,
}: {
  readonly image: CatalogEntry;
  readonly onClose: () => void;
  readonly onDeploy: (imageId: string) => void;
}) {
  const healthCheck = asHealthCheck(image.healthCheck);
  const envVars: readonly Record<string, string>[] = Array.isArray(image.envVars) ? image.envVars : [];
  const tags: readonly string[] = Array.isArray(image.tags) ? image.tags : [];

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4" data-testid="workload-detail-panel">
      <div
        className="relative my-8 w-full max-w-3xl rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-xl"
        role="dialog"
        aria-label={`${image.name} details`}
      >
        {/* Close button */}
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 rounded-md p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          data-testid="detail-close-button"
        >
          <X size={20} />
        </button>

        <div className="p-6 space-y-6">
          {/* Header */}
          <div>
            <div className="flex items-start justify-between pr-8">
              <div>
                <h3 className="text-xl font-bold text-gray-900 dark:text-gray-100">{image.name}</h3>
                <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
                  {image.version ? `v${image.version}` : image.code}
                </p>
              </div>
              <span className="inline-flex rounded-full bg-purple-50 dark:bg-purple-900/20 px-3 py-1 text-xs font-medium text-purple-700 dark:text-purple-300">
                {image.type}
              </span>
            </div>
            {image.description && (
              <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{image.description}</p>
            )}
            {tags.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1">
                {tags.map((tag) => (
                  <span key={tag} className="inline-flex rounded-full bg-gray-100 dark:bg-gray-700 px-2 py-0.5 text-xs text-gray-500 dark:text-gray-400">{tag}</span>
                ))}
              </div>
            )}
          </div>

          {/* Resource Requirements (always visible, at top) */}
          <div>
            <SectionHeading icon={Cpu} title="Resource Requirements" />
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 rounded-lg border border-gray-200 dark:border-gray-700 p-3">
              <div><span className="text-xs font-medium text-gray-500 dark:text-gray-400">CPU</span><p className="text-sm text-gray-900 dark:text-gray-100">{image.resources?.default?.cpu ?? 'Default'}</p></div>
              <div><span className="text-xs font-medium text-gray-500 dark:text-gray-400">Memory</span><p className="text-sm text-gray-900 dark:text-gray-100">{image.resources?.default?.memory ?? 'Default'}</p></div>
              <div><span className="text-xs font-medium text-gray-500 dark:text-gray-400">Min Plan</span><p className="text-sm text-gray-900 dark:text-gray-100">{image.minPlan ?? 'Any'}</p></div>
              <div><span className="text-xs font-medium text-gray-500 dark:text-gray-400">Container Port</span><p className="text-sm text-gray-900 dark:text-gray-100">-</p></div>
            </div>
          </div>

          {/* Exposes — ports, volumes, env vars, services */}
          <ExposesSection image={image} />

          {/* Collapsible: Workload Details */}
          <details className="rounded-lg border border-gray-200 dark:border-gray-700">
            <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50">
              Workload Details
            </summary>
            <div className="border-t border-gray-200 dark:border-gray-700 p-4 space-y-5">

              {/* Deployment Info */}
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 rounded-lg border border-gray-200 dark:border-gray-700 p-3">
                <div><span className="text-xs font-medium text-gray-500 dark:text-gray-400">Runtime</span><p className="text-sm text-gray-900 dark:text-gray-100">{image.runtime ?? '-'}</p></div>
                <div><span className="text-xs font-medium text-gray-500 dark:text-gray-400">Web Server</span><p className="text-sm text-gray-900 dark:text-gray-100">{image.webServer ?? '-'}</p></div>
                <div><span className="text-xs font-medium text-gray-500 dark:text-gray-400">Deploy Strategy</span><p className="text-sm text-gray-900 dark:text-gray-100">{image.deploymentStrategy ?? '-'}</p></div>
                <div><span className="text-xs font-medium text-gray-500 dark:text-gray-400">Mount Path</span><p className="text-sm font-mono text-gray-900 dark:text-gray-100">-</p></div>
              </div>

              {/* Health Check */}
              {healthCheck.path && (
                <div>
                  <SectionHeading icon={Heart} title="Health Check" />
                  <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 rounded-lg border border-gray-200 dark:border-gray-700 p-3">
                    <div><span className="text-xs font-medium text-gray-500 dark:text-gray-400">Path</span><p className="text-sm text-gray-900 dark:text-gray-100">{healthCheck.path}</p></div>
                    <div><span className="text-xs font-medium text-gray-500 dark:text-gray-400">Port</span><p className="text-sm text-gray-900 dark:text-gray-100">{healthCheck.port ?? '-'}</p></div>
                    <div><span className="text-xs font-medium text-gray-500 dark:text-gray-400">Initial Delay</span><p className="text-sm text-gray-900 dark:text-gray-100">{healthCheck.initial_delay_seconds != null ? `${healthCheck.initial_delay_seconds}s` : '-'}</p></div>
                    <div><span className="text-xs font-medium text-gray-500 dark:text-gray-400">Period</span><p className="text-sm text-gray-900 dark:text-gray-100">{healthCheck.period_seconds != null ? `${healthCheck.period_seconds}s` : '-'}</p></div>
                  </div>
                </div>
              )}

              {/* Environment Variables */}
              {envVars.length > 0 && (
                <div>
                  <SectionHeading icon={Settings2} title="Environment Variables" />
                  <div className="flex flex-wrap gap-1 rounded-lg border border-gray-200 dark:border-gray-700 p-3">
                    {envVars.map((v, i) => (
                      <span key={i} className="rounded bg-gray-200 dark:bg-gray-600 px-2 py-0.5 text-xs font-mono text-gray-700 dark:text-gray-300">
                        {typeof v === 'string' ? v : Object.keys(v)[0]}
                      </span>
                    ))}
                  </div>
                </div>
              )}

            </div>
          </details>

          {/* Footer */}
          <div className="flex items-center justify-end gap-3 border-t border-gray-200 dark:border-gray-700 pt-4">
            <button
              type="button"
              onClick={() => { onDeploy(image.id); onClose(); }}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              data-testid="deploy-button"
            >
              <Rocket size={14} />
              Deploy
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
              data-testid="close-button"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Deployed Tab ───────────────────────────────────────────────────────────

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

function DeployedTab({ onDeploy }: { readonly onDeploy: () => void }) {
  const { clientId } = useClientContext();
  const { data: response, isLoading, isError, error } = useDeployments(clientId ?? undefined);
  const updateDeployment = useUpdateDeployment(clientId ?? undefined);
  const deleteDeployment = useDeleteDeployment(clientId ?? undefined);

  const workloadsRaw = response?.data ?? [];
  const { sortedData: workloads, sortKey: wlSortKey, sortDirection: wlSortDir, onSort: onWlSort } = useSortable(workloadsRaw, 'name');

  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const handleDelete = async (id: string) => {
    try { await deleteDeployment.mutateAsync(id); setDeleteConfirmId(null); }
    catch { /* error via deleteDeployment.error */ }
  };

  return (
    <div className="space-y-4" data-testid="deployed-tab">
      <div className="flex items-center justify-end">
        <button
          type="button"
          onClick={onDeploy}
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
          data-testid="deploy-workload-button"
        >
          <Rocket size={14} />
          Deploy a Workload
        </button>
      </div>

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

        {!isLoading && !isError && workloadsRaw.length === 0 && (
          <div className="px-6 py-16 text-center" data-testid="workloads-empty">
            <Server size={40} className="mx-auto text-gray-300 dark:text-gray-600" />
            <p className="mt-3 text-sm font-medium text-gray-900 dark:text-gray-100">No workloads yet</p>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Click "Deploy" to launch your first application.</p>
          </div>
        )}

        {!isLoading && !isError && workloadsRaw.length > 0 && (
          <div className="overflow-x-auto" data-testid="workloads-table">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/50">
                  <SortableHeader label="Name" sortKey="name" currentKey={wlSortKey} direction={wlSortDir} onSort={onWlSort} className="px-6 font-medium text-gray-500 dark:text-gray-400" />
                  <SortableHeader label="Status" sortKey="status" currentKey={wlSortKey} direction={wlSortDir} onSort={onWlSort} className="px-6 font-medium text-gray-500 dark:text-gray-400" />
                  <SortableHeader label="Replicas" sortKey="replicaCount" currentKey={wlSortKey} direction={wlSortDir} onSort={onWlSort} className="px-6 font-medium text-gray-500 dark:text-gray-400" />
                  <SortableHeader label="CPU" sortKey="cpuRequest" currentKey={wlSortKey} direction={wlSortDir} onSort={onWlSort} className="hidden px-6 font-medium text-gray-500 dark:text-gray-400 md:table-cell" />
                  <SortableHeader label="Memory" sortKey="memoryRequest" currentKey={wlSortKey} direction={wlSortDir} onSort={onWlSort} className="hidden px-6 font-medium text-gray-500 dark:text-gray-400 md:table-cell" />
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
                          onClick={() => updateDeployment.mutate({ deploymentId: w.id, status: w.status === 'running' ? 'stopped' : 'running' })}
                          disabled={w.status === 'pending' || w.status === 'failed'}
                          className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1.5 text-xs text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 disabled:opacity-50"
                          title={w.status === 'running' ? 'Stop' : 'Start'}
                          data-testid={`toggle-workload-${w.id}`}
                        >
                          {w.status === 'running' ? <Square size={12} /> : <Play size={12} />}
                        </button>
                        {deleteConfirmId === w.id ? (
                          <>
                            <button type="button" onClick={() => handleDelete(w.id)} disabled={deleteDeployment.isPending} className="rounded-md bg-red-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50" data-testid={`confirm-delete-wl-${w.id}`}>Confirm</button>
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
