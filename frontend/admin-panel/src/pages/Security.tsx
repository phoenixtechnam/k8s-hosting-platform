import { Shield, Lock, FileCheck, ShieldCheck, Loader2 } from 'lucide-react';
import StatCard from '@/components/ui/StatCard';
import StatusBadge from '@/components/ui/StatusBadge';
import { useSortable } from '@/hooks/use-sortable';
import SortableHeader from '@/components/ui/SortableHeader';
import { useAuditLogs } from '@/hooks/use-audit-logs';
import type { AuditLogEntry } from '@/hooks/use-audit-logs';

interface NetworkPolicy {
  readonly id: string;
  readonly name: string;
  readonly namespace: string;
  readonly type: 'ingress' | 'egress' | 'ingress/egress';
  readonly status: 'active' | 'pending' | 'error';
}

interface SecurityEvent {
  readonly id: string;
  readonly event: string;
  readonly severity: 'active' | 'warning' | 'error';
  readonly severityLabel: string;
  readonly source: string;
  readonly timestamp: string;
}

const NETWORK_POLICIES: readonly NetworkPolicy[] = [
  {
    id: 'np-1',
    name: 'deny-all-ingress',
    namespace: 'client-namespaces',
    type: 'ingress',
    status: 'active',
  },
  {
    id: 'np-2',
    name: 'allow-ingress-nginx',
    namespace: 'ingress-system',
    type: 'ingress',
    status: 'active',
  },
  {
    id: 'np-3',
    name: 'allow-dns-egress',
    namespace: 'kube-system',
    type: 'egress',
    status: 'active',
  },
  {
    id: 'np-4',
    name: 'inter-namespace-policy',
    namespace: 'platform',
    type: 'ingress/egress',
    status: 'active',
  },
  {
    id: 'np-5',
    name: 'restrict-metadata-access',
    namespace: 'default',
    type: 'egress',
    status: 'pending',
  },
] as const;

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function mapSeverity(httpStatus: number | null): { severity: SecurityEvent['severity']; severityLabel: string } {
  if (httpStatus === null) return { severity: 'active', severityLabel: 'info' };
  if (httpStatus >= 400) return { severity: 'error', severityLabel: httpStatus >= 500 ? 'critical' : 'error' };
  if (httpStatus >= 300) return { severity: 'warning', severityLabel: 'warning' };
  return { severity: 'active', severityLabel: 'info' };
}

function mapAuditLogToEvent(log: AuditLogEntry): SecurityEvent {
  const { severity, severityLabel } = mapSeverity(log.httpStatus);
  return {
    id: log.id,
    event: log.actionType,
    severity,
    severityLabel,
    source: log.resourceType,
    timestamp: formatRelativeTime(log.createdAt),
  };
}

