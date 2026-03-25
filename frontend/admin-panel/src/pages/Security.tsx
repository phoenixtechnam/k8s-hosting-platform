import { Shield, Lock, FileCheck, ShieldCheck } from 'lucide-react';
import StatCard from '@/components/ui/StatCard';
import StatusBadge from '@/components/ui/StatusBadge';

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
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Shield size={28} className="text-brand-500" />
        <h1 className="text-2xl font-bold text-gray-900">Security</h1>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard title="Network Policies" value={8} icon={Shield} accent="brand" />
        <StatCard title="Sealed Secrets" value={12} icon={Lock} accent="green" />
        <StatCard title="SSL Certificates" value="47 valid" icon={FileCheck} accent="amber" />
        <StatCard title="Security Score" value="92/100" icon={ShieldCheck} accent="green" />
      </div>

      <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="border-b border-gray-100 px-5 py-4">
          <h2 className="text-lg font-semibold text-gray-900">Network Policies</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full" data-testid="policies-table">
            <thead>
              <tr className="border-b border-gray-100 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                <th className="px-5 py-3">Policy Name</th>
                <th className="hidden px-5 py-3 sm:table-cell">Namespace</th>
                <th className="px-5 py-3">Type</th>
                <th className="px-5 py-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {NETWORK_POLICIES.map((policy) => (
                <tr key={policy.id} className="transition-colors hover:bg-gray-50">
                  <td className="px-5 py-3.5">
                    <span className="font-medium text-gray-900">{policy.name}</span>
                  </td>
                  <td className="hidden px-5 py-3.5 text-sm text-gray-600 sm:table-cell">
                    {policy.namespace}
                  </td>
                  <td className="px-5 py-3.5 text-sm text-gray-600">{policy.type}</td>
                  <td className="px-5 py-3.5">
                    <StatusBadge status={policy.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="border-b border-gray-100 px-5 py-4">
          <h2 className="text-lg font-semibold text-gray-900">Recent Security Events</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full" data-testid="events-table">
            <thead>
              <tr className="border-b border-gray-100 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                <th className="px-5 py-3">Event</th>
                <th className="px-5 py-3">Severity</th>
                <th className="hidden px-5 py-3 md:table-cell">Source</th>
                <th className="hidden px-5 py-3 sm:table-cell">Time</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {SECURITY_EVENTS.map((event) => (
                <tr key={event.id} className="transition-colors hover:bg-gray-50">
                  <td className="px-5 py-3.5 text-sm text-gray-900">{event.event}</td>
                  <td className="px-5 py-3.5">
                    <StatusBadge status={event.severity} label={event.severityLabel} />
                  </td>
                  <td className="hidden px-5 py-3.5 text-sm text-gray-500 md:table-cell">
                    {event.source}
                  </td>
                  <td className="hidden px-5 py-3.5 text-sm text-gray-500 sm:table-cell">
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
