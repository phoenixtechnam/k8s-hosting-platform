import { useState, useMemo, useCallback } from 'react';
import { API_BASE } from '@/lib/api-client';
import { useNavigate } from 'react-router-dom';
import { AppWindow, Search, Loader2, AlertCircle, AlertTriangle, X, Globe, HardDrive, Cpu, Heart, Settings2, Network, Box, ExternalLink, Star, Flame, ChevronDown, RotateCcw, History, LayoutGrid, Tag, Play, Square, RefreshCw, Trash2, CheckSquare, ChevronLeft, ChevronRight } from 'lucide-react';
import clsx from 'clsx';
import CatalogRepoSettings from '@/components/CatalogRepoSettings';
import { useCatalog, useUpdateCatalogBadges, useCatalogEntryVersions } from '@/hooks/use-catalog';
import type { CatalogEntry } from '@/hooks/use-catalog';
import { useCapacityCheck } from '@/hooks/use-capacity-check';
import {
  useAdminDeployments,
  useBulkStartDeployments,
  useBulkStopDeployments,
  useBulkDeleteDeployments,
  useApplicationUpgrades,
  useRollbackUpgrade,
} from '@/hooks/use-application-upgrades';
import { useBulkRestartDeployments } from '@/hooks/use-deployments';
import StatusBadge from '@/components/ui/StatusBadge';

type Tab = 'catalog' | 'installed' | 'upgrades' | 'repos';

const TABS: readonly { readonly id: Tab; readonly label: string }[] = [
  { id: 'catalog', label: 'Catalog' },
  { id: 'installed', label: 'Installed' },
  { id: 'upgrades', label: 'Upgrade History' },
  { id: 'repos', label: 'Repositories' },
] as const;