export default function Security() {
  const { data: auditData, isLoading: auditLoading, error: auditError } = useAuditLogs({ limit: 10 });
  const securityEvents: readonly SecurityEvent[] = (auditData?.data ?? []).map(mapAuditLogToEvent);

  const { sortedData: sortedPolicies, sortKey: policySortKey, sortDirection: policySortDir, onSort: onPolicySort } = useSortable(NETWORK_POLICIES, 'name');
  const { sortedData: sortedEvents, sortKey: eventSortKey, sortDirection: eventSortDir, onSort: onEventSort } = useSortable(securityEvents, 'event');

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Shield size={28} className="text-brand-500" />
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Security</h1>
      </div>

      <div className="rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 px-4 py-3 text-sm text-blue-700 dark:text-blue-300">
        Network policies below are the platform's default configuration. These are automatically applied to all client namespaces.
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard title="Network Policies" value={NETWORK_POLICIES.length} icon={Shield} accent="brand" />
        <StatCard title="Sealed Secrets" value="—" icon={Lock} accent="green" />
        <StatCard title="SSL Certificates" value="—" icon={FileCheck} accent="amber" />
        <StatCard title="Security Score" value="—" icon={ShieldCheck} accent="green" />
      </div>

      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm">
        <div className="border-b border-gray-100 dark:border-gray-700 px-5 py-4">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Network Policies</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full" data-testid="policies-table">
            <thead>
              <tr className="border-b border-gray-100 dark:border-gray-700 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                <SortableHeader label="Policy Name" sortKey="name" currentKey={policySortKey} direction={policySortDir} onSort={onPolicySort} />
                <SortableHeader label="Namespace" sortKey="namespace" currentKey={policySortKey} direction={policySortDir} onSort={onPolicySort} className="hidden sm:table-cell" />
                <SortableHeader label="Type" sortKey="type" currentKey={policySortKey} direction={policySortDir} onSort={onPolicySort} />
                <SortableHeader label="Status" sortKey="status" currentKey={policySortKey} direction={policySortDir} onSort={onPolicySort} />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {sortedPolicies.map((policy) => (
                <tr key={policy.id} className="transition-colors hover:bg-gray-50 dark:hover:bg-gray-700/50">
                  <td className="px-5 py-3.5">
                    <span className="font-medium text-gray-900 dark:text-gray-100">{policy.name}</span>
                  </td>
                  <td className="hidden px-5 py-3.5 text-sm text-gray-600 dark:text-gray-400 sm:table-cell">
                    {policy.namespace}
                  </td>
                  <td className="px-5 py-3.5 text-sm text-gray-600 dark:text-gray-400">{policy.type}</td>
                  <td className="px-5 py-3.5">
                    <StatusBadge status={policy.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm">
        <div className="border-b border-gray-100 dark:border-gray-700 px-5 py-4">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Recent Security Events</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full" data-testid="events-table">
            <thead>
              <tr className="border-b border-gray-100 dark:border-gray-700 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                <SortableHeader label="Event" sortKey="event" currentKey={eventSortKey} direction={eventSortDir} onSort={onEventSort} />
                <SortableHeader label="Severity" sortKey="severity" currentKey={eventSortKey} direction={eventSortDir} onSort={onEventSort} />
                <SortableHeader label="Source" sortKey="source" currentKey={eventSortKey} direction={eventSortDir} onSort={onEventSort} className="hidden md:table-cell" />
                <SortableHeader label="Time" sortKey="timestamp" currentKey={eventSortKey} direction={eventSortDir} onSort={onEventSort} className="hidden sm:table-cell" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {auditLoading && (
                <tr>
                  <td colSpan={4} className="px-5 py-8 text-center">
                    <Loader2 className="mx-auto h-6 w-6 animate-spin text-gray-400 dark:text-gray-500" />
                    <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">Loading security events...</p>
                  </td>
                </tr>
              )}
              {auditError && !auditLoading && (
                <tr>
                  <td colSpan={4} className="px-5 py-8 text-center">
                    <p className="text-sm text-red-600 dark:text-red-400">Failed to load security events. Please try again later.</p>
                  </td>
                </tr>
              )}
              {!auditLoading && !auditError && sortedEvents.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-5 py-8 text-center">
                    <p className="text-sm text-gray-500 dark:text-gray-400">No security events recorded yet.</p>
                  </td>
                </tr>
              )}
              {!auditLoading && !auditError && sortedEvents.map((event) => (
                <tr key={event.id} className="transition-colors hover:bg-gray-50 dark:hover:bg-gray-700/50">
                  <td className="px-5 py-3.5 text-sm text-gray-900 dark:text-gray-100">{event.event}</td>
                  <td className="px-5 py-3.5">
                    <StatusBadge status={event.severity} label={event.severityLabel} />
                  </td>
                  <td className="hidden px-5 py-3.5 text-sm text-gray-500 dark:text-gray-400 md:table-cell">
                    {event.source}
                  </td>
                  <td className="hidden px-5 py-3.5 text-sm text-gray-500 dark:text-gray-400 sm:table-cell">
                    {event.timestamp}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
