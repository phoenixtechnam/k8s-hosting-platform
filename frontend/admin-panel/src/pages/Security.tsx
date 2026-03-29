import { Shield, Lock, FileCheck, ShieldCheck } from 'lucide-react';
import StatCard from '@/components/ui/StatCard';
import StatusBadge from '@/components/ui/StatusBadge';
import { useSortable } from '@/hooks/use-sortable';
import SortableHeader from '@/components/ui/SortableHeader';

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

const SECURITY_EVENTS: readonly SecurityEvent[] = [
  {
    id: 'se-1',
    event: 'Failed login attempt blocked',
    severity: 'warning',
    severityLabel: 'warning',
    source: 'dex-oidc',
    timestamp: '10 min ago',
  },
  {
    id: 'se-2',
    event: 'SSL certificate renewed',
    severity: 'active',
    severityLabel: 'info',
    source: 'cert-manager',
    timestamp: '1 hour ago',
  },
  {
    id: 'se-3',
    event: 'Network policy violation detected',
    severity: 'error',
    severityLabel: 'critical',
    source: 'calico',
    timestamp: '3 hours ago',
  },
  {
    id: 'se-4',
    event: 'Sealed secret rotated',
    severity: 'active',
    severityLabel: 'info',
    source: 'sealed-secrets',
    timestamp: '6 hours ago',
  },
  {
    id: 'se-5',
    event: 'Unauthorized API request rejected',
    severity: 'warning',
    severityLabel: 'warning',
    source: 'api-gateway',
    timestamp: '1 day ago',
  },
] as const;

export default function Security() {
  const { sortedData: sortedPolicies, sortKey: policySortKey, sortDirection: policySortDir, onSort: onPolicySort } = useSortable(NETWORK_POLICIES, 'name');
  const { sortedData: sortedEvents, sortKey: eventSortKey, sortDirection: eventSortDir, onSort: onEventSort } = useSortable(SECURITY_EVENTS, 'event');

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Shield size={28} className="text-brand-500" />
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Security</h1>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard title="Network Policies" value={8} icon={Shield} accent="brand" />
        <StatCard title="Sealed Secrets" value={12} icon={Lock} accent="green" />
        <StatCard title="SSL Certificates" value="47 valid" icon={FileCheck} accent="amber" />
        <StatCard title="Security Score" value="92/100" icon={ShieldCheck} accent="green" />
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
              {sortedEvents.map((event) => (
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
