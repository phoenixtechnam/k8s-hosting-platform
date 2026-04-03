import { useState, useMemo, useCallback } from 'react';
import { AppWindow, Search, Loader2, AlertCircle, X, Globe, HardDrive, Cpu, Heart, Settings2, Network, Box, Play, Square, ExternalLink, Star, Flame, ChevronDown, Rocket, Trash2, Container, Server, RotateCcw } from 'lucide-react';
import ResourceRequirementCheck from '@/components/ResourceRequirementCheck';
import clsx from 'clsx';
import { useClientContext } from '@/hooks/use-client-context';
import { useCatalog } from '@/hooks/use-catalog';
import { useDeployments, useUpdateDeployment, useDeleteDeployment, useRestoreDeployment, usePermanentDeleteDeployment } from '@/hooks/use-deployments';
import { useSortable } from '@/hooks/use-sortable';
import SortableHeader from '@/components/ui/SortableHeader';
import DeployWorkloadModal from '@/components/DeployWorkloadModal';
import InstalledAppDetailModal from '@/components/InstalledAppDetailModal';
import { getStatusColor } from '@/lib/status-colors';
import type { CatalogEntry } from '@/types/api';

type Tab = 'catalog' | 'installed';

const TABS: readonly { readonly id: Tab; readonly label: string }[] = [
  { id: 'catalog', label: 'Catalog' },
  { id: 'installed', label: 'Installed' },
] as const;

const TYPE_FILTERS = ['All', 'Applications', 'Runtimes', 'Static', 'Databases', 'Services'] as const;
type TypeFilter = typeof TYPE_FILTERS[number];
const TYPE_FILTER_MAP: Record<TypeFilter, string | null> = {
  All: null,
  Applications: 'application',
  Runtimes: 'runtime',
  Static: 'static',
  Databases: 'database',
  Services: 'service',
};

