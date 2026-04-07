import { useState } from 'react';
import { Activity, AlertTriangle, Clock, BarChart3 } from 'lucide-react';
import StatCard from '@/components/ui/StatCard';
import StatusBadge from '@/components/ui/StatusBadge';
import ResourceBar from '@/components/ui/ResourceBar';
import PaginationBar from '@/components/ui/PaginationBar';
import { usePlatformStatus } from '@/hooks/use-dashboard';
import { useAuditLogs, type AuditLogEntry } from '@/hooks/use-audit-logs';
import { useCursorPagination } from '@/hooks/use-cursor-pagination';
import { useSortable } from '@/hooks/use-sortable';
import SortableHeader from '@/components/ui/SortableHeader';
import StorageUsageTab from '@/components/StorageUsageTab';

type Tab = 'active-alerts' | 'alert-history' | 'system-metrics' | 'storage';

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

  const platformStatus = statusData?.data?.status ?? 'unknown';
  const entries = auditData?.data ?? [];
  const totalCount = auditData?.pagination?.total_count ?? 0;
  const hasMore = auditData?.pagination?.has_more ?? false;
  const nextCursor = auditData?.pagination?.cursor ?? null;
  const { recent, older } = splitAlerts(entries);
  const alertCount = recent.length;

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

        {activeTab !== 'system-metrics' && activeTab !== 'storage' && (
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