export default function Applications() {
  const [activeTab, setActiveTab] = useState<Tab>('catalog');

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <AppWindow size={28} className="text-brand-500" />
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100" data-testid="applications-heading">Applications</h1>
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
      {activeTab === 'upgrades' && <UpgradeHistoryTab />}
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
  return `${API_BASE}/api/v1/catalog/${entryId}/icon`;
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

// ─── Catalog Tab ────────────────────────────────────────────────────────────

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

function CatalogTab() {
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('All');
  const [selectedEntry, setSelectedEntry] = useState<CatalogEntry | null>(null);
  const { data: response, isLoading, isError, error } = useCatalog();
  const updateBadges = useUpdateCatalogBadges();

  const entries = response?.data ?? [];

  const toggleFeatured = useCallback((entry: CatalogEntry) => {
    updateBadges.mutate({ id: entry.id, featured: !entry.featured });
  }, [updateBadges]);

  const togglePopular = useCallback((entry: CatalogEntry) => {
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

    return [...result].sort((a, b) => {
      if (a.featured !== b.featured) return (b.featured ?? 0) - (a.featured ?? 0);
      if (a.popular !== b.popular) return (b.popular ?? 0) - (a.popular ?? 0);
      return a.name.localeCompare(b.name);
    });
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

      <div className="flex flex-wrap gap-2" data-testid="type-filter-pills">
        {TYPE_FILTERS.map((tf) => (
          <button
            key={tf}
            type="button"
            onClick={() => setTypeFilter(tf)}
            className={clsx(
              'rounded-full px-3 py-1 text-xs font-medium transition-colors',
              typeFilter === tf
                ? 'bg-brand-500 text-white dark:bg-brand-600'
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
          <Loader2 size={24} className="animate-spin text-brand-500" />
          <span className="ml-2 text-sm text-gray-500 dark:text-gray-400">Loading catalog...</span>
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
              No entries found matching your filters.
            </div>
          ) : (
            <CatalogSections entries={filteredEntries} onCardClick={handleCardClick} toggleFeatured={toggleFeatured} togglePopular={togglePopular} />
          )}
          <div className="text-sm text-gray-500 dark:text-gray-400">
            {filteredEntries.length} entr{filteredEntries.length !== 1 ? 'ies' : 'y'}
          </div>
        </>
      )}

      {selectedEntry && (
        <AppDetailPanel entry={selectedEntry} onClose={handleClose} />
      )}
    </div>
  );
}

function CatalogSectionHeading({ icon: Icon, title, count, color }: { readonly icon: React.ElementType; readonly title: string; readonly count: number; readonly color: string }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <Icon size={18} className={color} />
      <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
      <span className="text-xs text-gray-400">({count})</span>
    </div>
  );
}

function CatalogSections({
  entries,
  onCardClick,
  toggleFeatured,
  togglePopular,
}: {
  readonly entries: readonly CatalogEntry[];
  readonly onCardClick: (entry: CatalogEntry) => void;
  readonly toggleFeatured: (entry: CatalogEntry) => void;
  readonly togglePopular: (entry: CatalogEntry) => void;
}) {
  const featuredEntries = useMemo(() => entries.filter((e) => e.featured), [entries]);
  const popularEntries = useMemo(() => entries.filter((e) => e.popular), [entries]);

  return (
    <div className="space-y-6" data-testid="catalog-grid">
      {featuredEntries.length > 0 && (
        <div data-testid="catalog-section-featured">
          <CatalogSectionHeading icon={Star} title="Featured" count={featuredEntries.length} color="text-amber-500" />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {featuredEntries.map((entry) => (
              <AdminCatalogCard key={`featured-${entry.id}`} entry={entry} onCardClick={onCardClick} toggleFeatured={toggleFeatured} togglePopular={togglePopular} />
            ))}
          </div>
        </div>
      )}

      {popularEntries.length > 0 && (
        <div data-testid="catalog-section-popular">
          <CatalogSectionHeading icon={Flame} title="Popular" count={popularEntries.length} color="text-orange-500" />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {popularEntries.map((entry) => (
              <AdminCatalogCard key={`popular-${entry.id}`} entry={entry} onCardClick={onCardClick} toggleFeatured={toggleFeatured} togglePopular={togglePopular} />
            ))}
          </div>
        </div>
      )}

      <div data-testid="catalog-section-all">
        <CatalogSectionHeading icon={LayoutGrid} title="All Applications" count={entries.length} color="text-gray-500 dark:text-gray-400" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {entries.map((entry) => (
            <AdminCatalogCard key={`all-${entry.id}`} entry={entry} onCardClick={onCardClick} toggleFeatured={toggleFeatured} togglePopular={togglePopular} />
          ))}
        </div>
      </div>
    </div>
  );
}

function AdminCatalogCard({
  entry,
  onCardClick,
  toggleFeatured,
  togglePopular,
}: {
  readonly entry: CatalogEntry;
  readonly onCardClick: (entry: CatalogEntry) => void;
  readonly toggleFeatured: (entry: CatalogEntry) => void;
  readonly togglePopular: (entry: CatalogEntry) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onCardClick(entry)}
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
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="inline-flex rounded-full bg-purple-50 dark:bg-purple-900/20 px-2.5 py-0.5 text-xs font-medium text-purple-700 dark:text-purple-300">
            {entry.type ?? 'unknown'}
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
          {(Array.isArray(entry.tags) ? entry.tags as string[] : []).map((tag: string) => (
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
  readonly entry: CatalogEntry;
  readonly onClose: () => void;
}) {
  const resources = asResources(entry.resources);
  const minRes = resources.minimum ?? resources.recommended;
  const minCpu = minRes?.cpu ?? '0.25';
  const minMemory = minRes?.memory ?? '256Mi';
  const minStorage = minRes?.storage ?? '5Gi';

  const { data: capacityResponse } = useCapacityCheck(minCpu, minMemory, minStorage);
  const capacity = capacityResponse?.data;

  const { data: versionsData } = useCatalogEntryVersions(entry.id);
  const versions = versionsData?.data ?? [];

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

          {/* Supported Versions */}
          {versions.length > 0 && (
            <div>
              <SectionHeading icon={Tag} title="Supported Versions" />
              <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 dark:bg-gray-700/50 text-left text-xs font-medium text-gray-500 dark:text-gray-400">
                      <th className="px-3 py-2">Version</th>
                      <th className="px-3 py-2">Image</th>
                      <th className="px-3 py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                    {versions.map(v => (
                      <tr key={v.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                        <td className="px-3 py-2 font-medium text-gray-900 dark:text-gray-100">
                          {v.version}
                          {v.isDefault ? <span className="ml-2 inline-flex rounded-full bg-blue-100 dark:bg-blue-900/40 px-2 py-0.5 text-[10px] font-medium text-blue-700 dark:text-blue-300">default</span> : null}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-gray-600 dark:text-gray-400">{v.components?.[0]?.image ?? '-'}</td>
                        <td className="px-3 py-2">
                          <span className="inline-flex rounded-full bg-green-100 dark:bg-green-900/40 px-2 py-0.5 text-[10px] font-medium text-green-700 dark:text-green-300">{v.status}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Footer */}
          <div className="flex items-center justify-end gap-3 border-t border-gray-200 dark:border-gray-700 pt-4">
            <span className="text-xs text-gray-400 dark:text-gray-500">Deploy from client panel</span>
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

// ─── Installed Applications Tab ─────────────────────────────────────────────

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'running', label: 'Running' },
  { value: 'stopped', label: 'Stopped' },
  { value: 'failed', label: 'Failed' },
  { value: 'pending', label: 'Pending' },
  { value: 'deploying', label: 'Deploying' },
] as const;

function InstalledTab() {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectAll, setSelectAll] = useState(false);
  const [bulkAction, setBulkAction] = useState<'start' | 'stop' | 'restart' | 'delete' | null>(null);
  const [sortField, setSortField] = useState<'name' | 'status' | 'createdAt' | 'node'>('createdAt');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [searchQuery, setSearchQuery] = useState('');

  const { data: response, isLoading, isError, error } = useAdminDeployments({
    page,
    limit: 50,
    status: statusFilter || undefined,
  });

  const bulkRestart = useBulkRestartDeployments();
  const bulkStart = useBulkStartDeployments();
  const bulkStop = useBulkStopDeployments();
  const bulkDelete = useBulkDeleteDeployments();

  const deployments = response?.data ?? [];
  const pagination = response?.pagination;
  const totalCount = pagination?.total_count ?? 0;
  const totalPages = pagination?.total_pages ?? 1;

  // Filter by search query first, then sort. Searching across all
  // operator-relevant fields (app name, deployment name, client,
  // status, current node) — picking by node is the most common
  // post-drain triage query.
  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return deployments;
    return deployments.filter((d) => {
      const haystack = [
        d.name, d.catalogEntryName, d.catalogEntryCode, d.catalogEntryType,
        d.clientName, d.status, d.currentNodeName, d.installedVersion,
      ].filter((v): v is string => Boolean(v)).join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }, [deployments, searchQuery]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      let cmp = 0;
      if (sortField === 'name') cmp = a.name.localeCompare(b.name);
      else if (sortField === 'status') cmp = a.status.localeCompare(b.status);
      else if (sortField === 'node') {
        cmp = (a.currentNodeName ?? '').localeCompare(b.currentNodeName ?? '');
      }
      else cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [filtered, sortField, sortDir]);

  const handleSort = useCallback((field: typeof sortField) => {
    if (sortField === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortField(field); setSortDir('asc'); }
  }, [sortField]);

  const toggleSelect = useCallback((id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    setSelectAll(false);
  }, []);

  const handleSelectAll = useCallback(() => {
    if (selectAll) {
      setSelected(new Set());
      setSelectAll(false);
    } else {
      setSelected(new Set(deployments.map(d => d.id)));
      setSelectAll(true);
    }
  }, [selectAll, deployments]);

  const selectedIds = useMemo(() => [...selected], [selected]);
  const selectedDeployments = useMemo(() => deployments.filter(d => selected.has(d.id)), [deployments, selected]);

  const executeBulkAction = useCallback(async () => {
    if (!bulkAction || selectedIds.length === 0) return;
    try {
      if (bulkAction === 'start') await bulkStart.mutateAsync(selectedIds);
      else if (bulkAction === 'stop') await bulkStop.mutateAsync(selectedIds);
      else if (bulkAction === 'restart') await bulkRestart.mutateAsync(undefined);
      else if (bulkAction === 'delete') await bulkDelete.mutateAsync(selectedIds);
      setSelected(new Set());
      setSelectAll(false);
    } catch {
      // mutation error handled by TanStack Query
    }
    setBulkAction(null);
  }, [bulkAction, selectedIds, bulkStart, bulkStop, bulkRestart, bulkDelete]);

  const isBulkPending = bulkStart.isPending || bulkStop.isPending || bulkRestart.isPending || bulkDelete.isPending;

  const sortIndicator = (field: typeof sortField) => {
    if (sortField !== field) return null;
    return <span className="ml-1 text-brand-500">{sortDir === 'asc' ? '\u2191' : '\u2193'}</span>;
  };

  return (
    <div className="space-y-4" data-testid="installed-tab">
      {/* Filter bar */}
      <div className="flex items-center gap-3">
        <select
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 py-2 pl-3 pr-8 text-sm text-gray-700 dark:text-gray-300 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          data-testid="installed-status-filter"
        >
          {STATUS_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        <input
          type="search"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search by app, client, status, node…"
          className="flex-1 max-w-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-700 dark:text-gray-300 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          data-testid="installed-search"
        />
        <span className="text-sm text-gray-500 dark:text-gray-400">
          {searchQuery ? `${sorted.length} of ${totalCount}` : `${totalCount} deployment${totalCount !== 1 ? 's' : ''}`}
        </span>
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="flex items-center gap-3 rounded-lg border border-brand-200 dark:border-brand-800 bg-brand-50 dark:bg-brand-900/20 px-4 py-2.5" data-testid="bulk-action-bar">
          <span className="text-sm font-medium text-brand-700 dark:text-brand-300">{selected.size} selected</span>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => { setBulkAction('start'); }}
              disabled={isBulkPending}
              className="inline-flex items-center gap-1.5 rounded-md bg-green-50 dark:bg-green-900/20 px-3 py-1.5 text-xs font-medium text-green-700 dark:text-green-300 hover:bg-green-100 dark:hover:bg-green-800/40 transition-colors disabled:opacity-50"
              data-testid="bulk-start-btn"
            >
              <Play size={12} /> Start
            </button>
            <button
              type="button"
              onClick={() => { setBulkAction('stop'); }}
              disabled={isBulkPending}
              className="inline-flex items-center gap-1.5 rounded-md bg-gray-100 dark:bg-gray-700 px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors disabled:opacity-50"
              data-testid="bulk-stop-btn"
            >
              <Square size={12} /> Stop
            </button>
            <button
              type="button"
              onClick={() => { setBulkAction('restart'); }}
              disabled={isBulkPending}
              className="inline-flex items-center gap-1.5 rounded-md bg-blue-50 dark:bg-blue-900/20 px-3 py-1.5 text-xs font-medium text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-800/40 transition-colors disabled:opacity-50"
              data-testid="bulk-restart-btn"
            >
              <RefreshCw size={12} /> Pull &amp; Restart
            </button>
            <button
              type="button"
              onClick={() => { setBulkAction('delete'); }}
              disabled={isBulkPending}
              className="inline-flex items-center gap-1.5 rounded-md bg-red-50 dark:bg-red-900/20 px-3 py-1.5 text-xs font-medium text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-800/40 transition-colors disabled:opacity-50"
              data-testid="bulk-delete-btn"
            >
              <Trash2 size={12} /> Remove
            </button>
          </div>
        </div>
      )}

      {/* Bulk action confirmation modal */}
      {bulkAction && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" data-testid="bulk-confirm-modal">
          <div className="w-full max-w-md rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-xl">
            <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 px-6 py-4">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                Confirm {bulkAction === 'delete' ? 'Remove' : bulkAction.charAt(0).toUpperCase() + bulkAction.slice(1)}
              </h3>
              <button type="button" onClick={() => setBulkAction(null)} className="rounded-md p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
                <X size={20} />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <p className="text-sm text-gray-600 dark:text-gray-400">
                {bulkAction === 'delete'
                  ? `Are you sure you want to remove ${selectedIds.length} deployment${selectedIds.length !== 1 ? 's' : ''}? This action cannot be undone.`
                  : `${bulkAction.charAt(0).toUpperCase() + bulkAction.slice(1)} ${selectedIds.length} deployment${selectedIds.length !== 1 ? 's' : ''}?`}
              </p>
              {bulkAction === 'delete' && selectedDeployments.length > 0 && (
                <div className="max-h-40 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700 p-3">
                  <ul className="space-y-1 text-sm text-gray-700 dark:text-gray-300">
                    {selectedDeployments.map(d => (
                      <li key={d.id} className="flex items-center gap-2">
                        <span className="font-medium">{d.catalogEntryName ?? d.name}</span>
                        <span className="text-gray-400">({d.name})</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="flex justify-end gap-3 border-t border-gray-200 dark:border-gray-700 pt-4">
                <button
                  type="button"
                  onClick={() => setBulkAction(null)}
                  className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={executeBulkAction}
                  disabled={isBulkPending}
                  className={clsx(
                    'inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50',
                    bulkAction === 'delete' ? 'bg-red-600 hover:bg-red-700' : 'bg-brand-500 hover:bg-brand-600',
                  )}
                  data-testid="bulk-confirm-btn"
                >
                  {isBulkPending && <Loader2 size={14} className="animate-spin" />}
                  {bulkAction === 'delete' ? 'Remove' : bulkAction.charAt(0).toUpperCase() + bulkAction.slice(1)}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Loading */}
      {isLoading && (
        <div className="flex items-center justify-center py-12" data-testid="installed-loading">
          <Loader2 size={24} className="animate-spin text-brand-500" />
          <span className="ml-2 text-sm text-gray-500 dark:text-gray-400">Loading deployments...</span>
        </div>
      )}

      {/* Error */}
      {isError && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-700 dark:text-red-400" data-testid="installed-error">
          <AlertCircle size={16} />
          <span>Failed to load deployments: {error?.message ?? 'Unknown error'}</span>
        </div>
      )}

      {/* Table */}
      {!isLoading && !isError && (
        <>
          {sorted.length === 0 ? (
            <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 px-5 py-10 text-center text-sm text-gray-500 dark:text-gray-400" data-testid="installed-empty">
              No deployments found.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
              <table className="w-full text-sm" data-testid="deployments-table">
                <thead>
                  <tr className="border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    <th className="px-3 py-3 w-10">
                      <button type="button" onClick={handleSelectAll} className="flex items-center justify-center" data-testid="select-all-checkbox">
                        <CheckSquare size={16} className={selectAll ? 'text-brand-500' : 'text-gray-400 dark:text-gray-500'} />
                      </button>
                    </th>
                    <th className="px-3 py-3">
                      <button type="button" onClick={() => handleSort('name')} className="inline-flex items-center hover:text-gray-700 dark:hover:text-gray-200">
                        App Name{sortIndicator('name')}
                      </button>
                    </th>
                    <th className="px-3 py-3">Deployment</th>
                    <th className="px-3 py-3">Client</th>
                    <th className="px-3 py-3">
                      <button type="button" onClick={() => handleSort('status')} className="inline-flex items-center hover:text-gray-700 dark:hover:text-gray-200">
                        Status{sortIndicator('status')}
                      </button>
                    </th>
                    <th className="px-3 py-3">
                      <button type="button" onClick={() => handleSort('node')} className="inline-flex items-center hover:text-gray-700 dark:hover:text-gray-200">
                        Node{sortIndicator('node')}
                      </button>
                    </th>
                    <th className="px-3 py-3">CPU</th>
                    <th className="px-3 py-3">Memory</th>
                    <th className="px-3 py-3">Version</th>
                    <th className="px-3 py-3">
                      <button type="button" onClick={() => handleSort('createdAt')} className="inline-flex items-center hover:text-gray-700 dark:hover:text-gray-200">
                        Created{sortIndicator('createdAt')}
                      </button>
                    </th>
                    <th className="px-3 py-3">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {sorted.map((d) => {
                    const isRunning = d.status === 'running';
                    const isStopped = d.status === 'stopped' || d.status === 'failed';
                    return (
                      <tr key={d.id} className={clsx('hover:bg-gray-50 dark:hover:bg-gray-800/50', selected.has(d.id) && 'bg-brand-50/50 dark:bg-brand-900/10')}>
                        <td className="px-3 py-3">
                          <button type="button" onClick={() => toggleSelect(d.id)} className="flex items-center justify-center" data-testid={`select-${d.id}`}>
                            <CheckSquare size={16} className={selected.has(d.id) ? 'text-brand-500' : 'text-gray-300 dark:text-gray-600'} />
                          </button>
                        </td>
                        <td className="px-3 py-3">
                          <span className="font-semibold text-gray-900 dark:text-gray-100">{d.catalogEntryName ?? d.catalogEntryCode ?? '-'}</span>
                          {d.catalogEntryType && (
                            <span className="ml-2 inline-flex rounded-full bg-purple-50 dark:bg-purple-900/20 px-2 py-0.5 text-[10px] font-medium text-purple-700 dark:text-purple-300">
                              {d.catalogEntryType}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-3">
                          <button
                            type="button"
                            onClick={() => navigate(`/clients/${d.clientId}`)}
                            className="text-brand-600 dark:text-brand-400 hover:underline text-sm"
                          >
                            {d.name}
                          </button>
                        </td>
                        <td className="px-3 py-3">
                          <button
                            type="button"
                            onClick={() => navigate(`/clients/${d.clientId}`)}
                            className="text-brand-600 dark:text-brand-400 hover:underline text-sm"
                          >
                            {d.clientName ?? d.clientId.slice(0, 8)}
                          </button>
                        </td>
                        <td className="px-3 py-3">
                          <StatusBadge status={d.status as Parameters<typeof StatusBadge>[0]['status']} />
                        </td>
                        <td className="px-3 py-3 text-gray-700 dark:text-gray-300 text-xs font-mono">
                          {d.currentNodeName ?? <span className="text-gray-400">—</span>}
                        </td>
                        <td className="px-3 py-3 text-gray-600 dark:text-gray-400 text-xs font-mono">{d.cpuRequest}</td>
                        <td className="px-3 py-3 text-gray-600 dark:text-gray-400 text-xs font-mono">{d.memoryRequest}</td>
                        <td className="px-3 py-3 text-gray-700 dark:text-gray-300 text-xs">
                          {d.installedVersion ? `v${d.installedVersion}` : '-'}
                        </td>
                        <td className="px-3 py-3 text-gray-500 dark:text-gray-400 text-xs" title={new Date(d.createdAt).toLocaleString()}>
                          {relativeTime(d.createdAt)}
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex items-center gap-1">
                            {isStopped && (
                              <button
                                type="button"
                                onClick={() => { setSelected(new Set([d.id])); setBulkAction('start'); }}
                                className="rounded-md p-1.5 text-green-600 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-900/20 transition-colors"
                                title="Start"
                                data-testid={`start-btn-${d.id}`}
                              >
                                <Play size={14} />
                              </button>
                            )}
                            {isRunning && (
                              <button
                                type="button"
                                onClick={() => { setSelected(new Set([d.id])); setBulkAction('stop'); }}
                                className="rounded-md p-1.5 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                                title="Stop"
                                data-testid={`stop-btn-${d.id}`}
                              >
                                <Square size={14} />
                              </button>
                            )}
                            {isRunning && (
                              <button
                                type="button"
                                onClick={() => { setSelected(new Set([d.id])); setBulkAction('restart'); }}
                                className="rounded-md p-1.5 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
                                title="Pull &amp; Restart"
                                data-testid={`restart-btn-${d.id}`}
                              >
                                <RefreshCw size={14} />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between pt-2" data-testid="pagination">
              <span className="text-sm text-gray-500 dark:text-gray-400">
                Page {page} of {totalPages}
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="inline-flex items-center rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2.5 py-1.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 disabled:opacity-50 disabled:cursor-not-allowed"
                  data-testid="prev-page"
                >
                  <ChevronLeft size={14} />
                </button>
                {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                  let pageNum: number;
                  if (totalPages <= 7) {
                    pageNum = i + 1;
                  } else if (page <= 4) {
                    pageNum = i + 1;
                  } else if (page >= totalPages - 3) {
                    pageNum = totalPages - 6 + i;
                  } else {
                    pageNum = page - 3 + i;
                  }
                  return (
                    <button
                      key={pageNum}
                      type="button"
                      onClick={() => setPage(pageNum)}
                      className={clsx(
                        'rounded-md px-3 py-1.5 text-sm font-medium',
                        pageNum === page
                          ? 'bg-brand-500 text-white'
                          : 'border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50',
                      )}
                    >
                      {pageNum}
                    </button>
                  );
                })}
                <button
                  type="button"
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                  className="inline-flex items-center rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2.5 py-1.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 disabled:opacity-50 disabled:cursor-not-allowed"
                  data-testid="next-page"
                >
                  <ChevronRight size={14} />
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Upgrade History Tab ────────────────────────────────────────────────────

function UpgradeHistoryTab() {
  const [statusFilter, setStatusFilter] = useState('');
  const { data: response, isLoading, isError, error } = useApplicationUpgrades(
    statusFilter ? { status: statusFilter } : undefined,
  );
  const rollback = useRollbackUpgrade();

  const upgrades = response?.data ?? [];

  return (
    <div className="space-y-4" data-testid="upgrades-tab">
      <div className="flex items-center gap-3">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 py-2 pl-3 pr-8 text-sm text-gray-700 dark:text-gray-300 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          data-testid="status-filter"
        >
          <option value="">All statuses</option>
          <option value="pending">Pending</option>
          <option value="upgrading">In Progress</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
          <option value="rolled_back">Rolled Back</option>
        </select>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 size={24} className="animate-spin text-brand-500" />
          <span className="ml-2 text-sm text-gray-500 dark:text-gray-400">Loading upgrade history...</span>
        </div>
      )}

      {isError && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-700 dark:text-red-400">
          <AlertCircle size={16} />
          <span>Failed to load upgrade history: {error?.message ?? 'Unknown error'}</span>
        </div>
      )}

      {!isLoading && !isError && (
        <>
          {upgrades.length === 0 ? (
            <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 px-5 py-10 text-center text-sm text-gray-500 dark:text-gray-400">
              <History size={32} className="mx-auto mb-2 text-gray-400" />
              No upgrade records found.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
              <table className="w-full text-sm" data-testid="upgrades-table">
                <thead>
                  <tr className="border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    <th className="px-4 py-3">Instance</th>
                    <th className="px-4 py-3">From</th>
                    <th className="px-4 py-3">To</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Progress</th>
                    <th className="px-4 py-3">Trigger</th>
                    <th className="px-4 py-3">Started</th>
                    <th className="px-4 py-3">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {upgrades.map((u) => (
                    <tr key={u.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                      <td className="px-4 py-3 font-mono text-xs text-gray-600 dark:text-gray-400">
                        {u.deploymentId.slice(0, 8)}...
                      </td>
                      <td className="px-4 py-3 text-gray-900 dark:text-gray-100">v{u.fromVersion}</td>
                      <td className="px-4 py-3 text-gray-900 dark:text-gray-100">v{u.toVersion}</td>
                      <td className="px-4 py-3">
                        <StatusBadge status={u.status as Parameters<typeof StatusBadge>[0]['status']} />
                      </td>
                      <td className="px-4 py-3">
                        {u.progressPct >= 0 ? (
                          <div className="flex items-center gap-2">
                            <div className="h-1.5 w-16 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
                              <div
                                className={clsx(
                                  'h-full rounded-full',
                                  u.status === 'failed' ? 'bg-red-500' : u.status === 'completed' ? 'bg-green-500' : 'bg-brand-500',
                                )}
                                style={{ width: `${u.progressPct}%` }}
                              />
                            </div>
                            <span className="text-xs text-gray-500">{u.progressPct}%</span>
                          </div>
                        ) : (
                          <span className="text-xs text-gray-400">-</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={clsx(
                          'inline-flex rounded-full px-2 py-0.5 text-xs font-medium',
                          u.triggerType === 'forced' ? 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300' :
                          u.triggerType === 'batch' ? 'bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300' :
                          'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400',
                        )}>
                          {u.triggerType}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">
                        {u.startedAt ? new Date(u.startedAt).toLocaleString() : '-'}
                      </td>
                      <td className="px-4 py-3">
                        {u.status === 'failed' && (
                          <button
                            type="button"
                            onClick={() => rollback.mutate(u.id)}
                            disabled={rollback.isPending}
                            className="inline-flex items-center gap-1 rounded-md bg-orange-50 dark:bg-orange-900/20 px-2.5 py-1 text-xs font-medium text-orange-700 dark:text-orange-300 hover:bg-orange-100 dark:hover:bg-orange-800/50 transition-colors"
                            data-testid={`rollback-btn-${u.id}`}
                          >
                            <RotateCcw size={10} /> Rollback
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="text-sm text-gray-500 dark:text-gray-400">
            {upgrades.length} upgrade record{upgrades.length !== 1 ? 's' : ''}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Repositories Tab ───────────────────────────────────────────────────────

function RepositoriesTab() {
  return (
    <div data-testid="repos-tab">
      <CatalogRepoSettings />
    </div>
  );
}