export default function Applications() {
  const [activeTab, setActiveTab] = useState<Tab>('catalog');
  const [deployModalOpen, setDeployModalOpen] = useState(false);
  const [deployPreSelectedImage, setDeployPreSelectedImage] = useState<string | null>(null);

  const openDeployModal = (imageId?: string) => {
    setDeployPreSelectedImage(imageId ?? null);
    setDeployModalOpen(true);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-900/40 dark:text-brand-400">
            <AppWindow size={20} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100" data-testid="applications-heading">Applications</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400">Browse the catalog and manage your deployed applications.</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => openDeployModal()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
          data-testid="deploy-button"
        >
          <Rocket size={14} />
          Deploy
        </button>
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

      {activeTab === 'catalog' && <CatalogTab onDeploy={openDeployModal} />}
      {activeTab === 'installed' && <InstalledTab onDeploy={() => openDeployModal()} />}

      <DeployWorkloadModal
        open={deployModalOpen}
        onClose={() => { setDeployModalOpen(false); setDeployPreSelectedImage(null); }}
        preSelectedImageId={deployPreSelectedImage}
        onSuccess={() => setActiveTab('installed')}
      />
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

interface ComponentEntry {
  readonly name?: string;
  readonly type?: string;
  readonly image?: string;
  readonly ports?: readonly { readonly port?: number; readonly protocol?: string; readonly ingress?: boolean }[];
  readonly optional?: boolean;
}

interface ParameterEntry {
  readonly key?: string;
  readonly label?: string;
  readonly type?: string;
  readonly default?: unknown;
  readonly required?: boolean;
}

interface VolumeEntry {
  readonly local_path?: string;
  readonly container_path?: string;
  readonly description?: string;
  readonly optional?: boolean;
}

interface IngressPort {
  readonly port?: number;
  readonly protocol?: string;
  readonly tls?: boolean;
  readonly description?: string;
}

interface HostPort {
  readonly port?: number;
  readonly protocol?: string;
  readonly component?: string;
  readonly description?: string;
  readonly optional?: boolean;
  readonly remappable?: boolean;
}

interface NetworkingData {
  readonly ingress_ports?: readonly IngressPort[];
  readonly host_ports?: readonly HostPort[];
  readonly websocket?: boolean;
}

interface ResourceTier {
  readonly cpu?: string;
  readonly memory?: string;
  readonly storage?: string;
}

interface ResourcesData {
  readonly recommended?: ResourceTier;
  readonly minimum?: ResourceTier;
}

interface HealthCheckData {
  readonly path?: string;
  readonly port?: number;
  readonly initial_delay_seconds?: number;
  readonly period_seconds?: number;
}

function asComponents(val: unknown): readonly ComponentEntry[] {
  return Array.isArray(val) ? val : [];
}
function asParameters(val: unknown): readonly ParameterEntry[] {
  return Array.isArray(val) ? val : [];
}
function asVolumes(val: unknown): readonly VolumeEntry[] {
  return Array.isArray(val) ? val : [];
}
function asNetworking(val: unknown): NetworkingData {
  return (val && typeof val === 'object' ? val : {}) as NetworkingData;
}
function asResources(val: unknown): ResourcesData {
  return (val && typeof val === 'object' ? val : {}) as ResourcesData;
}
function asHealthCheck(val: unknown): HealthCheckData {
  return (val && typeof val === 'object' ? val : {}) as HealthCheckData;
}

function getIconUrl(entryId: string | null | undefined): string | null {
  if (!entryId) return null;
  const base = import.meta.env.VITE_API_URL || '';
  return `${base}/api/v1/catalog/${entryId}/icon`;
}

function AppIcon({ entryId, size = 40 }: { readonly entryId?: string | null; readonly size?: number }) {
  const [failed, setFailed] = useState(false);
  const url = getIconUrl(entryId);
  if (!url || failed) {
    return (
      <div className="flex items-center justify-center rounded-lg bg-gray-100 dark:bg-gray-700" style={{ width: size, height: size }}>
        <AppWindow size={size * 0.5} className="text-gray-400" />
      </div>
    );
  }
  return (
    <img
      src={url}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      className="rounded-lg object-contain"
      style={{ width: size, height: size }}
    />
  );
}

// ─── Catalog Tab ───────────────────────────────────────────────────────────

function CatalogTab({ onDeploy }: { readonly onDeploy: (imageId: string) => void }) {
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('All');
  const [selectedEntry, setSelectedEntry] = useState<CatalogEntry | null>(null);
  const { data: response, isLoading, isError, error } = useCatalog();

  const entries = response?.data ?? [];

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const entry of entries) {
      if (entry.category) set.add(entry.category);
    }
    return Array.from(set).sort();
  }, [entries]);

  const filteredEntries = useMemo(() => {
    let result = entries;

    const typeValue = TYPE_FILTER_MAP[typeFilter];
    if (typeValue) {
      result = result.filter((entry) => entry.type === typeValue);
    }

    if (search.trim()) {
      const term = search.toLowerCase();
      result = result.filter(
        (entry) =>
          entry.name.toLowerCase().includes(term) ||
          entry.code.toLowerCase().includes(term) ||
          (entry.description ?? '').toLowerCase().includes(term),
      );
    }

    if (categoryFilter) {
      result = result.filter((entry) => (entry.category ?? 'other') === categoryFilter);
    }

    result = [...result].sort((a, b) => {
      if ((a.featured ?? 0) !== (b.featured ?? 0)) return (b.featured ?? 0) - (a.featured ?? 0);
      if ((a.popular ?? 0) !== (b.popular ?? 0)) return (b.popular ?? 0) - (a.popular ?? 0);
      return a.name.localeCompare(b.name);
    });

    return result;
  }, [search, categoryFilter, typeFilter, entries]);

  const handleCardClick = useCallback((entry: CatalogEntry) => {
    setSelectedEntry(entry);
  }, []);

  const handleClose = useCallback(() => {
    setSelectedEntry(null);
  }, []);

  return (
    <div className="space-y-4" data-testid="catalog-tab">
      <div className="flex items-center gap-3">
        <div className="relative max-w-sm flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="search"
            placeholder="Search catalog..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 py-2 pl-9 pr-4 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            data-testid="catalog-search"
          />
        </div>
        {categories.length > 0 && (
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 py-2 pl-3 pr-8 text-sm text-gray-700 dark:text-gray-300 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            data-testid="category-filter"
          >
            <option value="">All categories</option>
            {categories.map((cat) => (
              <option key={cat} value={cat}>
                {cat}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="flex flex-wrap gap-2" data-testid="type-filter-pills">
        {TYPE_FILTERS.map((tf) => (
          <button
            key={tf}
            type="button"
            onClick={() => setTypeFilter(tf)}
            className={clsx(
              'rounded-full px-3 py-1 text-xs font-medium transition-colors',
              typeFilter === tf
                ? 'bg-blue-600 text-white dark:bg-blue-500'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600',
            )}
            data-testid={`type-filter-${tf.toLowerCase()}`}
          >
            {tf}
          </button>
        ))}
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-12" data-testid="loading-spinner">
          <Loader2 size={24} className="animate-spin text-blue-600" />
          <span className="ml-2 text-sm text-gray-500 dark:text-gray-400">Loading catalog...</span>
        </div>
      )}

      {isError && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-700 dark:text-red-400" data-testid="error-message">
          <AlertCircle size={16} />
          <span>Failed to load application catalog: {error?.message ?? 'Unknown error'}</span>
        </div>
      )}

      {!isLoading && !isError && (
        <>
          {filteredEntries.length === 0 ? (
            <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 px-5 py-10 text-center text-sm text-gray-500 dark:text-gray-400" data-testid="catalog-empty">
              No entries found matching your filters.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3" data-testid="catalog-grid">
              {filteredEntries.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => handleCardClick(entry)}
                  className="cursor-pointer rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm transition-shadow hover:shadow-md text-left"
                  data-testid={`catalog-card-${entry.code}`}
                >
                  <div className="mb-3 flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <AppIcon entryId={entry.id} size={40} />
                      <div>
                        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">{entry.name}</h3>
                        <div className="mt-0.5 flex items-center gap-2">
                          <span className="text-xs text-gray-500 dark:text-gray-400">v{entry.version}</span>
                          {entry.url && (
                            <a href={entry.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 rounded-md bg-brand-50 dark:bg-brand-900/30 px-2 py-0.5 text-xs font-medium text-brand-600 dark:text-brand-400 hover:bg-brand-100 dark:hover:bg-brand-800/50 transition-colors">
                              <ExternalLink size={10} /> Official Website
                            </a>
                          )}
                          {entry.documentation && (
                            <a href={entry.documentation} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 rounded-md bg-emerald-50 dark:bg-emerald-900/30 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-800/50 transition-colors">
                              <ExternalLink size={10} /> User Manual
                            </a>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <span className="inline-flex rounded-full bg-purple-50 dark:bg-purple-900/20 px-2.5 py-0.5 text-xs font-medium text-purple-700 dark:text-purple-300">
                        {entry.type ?? 'unknown'}
                      </span>
                      <span className="inline-flex rounded-full bg-blue-50 dark:bg-blue-900/20 px-2.5 py-0.5 text-xs font-medium text-blue-700 dark:text-blue-300">
                        {entry.category ?? 'other'}
                      </span>
                      {entry.featured ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 dark:bg-amber-900/20 px-2.5 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">
                          <Star size={12} className="fill-amber-400 text-amber-400" /> Featured
                        </span>
                      ) : null}
                      {entry.popular ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-orange-50 dark:bg-orange-900/20 px-2.5 py-0.5 text-xs font-medium text-orange-700 dark:text-orange-300">
                          <Flame size={12} className="fill-orange-400 text-orange-400" /> Popular
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <p className="mb-4 line-clamp-2 text-sm text-gray-600 dark:text-gray-400">{entry.description}</p>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                    <span className="inline-flex items-center rounded bg-gray-100 dark:bg-gray-700 px-2 py-0.5">
                      {Array.isArray(entry.components) ? entry.components.length : 0} component{(Array.isArray(entry.components) ? entry.components.length : 0) !== 1 ? 's' : ''}
                    </span>
                  </div>
                  {(Array.isArray(entry.tags) ? entry.tags : []).length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1">
                      {(Array.isArray(entry.tags) ? entry.tags : []).map((tag) => (
                        <span
                          key={tag}
                          className="inline-flex rounded-full bg-gray-100 dark:bg-gray-700 px-2 py-0.5 text-xs text-gray-500 dark:text-gray-400"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}
          <div className="text-sm text-gray-500 dark:text-gray-400">
            {filteredEntries.length} entr{filteredEntries.length !== 1 ? 'ies' : 'y'}
          </div>
        </>
      )}

      {selectedEntry && (
        <AppDetailPanel entry={selectedEntry} onClose={handleClose} onDeploy={onDeploy} />
      )}
    </div>
  );
}

// ─── Application Detail Panel ───────────────────────────────────────────────

function SectionHeading({ icon: Icon, title }: { readonly icon: React.ElementType; readonly title: string }) {
  return (
    <h4 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">
      <Icon size={16} className="text-blue-600 dark:text-blue-400" />
      {title}
    </h4>
  );
}

function CollapsibleSection({ title, children }: { readonly title: string; readonly children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-4 py-3 text-sm font-semibold text-gray-900 dark:text-gray-100 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors rounded-lg"
      >
        {title}
        <ChevronDown size={16} className={clsx('text-gray-400 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="border-t border-gray-200 dark:border-gray-700 p-4 space-y-6">
          {children}
        </div>
      )}
    </div>
  );
}

function AppDetailPanel({
  entry,
  onClose,
  onDeploy,
}: {
  readonly entry: CatalogEntry;
  readonly onClose: () => void;
  readonly onDeploy?: (entryId: string) => void;
}) {
  const components = asComponents(entry.components);
  const parameters = asParameters(entry.parameters);
  const networking = asNetworking(entry.networking);
  const volumes = asVolumes(entry.volumes);
  const resources = asResources(entry.resources);
  const healthCheck = asHealthCheck(entry.healthCheck);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4" data-testid="app-detail-panel">
      <div
        className="relative my-8 w-full max-w-3xl rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-xl"
        role="dialog"
        aria-label={`${entry.name} details`}
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
              <div className="flex items-center gap-4">
                <AppIcon entryId={entry.id} size={48} />
                <div>
                  <h3 className="text-xl font-bold text-gray-900 dark:text-gray-100">{entry.name}</h3>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <span className="text-sm text-gray-500 dark:text-gray-400">v{entry.version}</span>
                    {entry.url && (
                      <a href={entry.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded-md bg-brand-100 dark:bg-brand-900/40 px-2.5 py-1 text-xs font-medium text-brand-700 dark:text-brand-300 hover:bg-brand-200 dark:hover:bg-brand-800/50 transition-colors">
                        <ExternalLink size={12} /> Official Website
                      </a>
                    )}
                    {entry.documentation && (
                      <a href={entry.documentation} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded-md bg-emerald-100 dark:bg-emerald-900/40 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-300 hover:bg-emerald-200 dark:hover:bg-emerald-800/50 transition-colors">
                        <ExternalLink size={12} /> User Manual
                      </a>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <span className="inline-flex rounded-full bg-blue-50 dark:bg-blue-900/20 px-3 py-1 text-xs font-medium text-blue-700 dark:text-blue-300">
                  {entry.category ?? 'other'}
                </span>
                {entry.featured ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 dark:bg-amber-900/20 px-3 py-1 text-xs font-medium text-amber-700 dark:text-amber-300">
                    <Star size={12} className="fill-amber-400 text-amber-400" /> Featured
                  </span>
                ) : null}
                {entry.popular ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-orange-50 dark:bg-orange-900/20 px-3 py-1 text-xs font-medium text-orange-700 dark:text-orange-300">
                    <Flame size={12} className="fill-orange-400 text-orange-400" /> Popular
                  </span>
                ) : null}
              </div>
            </div>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{entry.description}</p>
          </div>

          {/* Resource Requirements */}
          {(resources.recommended ?? resources.minimum) && (
            <div>
              <SectionHeading icon={Cpu} title="Resource Requirements" />
              <div className="grid grid-cols-2 gap-4">
                {resources.recommended && (
                  <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-3">
                    <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">Recommended</p>
                    <div className="space-y-1 text-sm">
                      <div className="flex justify-between"><span className="text-gray-500">CPU</span><span className="font-medium text-gray-900 dark:text-gray-100">{resources.recommended.cpu}</span></div>
                      <div className="flex justify-between"><span className="text-gray-500">Memory</span><span className="font-medium text-gray-900 dark:text-gray-100">{resources.recommended.memory}</span></div>
                      <div className="flex justify-between"><span className="text-gray-500">Storage</span><span className="font-medium text-gray-900 dark:text-gray-100">{resources.recommended.storage}</span></div>
                    </div>
                  </div>
                )}
                {resources.minimum && (
                  <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-3">
                    <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">Minimum</p>
                    <div className="space-y-1 text-sm">
                      <div className="flex justify-between"><span className="text-gray-500">CPU</span><span className="font-medium text-gray-900 dark:text-gray-100">{resources.minimum.cpu}</span></div>
                      <div className="flex justify-between"><span className="text-gray-500">Memory</span><span className="font-medium text-gray-900 dark:text-gray-100">{resources.minimum.memory}</span></div>
                      <div className="flex justify-between"><span className="text-gray-500">Storage</span><span className="font-medium text-gray-900 dark:text-gray-100">{resources.minimum.storage}</span></div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Resource Availability Check */}
          <ResourceRequirementCheck
            minimumCpu={resources.minimum?.cpu}
            minimumMemory={resources.minimum?.memory}
            minimumStorage={resources.minimum?.storage}
          />

          <CollapsibleSection title="App Details">
          {/* Components */}
          {components.length > 0 && (
            <div>
              <SectionHeading icon={Box} title="Components" />
              <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
                <table className="w-full text-sm" data-testid="components-table">
                  <thead>
                    <tr className="border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                      <th className="px-3 py-2">Name</th>
                      <th className="px-3 py-2">Type</th>
                      <th className="px-3 py-2">Image</th>
                      <th className="px-3 py-2">Ports</th>
                      <th className="px-3 py-2"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                    {components.map((comp) => (
                      <tr key={comp.name ?? Math.random()}>
                        <td className="px-3 py-2 font-medium text-gray-900 dark:text-gray-100">{comp.name}</td>
                        <td className="px-3 py-2 text-gray-600 dark:text-gray-400">{comp.type}</td>
                        <td className="px-3 py-2 font-mono text-xs text-gray-500 dark:text-gray-400">{comp.image}</td>
                        <td className="px-3 py-2 text-gray-600 dark:text-gray-400">
                          {(comp.ports ?? []).map((p) => `${p.port}/${p.protocol}${p.ingress ? ' (ingress)' : ''}`).join(', ') || '-'}
                        </td>
                        <td className="px-3 py-2">
                          {comp.optional && (
                            <span className="inline-flex rounded-full bg-gray-100 dark:bg-gray-700 px-2 py-0.5 text-xs text-gray-500 dark:text-gray-400">
                              optional
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Parameters */}
          {parameters.length > 0 && (
            <div>
              <SectionHeading icon={Settings2} title="Parameters" />
              <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
                <table className="w-full text-sm" data-testid="parameters-table">
                  <thead>
                    <tr className="border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                      <th className="px-3 py-2">Label</th>
                      <th className="px-3 py-2">Key</th>
                      <th className="px-3 py-2">Type</th>
                      <th className="px-3 py-2">Default</th>
                      <th className="px-3 py-2"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                    {parameters.map((param) => (
                      <tr key={param.key ?? Math.random()}>
                        <td className="px-3 py-2 font-medium text-gray-900 dark:text-gray-100">{param.label ?? param.key}</td>
                        <td className="px-3 py-2 font-mono text-xs text-gray-500 dark:text-gray-400">{param.key}</td>
                        <td className="px-3 py-2 text-gray-600 dark:text-gray-400">{param.type ?? 'string'}</td>
                        <td className="px-3 py-2 text-gray-600 dark:text-gray-400">{param.default != null ? String(param.default) : '-'}</td>
                        <td className="px-3 py-2">
                          {param.required && (
                            <span className="inline-flex rounded-full bg-red-50 dark:bg-red-900/20 px-2 py-0.5 text-xs font-medium text-red-600 dark:text-red-400">
                              required
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Networking */}
          {((networking.ingress_ports ?? []).length > 0 || (networking.host_ports ?? []).length > 0 || networking.websocket != null) && (
            <div>
              <SectionHeading icon={Network} title="Networking" />
              <div className="space-y-3">
                {(networking.ingress_ports ?? []).length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Ingress Ports</p>
                    <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                            <th className="px-3 py-2">Port</th>
                            <th className="px-3 py-2">Protocol</th>
                            <th className="px-3 py-2">TLS</th>
                            <th className="px-3 py-2">Description</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                          {(networking.ingress_ports ?? []).map((p, i) => (
                            <tr key={i}>
                              <td className="px-3 py-2 text-gray-900 dark:text-gray-100">{p.port}</td>
                              <td className="px-3 py-2 text-gray-600 dark:text-gray-400">{p.protocol}</td>
                              <td className="px-3 py-2 text-gray-600 dark:text-gray-400">{p.tls ? 'Yes' : 'No'}</td>
                              <td className="px-3 py-2 text-gray-600 dark:text-gray-400">{p.description ?? '-'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
                {(networking.host_ports ?? []).length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Host Ports</p>
                    <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                            <th className="px-3 py-2">Port</th>
                            <th className="px-3 py-2">Protocol</th>
                            <th className="px-3 py-2">Component</th>
                            <th className="px-3 py-2">Description</th>
                            <th className="px-3 py-2"></th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                          {(networking.host_ports ?? []).map((p, i) => (
                            <tr key={i}>
                              <td className="px-3 py-2 text-gray-900 dark:text-gray-100">{p.port}</td>
                              <td className="px-3 py-2 text-gray-600 dark:text-gray-400">{p.protocol}</td>
                              <td className="px-3 py-2 text-gray-600 dark:text-gray-400">{p.component ?? '-'}</td>
                              <td className="px-3 py-2 text-gray-600 dark:text-gray-400">{p.description ?? '-'}</td>
                              <td className="px-3 py-2 flex gap-1">
                                {p.optional && <span className="inline-flex rounded-full bg-gray-100 dark:bg-gray-700 px-2 py-0.5 text-xs text-gray-500">optional</span>}
                                {p.remappable && <span className="inline-flex rounded-full bg-blue-50 dark:bg-blue-900/20 px-2 py-0.5 text-xs text-blue-600 dark:text-blue-400">remappable</span>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
                {networking.websocket != null && (
                  <div className="flex items-center gap-2">
                    <Globe size={14} className="text-gray-400" />
                    <span className="text-sm text-gray-600 dark:text-gray-400">
                      WebSocket: {networking.websocket ? (
                        <span className="inline-flex rounded-full bg-green-50 dark:bg-green-900/20 px-2 py-0.5 text-xs font-medium text-green-600 dark:text-green-400">supported</span>
                      ) : (
                        <span className="text-gray-500">not required</span>
                      )}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Volumes */}
          {volumes.length > 0 && (
            <div>
              <SectionHeading icon={HardDrive} title="Volumes" />
              <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
                <table className="w-full text-sm" data-testid="volumes-table">
                  <thead>
                    <tr className="border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                      <th className="px-3 py-2">Local Path</th>
                      <th className="px-3 py-2">Container Path</th>
                      <th className="px-3 py-2">Description</th>
                      <th className="px-3 py-2"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                    {volumes.map((vol, i) => (
                      <tr key={vol.local_path ?? i}>
                        <td className="px-3 py-2 font-medium text-gray-900 dark:text-gray-100">{vol.local_path}</td>
                        <td className="px-3 py-2 font-mono text-xs text-gray-500 dark:text-gray-400">{vol.container_path}</td>
                        <td className="px-3 py-2 text-gray-600 dark:text-gray-400">{vol.description ?? '-'}</td>
                        <td className="px-3 py-2">
                          {vol.optional && (
                            <span className="inline-flex rounded-full bg-gray-100 dark:bg-gray-700 px-2 py-0.5 text-xs text-gray-500">
                              optional
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Health Check */}
          {healthCheck.path && (
            <div>
              <SectionHeading icon={Heart} title="Health Check" />
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 rounded-lg border border-gray-200 dark:border-gray-700 p-3">
                <div><span className="text-xs font-medium text-gray-500">Path</span><p className="text-sm text-gray-900 dark:text-gray-100">{healthCheck.path}</p></div>
                <div><span className="text-xs font-medium text-gray-500">Port</span><p className="text-sm text-gray-900 dark:text-gray-100">{healthCheck.port ?? '-'}</p></div>
                <div><span className="text-xs font-medium text-gray-500">Initial Delay</span><p className="text-sm text-gray-900 dark:text-gray-100">{healthCheck.initial_delay_seconds != null ? `${healthCheck.initial_delay_seconds}s` : '-'}</p></div>
                <div><span className="text-xs font-medium text-gray-500">Period</span><p className="text-sm text-gray-900 dark:text-gray-100">{healthCheck.period_seconds != null ? `${healthCheck.period_seconds}s` : '-'}</p></div>
              </div>
            </div>
          )}

          </CollapsibleSection>

          {/* Footer */}
          <div className="flex items-center justify-end gap-3 border-t border-gray-200 dark:border-gray-700 pt-4">
            <button
              type="button"
              onClick={() => { if (onDeploy) { onDeploy(entry.id); onClose(); } }}
              disabled={!onDeploy}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              data-testid="install-button"
            >
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

// ─── Installed Tab ──────────────────────────────────────────────────────────

// Status colors now imported from @/lib/status-colors

function formatTimeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHrs = Math.floor(diffMin / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  const diffDays = Math.floor(diffHrs / 24);
  return `${diffDays}d ago`;
}

function InstalledTab({ onDeploy }: { readonly onDeploy: () => void }) {
  const { clientId } = useClientContext();
  const { data: deploymentsData, isLoading: deploymentsLoading, error } = useDeployments(clientId ?? undefined);
  const { data: catalogData } = useCatalog();
  const updateDeployment = useUpdateDeployment(clientId ?? undefined);
  const deleteDeployment = useDeleteDeployment(clientId ?? undefined);
  const restoreDeployment = useRestoreDeployment(clientId ?? undefined);
  const permanentDeleteDeployment = usePermanentDeleteDeployment(clientId ?? undefined);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [permanentDeleteConfirmId, setPermanentDeleteConfirmId] = useState<string | null>(null);
  const [selectedDeploymentId, setSelectedDeploymentId] = useState<string | null>(null);

  const deployments = deploymentsData?.data ?? [];

  const activeDeployments = useMemo(() => deployments.filter(d => d.status !== 'deleted'), [deployments]);
  const deletedDeployments = useMemo(() => deployments.filter(d => d.status === 'deleted'), [deployments]);

  const catalogMap = useMemo(() => {
    const map = new Map<string, CatalogEntry>();
    for (const entry of catalogData?.data ?? []) {
      map.set(entry.id, entry);
    }
    return map;
  }, [catalogData]);

  const getCatalogEntryName = (catalogEntryId: string | null) => {
    if (!catalogEntryId) return 'Unknown';
    const entry = catalogMap.get(catalogEntryId);
    return entry?.name ?? 'Unknown';
  };

  const selectedDeployment = deployments.find(d => d.id === selectedDeploymentId) ?? null;
  const selectedCatalogEntry = selectedDeployment
    ? catalogMap.get(selectedDeployment.catalogEntryId) ?? null
    : null;

  const handleToggleStatus = (deploymentId: string, currentStatus: string) => {
    const newStatus = currentStatus === 'running' ? 'stopped' : 'running';
    updateDeployment.mutate({ deploymentId, status: newStatus as 'running' | 'stopped' });
  };

  const isLoading = deploymentsLoading;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20" data-testid="installed-loading">
        <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-6 text-center" data-testid="installed-error">
        <p className="text-sm text-red-600 dark:text-red-400">
          Failed to load applications. Please try again later.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8" data-testid="installed-tab">
      {/* ── Active Deployments ── */}
      {activeDeployments.length > 0 && (
        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Deployments</h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {activeDeployments.map((deployment) => (
              <div
                key={deployment.id}
                className="cursor-pointer rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm transition-shadow hover:shadow-md"
                onClick={() => setSelectedDeploymentId(deployment.id)}
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-900/40 dark:text-brand-400">
                      <AppWindow size={20} />
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                        {deployment.name}
                      </h3>
                      <div className="flex items-center gap-1.5">
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          {getCatalogEntryName(deployment.catalogEntryId)}
                        </p>
                        <span className="inline-flex rounded-full bg-purple-50 dark:bg-purple-900/20 px-2 py-0.5 text-[10px] font-medium text-purple-700 dark:text-purple-300">
                          {deployment.catalogEntryId ? (catalogMap.get(deployment.catalogEntryId)?.type ?? 'unknown') : 'unknown'}
                        </span>
                      </div>
                    </div>
                  </div>
                  <span
                    className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${getStatusColor(deployment.status)}`}
                  >
                    {deployment.status}
                  </span>
                </div>

                <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-lg bg-gray-50 dark:bg-gray-700/50 px-2 py-1.5">
                    <p className="text-xs text-gray-500 dark:text-gray-400">Replicas</p>
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                      {deployment.replicaCount}
                    </p>
                  </div>
                  <div className="rounded-lg bg-gray-50 dark:bg-gray-700/50 px-2 py-1.5">
                    <p className="text-xs text-gray-500 dark:text-gray-400">CPU</p>
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                      {deployment.cpuRequest}
                    </p>
                  </div>
                  <div className="rounded-lg bg-gray-50 dark:bg-gray-700/50 px-2 py-1.5">
                    <p className="text-xs text-gray-500 dark:text-gray-400">Memory</p>
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                      {deployment.memoryRequest}
                    </p>
                  </div>
                </div>

                <div className="mt-4 flex gap-2">
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); handleToggleStatus(deployment.id, deployment.status); }}
                    disabled={updateDeployment.isPending || deployment.status === 'pending'}
                    className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                      deployment.status === 'running'
                        ? 'bg-red-50 text-red-600 hover:bg-red-100 dark:bg-red-900/20 dark:text-red-400 dark:hover:bg-red-900/40'
                        : 'bg-green-50 text-green-600 hover:bg-green-100 dark:bg-green-900/20 dark:text-green-400 dark:hover:bg-green-900/40'
                    }`}
                    data-testid={`toggle-app-${deployment.id}`}
                  >
                    {updateDeployment.isPending ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : deployment.status === 'running' ? (
                      <Square size={16} />
                    ) : (
                      <Play size={16} />
                    )}
                    {deployment.status === 'running' ? 'Stop' : 'Start'}
                  </button>
                  {deleteConfirmId === deployment.id ? (
                    <div className="flex gap-1">
                      <button type="button" onClick={async (e) => { e.stopPropagation(); try { await deleteDeployment.mutateAsync(deployment.id); setDeleteConfirmId(null); } catch { /* error via hook */ } }} disabled={deleteDeployment.isPending} className="rounded-lg bg-red-600 px-2.5 py-2 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50" data-testid={`confirm-delete-${deployment.id}`}>Confirm</button>
                      <button type="button" onClick={(e) => { e.stopPropagation(); setDeleteConfirmId(null); }} className="rounded-lg border border-gray-200 dark:border-gray-700 px-2.5 py-2 text-xs text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50">Cancel</button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setDeleteConfirmId(deployment.id); }}
                      className="rounded-lg border border-red-200 dark:border-red-700 bg-white dark:bg-gray-800 px-2.5 py-2 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30"
                      data-testid={`delete-app-${deployment.id}`}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Recently Deleted ── */}
      {deletedDeployments.length > 0 && (
        <div className="space-y-4" data-testid="deleted-deployments-section">
          <div className="flex items-center gap-3">
            <div className="h-px flex-1 bg-gray-200 dark:bg-gray-700" />
            <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400">Recently Deleted</h3>
            <div className="h-px flex-1 bg-gray-200 dark:bg-gray-700" />
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {deletedDeployments.map((deployment) => (
              <div
                key={deployment.id}
                className="cursor-pointer rounded-xl border border-dashed border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 p-5 opacity-50 transition-opacity hover:opacity-70"
                onClick={() => setSelectedDeploymentId(deployment.id)}
                data-testid={`deleted-card-${deployment.id}`}
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gray-100 text-gray-400 dark:bg-gray-700 dark:text-gray-500">
                      <AppWindow size={20} />
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                        {deployment.name}
                      </h3>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        {getCatalogEntryName(deployment.catalogEntryId)}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${getStatusColor('deleted')}`}>
                      deleted
                    </span>
                    {deployment.deletedAt && (
                      <span className="text-[10px] text-gray-400 dark:text-gray-500">
                        Deleted {formatTimeAgo(deployment.deletedAt)}
                      </span>
                    )}
                  </div>
                </div>

                <div className="mt-4 flex gap-2">
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); restoreDeployment.mutate(deployment.id); }}
                    disabled={restoreDeployment.isPending}
                    className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-green-300 dark:border-green-700 px-3 py-2 text-sm font-medium text-green-700 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-900/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    data-testid={`restore-app-${deployment.id}`}
                  >
                    {restoreDeployment.isPending ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : (
                      <RotateCcw size={16} />
                    )}
                    Restore
                  </button>
                  {permanentDeleteConfirmId === deployment.id ? (
                    <div className="flex gap-1">
                      <button
                        type="button"
                        onClick={async (e) => { e.stopPropagation(); try { await permanentDeleteDeployment.mutateAsync(deployment.id); setPermanentDeleteConfirmId(null); } catch { /* error via hook */ } }}
                        disabled={permanentDeleteDeployment.isPending}
                        className="rounded-lg bg-red-600 px-2.5 py-2 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                        data-testid={`confirm-permanent-delete-${deployment.id}`}
                      >
                        Confirm
                      </button>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setPermanentDeleteConfirmId(null); }}
                        className="rounded-lg border border-gray-200 dark:border-gray-700 px-2.5 py-2 text-xs text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setPermanentDeleteConfirmId(deployment.id); }}
                      className="rounded-lg bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm font-medium text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors"
                      data-testid={`permanent-delete-app-${deployment.id}`}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {activeDeployments.length === 0 && deletedDeployments.length === 0 && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-12 text-center" data-testid="installed-empty">
          <Box className="mx-auto h-12 w-12 text-gray-300 dark:text-gray-600" />
          <h3 className="mt-4 text-sm font-medium text-gray-900 dark:text-gray-100">
            No applications installed yet
          </h3>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
            Browse the Available tab to find and install applications.
          </p>
        </div>
      )}

      <InstalledAppDetailModal
        open={!!selectedDeploymentId}
        deployment={selectedDeployment}
        catalogEntry={selectedCatalogEntry}
        clientId={clientId ?? undefined}
        onClose={() => setSelectedDeploymentId(null)}
        onToggleStatus={(id, newStatus) => {
          updateDeployment.mutate({ deploymentId: id, status: newStatus });
        }}
        isToggling={updateDeployment.isPending}
      />
    </div>
  );
}
