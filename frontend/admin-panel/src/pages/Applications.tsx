import { useState, useMemo, useCallback } from 'react';
import { AppWindow, Search, Loader2, AlertCircle, AlertTriangle, X, Globe, HardDrive, Cpu, MemoryStick, Heart, Settings2, Network, Box, ExternalLink, Star, Flame, ChevronDown } from 'lucide-react';
import clsx from 'clsx';
import ApplicationRepoSettings from '@/components/ApplicationRepoSettings';
import { useApplicationCatalog, useUpdateBadges } from '@/hooks/use-application-catalog';
import { useCapacityCheck } from '@/hooks/use-capacity-check';
import type { ApplicationCatalogResponse } from '@k8s-hosting/api-contracts';

type Tab = 'catalog' | 'installed' | 'repos';

const TABS: readonly { readonly id: Tab; readonly label: string }[] = [
  { id: 'catalog', label: 'Available Applications' },
  { id: 'installed', label: 'Installed Applications' },
  { id: 'repos', label: 'Repositories' },
] as const;

export default function Applications() {
  const [activeTab, setActiveTab] = useState<Tab>('catalog');

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <AppWindow size={28} className="text-brand-500" />
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Applications</h1>
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
                  ? 'border-brand-500 text-brand-600 dark:text-brand-400'
                  : 'border-transparent text-gray-500 hover:border-gray-300 dark:hover:border-gray-600 hover:text-gray-700 dark:hover:text-gray-300',
              )}
              data-testid={`tab-${tab.id}`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {activeTab === 'catalog' && <CatalogTab />}
      {activeTab === 'installed' && <InstalledTab />}
      {activeTab === 'repos' && <RepositoriesTab />}
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
  readonly name?: string;
  readonly mount_path?: string;
  readonly default_size?: string;
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
  readonly default?: ResourceTier;
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

function getIconUrl(manifestUrl: string | null | undefined): string | null {
  if (!manifestUrl) return null;
  return manifestUrl.replace(/manifest\.json$/, 'icon.png');
}

function AppIcon({ manifestUrl, size = 40 }: { readonly manifestUrl?: string | null; readonly size?: number }) {
  const [failed, setFailed] = useState(false);
  const url = getIconUrl(manifestUrl);
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

// ─── Catalog Tab ────────────────────────────────────────────────────────────

function CatalogTab() {
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [selectedEntry, setSelectedEntry] = useState<ApplicationCatalogResponse | null>(null);
  const { data: response, isLoading, isError, error } = useApplicationCatalog();
  const updateBadges = useUpdateBadges();

  const entries = response?.data ?? [];

  const toggleFeatured = useCallback((entry: ApplicationCatalogResponse) => {
    updateBadges.mutate({ id: entry.id, featured: !entry.featured });
  }, [updateBadges]);

  const togglePopular = useCallback((entry: ApplicationCatalogResponse) => {
    updateBadges.mutate({ id: entry.id, popular: !entry.popular });
  }, [updateBadges]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const entry of entries) {
      if (entry.category) set.add(entry.category);
    }
    return Array.from(set).sort();
  }, [entries]);

  const filteredEntries = useMemo(() => {
    let result = entries;

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

    return [...result].sort((a, b) => {
      if (a.featured !== b.featured) return (b.featured ?? 0) - (a.featured ?? 0);
      if (a.popular !== b.popular) return (b.popular ?? 0) - (a.popular ?? 0);
      return a.name.localeCompare(b.name);
    });
  }, [search, categoryFilter, entries]);

  const handleCardClick = useCallback((entry: ApplicationCatalogResponse) => {
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
            placeholder="Search applications..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 py-2 pl-9 pr-4 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            data-testid="catalog-search"
          />
        </div>
        {categories.length > 0 && (
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 py-2 pl-3 pr-8 text-sm text-gray-700 dark:text-gray-300 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
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

      {isLoading && (
        <div className="flex items-center justify-center py-12" data-testid="loading-spinner">
          <Loader2 size={24} className="animate-spin text-brand-500" />
          <span className="ml-2 text-sm text-gray-500 dark:text-gray-400">Loading application catalog...</span>
        </div>
      )}

      {isError && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-700 dark:text-red-400" data-testid="error-message">
          <AlertCircle size={16} />
          <span>Failed to load application catalog: {error?.message ?? 'Unknown error'}</span>
        </div>
      )}

      {!isLoading && !isError && (
        <>
          {filteredEntries.length === 0 ? (
            <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 px-5 py-10 text-center text-sm text-gray-500 dark:text-gray-400" data-testid="catalog-empty">
              No applications found matching your search.
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
                      <AppIcon manifestUrl={entry.manifestUrl} size={40} />
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
                    <div className="flex flex-wrap items-center gap-1.5">
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
                      <span className="inline-flex rounded-full bg-brand-50 dark:bg-brand-900/20 px-2.5 py-0.5 text-xs font-medium text-brand-700 dark:text-brand-300">
                        {entry.category ?? 'other'}
                      </span>
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
                  <div className="mt-3 flex items-center gap-2 border-t border-gray-100 dark:border-gray-700 pt-3">
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); toggleFeatured(entry); }}
                      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors hover:bg-gray-100 dark:hover:bg-gray-700"
                      title={entry.featured ? 'Remove Featured' : 'Mark as Featured'}
                    >
                      <Star size={14} className={entry.featured ? 'fill-amber-400 text-amber-400' : 'text-gray-400 dark:text-gray-500'} />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); togglePopular(entry); }}
                      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors hover:bg-gray-100 dark:hover:bg-gray-700"
                      title={entry.popular ? 'Remove Popular' : 'Mark as Popular'}
                    >
                      <Flame size={14} className={entry.popular ? 'fill-orange-400 text-orange-400' : 'text-gray-400 dark:text-gray-500'} />
                    </button>
                  </div>
                </button>
              ))}
            </div>
          )}
          <div className="text-sm text-gray-500 dark:text-gray-400">
            {filteredEntries.length} application{filteredEntries.length !== 1 ? 's' : ''}
          </div>
        </>
      )}

      {selectedEntry && (
        <AppDetailPanel entry={selectedEntry} onClose={handleClose} />
      )}
    </div>
  );
}

