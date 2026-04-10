import { useState } from 'react';
import { Activity, AlertTriangle, Clock, BarChart3, Server, Loader2 } from 'lucide-react';
import StatCard from '@/components/ui/StatCard';
import StatusBadge from '@/components/ui/StatusBadge';
import ResourceBar from '@/components/ui/ResourceBar';
import PaginationBar from '@/components/ui/PaginationBar';
import { usePlatformStatus } from '@/hooks/use-dashboard';
import { useAuditLogs, type AuditLogEntry } from '@/hooks/use-audit-logs';
import { usePods, type PodEntry } from '@/hooks/use-pods';
import { useCursorPagination } from '@/hooks/use-cursor-pagination';
import { useSortable } from '@/hooks/use-sortable';
import SortableHeader from '@/components/ui/SortableHeader';
import StorageUsageTab from '@/components/StorageUsageTab';

type Tab = 'active-alerts' | 'alert-history' | 'system-metrics' | 'storage' | 'pods';

interface Alert {
  readonly id: string;
  readonly severity: 'critical' | 'warning' | 'info';
  readonly message: string;
  readonly service: string;
  readonly time: string;
}

function deriveSeverity(httpStatus: number | null): 'critical' | 'warning' | 'info' {
  if (httpStatus === null) return 'info';
  if (httpStatus >= 500) return 'critical';
  if (httpStatus >= 400) return 'warning';
  return 'info';
}

function formatTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMinutes = Math.floor(diffMs / 60_000);

  if (diffMinutes < 1) return 'just now';
  if (diffMinutes < 60) return `${diffMinutes} min ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
}

function toAlert(entry: AuditLogEntry): Alert {
  return {
    id: entry.id,
    severity: deriveSeverity(entry.httpStatus),
    message: `${entry.actionType} ${entry.resourceType}`,
    service: entry.httpPath ?? 'unknown',
    time: formatTime(entry.createdAt),
  };
}

const RECENT_THRESHOLD_HOURS = 24;

function splitAlerts(entries: readonly AuditLogEntry[]): {
  readonly recent: readonly Alert[];
  readonly older: readonly Alert[];
} {
  const cutoff = new Date(Date.now() - RECENT_THRESHOLD_HOURS * 60 * 60 * 1000);
  const recent: Alert[] = [];
  const older: Alert[] = [];

  for (const entry of entries) {
    const alert = toAlert(entry);
    if (new Date(entry.createdAt) >= cutoff) {
      recent.push(alert);
    } else {
      older.push(alert);
    }
  }

  return { recent, older };
}

const TABS: readonly { readonly key: Tab; readonly label: string }[] = [
  { key: 'active-alerts', label: 'Active Alerts' },
  { key: 'alert-history', label: 'Alert History' },
  { key: 'system-metrics', label: 'System Metrics' },
  { key: 'storage', label: 'Storage Usage' },
  { key: 'pods', label: 'Pods' },
] as const;

const severityToBadgeStatus = {
  critical: 'error',
  warning: 'warning',
  info: 'active',
} as const;

function AlertTable({
  alerts,
  resolved = false,
  isLoading = false,
}: {
  readonly alerts: readonly Alert[];
  readonly resolved?: boolean;
  readonly isLoading?: boolean;
}) {
  const { sortedData: sortedAlerts, sortKey, sortDirection, onSort } = useSortable(alerts, 'severity');

  if (isLoading) {
    return (
      <div className="p-8 text-center text-sm text-gray-500 dark:text-gray-400" data-testid="alerts-loading">
        Loading audit logs...
      </div>
    );
  }

  if (alerts.length === 0) {
    return (
      <div className="p-8 text-center text-sm text-gray-500 dark:text-gray-400" data-testid="alerts-empty">
        No audit log entries found.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full" data-testid="alerts-table">
        <thead>
          <tr className="border-b border-gray-100 dark:border-gray-700 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
            <SortableHeader label="Severity" sortKey="severity" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
            <SortableHeader label="Message" sortKey="message" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
            <SortableHeader label="Service" sortKey="service" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="hidden md:table-cell" />
            <SortableHeader label="Time" sortKey="time" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="hidden sm:table-cell" />
            {resolved && <th className="px-5 py-3">Status</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
          {sortedAlerts.map((alert) => (
            <tr key={alert.id} className="transition-colors hover:bg-gray-50 dark:hover:bg-gray-700/50">
              <td className="px-5 py-3.5">
                <StatusBadge
                  status={severityToBadgeStatus[alert.severity]}
                  label={alert.severity}
                />
              </td>
              <td className="px-5 py-3.5 text-sm text-gray-900 dark:text-gray-100">{alert.message}</td>
              <td className="hidden px-5 py-3.5 text-sm text-gray-500 dark:text-gray-400 md:table-cell">
                {alert.service}
              </td>
              <td className="hidden px-5 py-3.5 text-sm text-gray-500 dark:text-gray-400 sm:table-cell">
                {alert.time}
              </td>
              {resolved && (
                <td className="px-5 py-3.5">
                  <StatusBadge status="healthy" label="Resolved" />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SystemMetrics() {
  return (
    <div className="grid grid-cols-1 gap-6 p-5 sm:grid-cols-2" data-testid="system-metrics">
      <ResourceBar label="CPU Usage" used={62} total={100} unit="%" />
      <ResourceBar label="Memory Usage" used={71} total={100} unit="%" />
      <ResourceBar label="Disk Usage" used={45} total={100} unit="%" />
      <ResourceBar label="Network I/O" used={33} total={100} unit="%" />
    </div>
  );
}

export default function Monitoring() {
  const [activeTab, setActiveTab] = useState<Tab>('active-alerts');
  const pagination = useCursorPagination({ defaultLimit: 20 });
  const { data: statusData } = usePlatformStatus();
  const { data: auditData, isLoading: auditLoading } = useAuditLogs({
    limit: pagination.limit,
    cursor: pagination.cursor,
  });
  const { data: podsData, isLoading: podsLoading, isError: podsError } = usePods();

  const platformStatus = statusData?.data?.status ?? 'unknown';
  const entries = auditData?.data ?? [];
  const totalCount = auditData?.pagination?.total_count ?? 0;
  const hasMore = auditData?.pagination?.has_more ?? false;
  const nextCursor = auditData?.pagination?.cursor ?? null;
  const { recent, older } = splitAlerts(entries);
  const alertCount = recent.length;

  // Pod capacity from the admin/pods endpoint
  const podCapacity = podsData?.data?.capacity;
  const podUsedPct = podCapacity && podCapacity.allocatable > 0
    ? Math.round((podCapacity.used / podCapacity.allocatable) * 100)
    : null;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Monitoring</h1>

      <div className="rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 px-4 py-3 text-sm text-blue-700 dark:text-blue-300">
        Metrics shown are placeholder values. Live monitoring data will be available after connecting Prometheus and deploying the monitoring stack.
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title="Platform Status"
          value={platformStatus}
          icon={Activity}
          accent={platformStatus === 'healthy' ? 'green' : 'amber'}
        />
        <StatCard
          title="Active Alerts"
          value={alertCount}
          icon={AlertTriangle}
          accent={alertCount > 0 ? 'red' : 'green'}
        />
        <StatCard
          title="Avg Response Time"
          value="45ms"
          icon={Clock}
          accent="brand"
        />
        <StatCard
          title="Error Rate"
          value="0.2%"
          icon={BarChart3}
          accent="green"
        />
        <StatCard
          title="Pod Usage"
          value={podCapacity
            ? `${podCapacity.used} / ${podCapacity.allocatable}`
            : '—'}
          icon={Server}
          accent={
            podUsedPct !== null && podUsedPct >= 90
              ? 'red'
              : podUsedPct !== null && podUsedPct >= 70
                ? 'amber'
                : 'green'
          }
          data-testid="pod-capacity-tile"
        />
      </div>

      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm">
        <div className="border-b border-gray-200 dark:border-gray-700">
          <nav className="flex gap-0" data-testid="tab-bar">
            {TABS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveTab(tab.key)}
                className={
                  activeTab === tab.key
                    ? 'border-b-2 border-brand-500 px-5 py-3 text-sm font-medium text-brand-600 dark:text-brand-400'
                    : 'border-b-2 border-transparent px-5 py-3 text-sm font-medium text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                }
                data-testid={`tab-${tab.key}`}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        </div>

        {activeTab === 'active-alerts' && (
          <AlertTable alerts={recent} isLoading={auditLoading} />
        )}
        {activeTab === 'alert-history' && (
          <AlertTable alerts={older} resolved isLoading={auditLoading} />
        )}
        {activeTab === 'system-metrics' && <SystemMetrics />}
        {activeTab === 'storage' && <StorageUsageTab />}
        {activeTab === 'pods' && (
          <PodsTab
            pods={podsData?.data?.pods ?? []}
            isLoading={podsLoading}
            isError={podsError}
          />
        )}

        {activeTab !== 'system-metrics' && activeTab !== 'storage' && activeTab !== 'pods' && (
          <PaginationBar
            totalCount={totalCount}
            pageSize={pagination.limit}
            pageIndex={pagination.pageIndex}
            hasPrevPage={pagination.hasPrevPage}
            hasNextPage={hasMore}
            onNext={() => nextCursor && pagination.goNext(nextCursor)}
            onPrev={pagination.goPrev}
            onPageSizeChange={pagination.setPageSize}
          />
        )}
      </div>
    </div>
  );
}

// ─── IMAP Phase 6: Pods tab ────────────────────────────────────────────────

const CLASSIFICATION_BADGES: Record<string, { label: string; classes: string }> = {
  running: { label: 'Running', classes: 'bg-green-50 text-green-700 dark:bg-green-900/40 dark:text-green-300' },
  not_ready: { label: 'Not Ready', classes: 'bg-amber-50 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' },
  pending: { label: 'Pending', classes: 'bg-blue-50 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300' },
  completed: { label: 'Completed', classes: 'bg-gray-50 text-gray-600 dark:bg-gray-700 dark:text-gray-400' },
  failed: { label: 'Failed', classes: 'bg-red-50 text-red-700 dark:bg-red-900/40 dark:text-red-300' },
  orphaned: { label: 'Orphaned', classes: 'bg-purple-50 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300' },
  unknown: { label: 'Unknown', classes: 'bg-gray-50 text-gray-600 dark:bg-gray-700 dark:text-gray-400' },
};

type PodFilter = 'all' | 'running' | 'pending' | 'failed' | 'orphaned' | 'completed';

function PodsTab({
  pods,
  isLoading,
  isError,
}: {
  readonly pods: readonly PodEntry[];
  readonly isLoading: boolean;
  readonly isError: boolean;
}) {
  const [filter, setFilter] = useState<PodFilter>('all');
  const [search, setSearch] = useState('');

  const filtered = pods.filter((p) => {
    if (filter !== 'all' && p.classification !== filter) return false;
    if (search) {
      const term = search.toLowerCase();
      return p.name.toLowerCase().includes(term)
        || p.namespace.toLowerCase().includes(term);
    }
    return true;
  });

  // Group counts for the summary badges
  const counts: Record<string, number> = {};
  for (const p of pods) {
    counts[p.classification] = (counts[p.classification] ?? 0) + 1;
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12" data-testid="pods-loading">
        <Loader2 size={24} className="animate-spin text-brand-500" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="px-5 py-8 text-center text-sm text-red-600 dark:text-red-400" data-testid="pods-error">
        Failed to load pod data. The Kubernetes cluster may be unreachable.
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4" data-testid="pods-tab">
      <div className="flex flex-wrap items-center gap-2">
        {(['all', 'running', 'pending', 'failed', 'orphaned', 'completed'] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              filter === f
                ? 'bg-brand-500 text-white'
                : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600'
            }`}
            data-testid={`pod-filter-${f}`}
          >
            {f === 'all' ? `All (${pods.length})` : `${f.charAt(0).toUpperCase() + f.slice(1)} (${counts[f] ?? 0})`}
          </button>
        ))}
        <input
          type="text"
          placeholder="Search by name or namespace..."
          className="ml-auto rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          data-testid="pod-search"
        />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/50 text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Namespace</th>
              <th className="px-4 py-3">Status</th>
              <th className="hidden px-4 py-3 md:table-cell">Restarts</th>
              <th className="hidden px-4 py-3 lg:table-cell">Node</th>
              <th className="hidden px-4 py-3 xl:table-cell">Age</th>
              <th className="hidden px-4 py-3 xl:table-cell">Waiting</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-gray-500 dark:text-gray-400">
                  {search ? 'No pods match the current search.' : 'No pods in this filter group.'}
                </td>
              </tr>
            )}
            {filtered.map((pod) => {
              const badge = CLASSIFICATION_BADGES[pod.classification] ?? CLASSIFICATION_BADGES.unknown;
              return (
                <tr
                  key={`${pod.namespace}/${pod.name}`}
                  className="border-b border-gray-100 dark:border-gray-700 last:border-0"
                  data-testid={`pod-row-${pod.name}`}
                >
                  <td className="max-w-xs truncate px-4 py-3 font-mono text-xs text-gray-900 dark:text-gray-100">
                    {pod.name}
                  </td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-400">
                    {pod.namespace}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${badge.classes}`}>
                      {badge.label}
                    </span>
                  </td>
                  <td className="hidden px-4 py-3 text-gray-600 dark:text-gray-400 md:table-cell">
                    {pod.restarts > 0 && (
                      <span className={pod.restarts >= 5 ? 'text-red-600 dark:text-red-400 font-medium' : ''}>
                        {pod.restarts}
                      </span>
                    )}
                    {pod.restarts === 0 && '0'}
                  </td>
                  <td className="hidden px-4 py-3 text-gray-500 dark:text-gray-400 lg:table-cell">
                    {pod.node ?? '—'}
                  </td>
                  <td className="hidden px-4 py-3 text-xs text-gray-500 dark:text-gray-400 xl:table-cell">
                    {pod.age ? formatTime(pod.age) : '—'}
                  </td>
                  <td className="hidden px-4 py-3 text-xs text-gray-500 dark:text-gray-400 xl:table-cell">
                    {pod.waitingReason ?? '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-gray-400 dark:text-gray-500" data-testid="pods-count">
        {filtered.length} of {pods.length} pods shown
      </p>
    </div>
  );
}