// ─── Application Detail Panel ───────────────────────────────────────────────

function SectionHeading({ icon: Icon, title }: { readonly icon: React.ElementType; readonly title: string }) {
  return (
    <h4 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">
      <Icon size={16} className="text-brand-500" />
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
}: {
  readonly entry: ApplicationCatalogResponse;
  readonly onClose: () => void;
}) {
  const resources = asResources(entry.resources);
  const minRes = resources.minimum ?? resources.default;
  const minCpu = minRes?.cpu ?? '0.25';
  const minMemory = minRes?.memory ?? '256Mi';
  const minStorage = minRes?.storage ?? '5Gi';

  const { data: capacityResponse } = useCapacityCheck(minCpu, minMemory, minStorage);
  const capacity = capacityResponse?.data;

  const components = asComponents(entry.components);
  const parameters = asParameters(entry.parameters);
  const networking = asNetworking(entry.networking);
  const volumes = asVolumes(entry.volumes);
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
          {/* Capacity Warning */}
          {capacity && !capacity.fits && (
            <div
              className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-700 px-4 py-3 text-sm text-amber-800 dark:text-amber-300"
              data-testid="capacity-warning"
            >
              <AlertTriangle size={18} className="mt-0.5 shrink-0" />
              <span>Resource warning: {capacity.warnings.join(', ')}</span>
            </div>
          )}

          {/* Header */}
          <div>
            <div className="flex items-start justify-between pr-8">
              <div className="flex items-center gap-4">
                <AppIcon manifestUrl={entry.manifestUrl} size={48} />
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
              <div className="flex flex-wrap items-center gap-1.5">
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
                <span className="inline-flex rounded-full bg-brand-50 dark:bg-brand-900/20 px-3 py-1 text-xs font-medium text-brand-700 dark:text-brand-300">
                  {entry.category ?? 'other'}
                </span>
              </div>
            </div>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{entry.description}</p>
          </div>

          {/* Resource Requirements */}
          {(resources.default ?? resources.minimum) && (
            <div>
              <SectionHeading icon={Cpu} title="Resource Requirements" />
              <div className="grid grid-cols-2 gap-4">
                {resources.default && (
                  <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-3">
                    <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">Default</p>
                    <div className="space-y-1 text-sm">
                      <div className="flex justify-between"><span className="text-gray-500">CPU</span><span className="font-medium text-gray-900 dark:text-gray-100">{resources.default.cpu}</span></div>
                      <div className="flex justify-between"><span className="text-gray-500">Memory</span><span className="font-medium text-gray-900 dark:text-gray-100">{resources.default.memory}</span></div>
                      <div className="flex justify-between"><span className="text-gray-500">Storage</span><span className="font-medium text-gray-900 dark:text-gray-100">{resources.default.storage}</span></div>
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
                      <th className="px-3 py-2">Name</th>
                      <th className="px-3 py-2">Mount Path</th>
                      <th className="px-3 py-2">Default Size</th>
                      <th className="px-3 py-2">Description</th>
                      <th className="px-3 py-2"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                    {volumes.map((vol) => (
                      <tr key={vol.name ?? Math.random()}>
                        <td className="px-3 py-2 font-medium text-gray-900 dark:text-gray-100">{vol.name}</td>
                        <td className="px-3 py-2 font-mono text-xs text-gray-500 dark:text-gray-400">{vol.mount_path}</td>
                        <td className="px-3 py-2 text-gray-600 dark:text-gray-400">{vol.default_size ?? '-'}</td>
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
              disabled
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white opacity-50 cursor-not-allowed"
              data-testid="install-button"
            >
              Install (Phase 2)
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

// ─── Static Tabs ────────────────────────────────────────────────────────────

function InstalledTab() {
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 px-5 py-10 text-center" data-testid="installed-tab">
      <p className="text-sm text-gray-500 dark:text-gray-400">Application deployment coming in Phase 2</p>
    </div>
  );
}

function RepositoriesTab() {
  return (
    <div data-testid="repos-tab">
      <ApplicationRepoSettings />
    </div>
  );
}
