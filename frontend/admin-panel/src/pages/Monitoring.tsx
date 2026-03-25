import { useState } from 'react';
import { Activity, AlertTriangle, Clock, BarChart3 } from 'lucide-react';
import StatCard from '@/components/ui/StatCard';
import StatusBadge from '@/components/ui/StatusBadge';
import ResourceBar from '@/components/ui/ResourceBar';
import { usePlatformStatus } from '@/hooks/use-dashboard';

type Tab = 'active-alerts' | 'alert-history' | 'system-metrics';

interface Alert {
  readonly id: string;
  readonly severity: 'critical' | 'warning' | 'info';
  readonly message: string;
  readonly service: string;
  readonly time: string;
}

const ACTIVE_ALERTS: readonly Alert[] = [
  {
    id: 'a1',
    severity: 'critical',
    message: 'Node memory usage exceeds 95%',
    service: 'k8s-node-02',
    time: '2 min ago',
  },
  {
    id: 'a2',
    severity: 'warning',
    message: 'Certificate expiring in 7 days',
    service: 'ingress-nginx',
    time: '15 min ago',
  },
  {
    id: 'a3',
    severity: 'warning',
    message: 'Pod restart count high',
    service: 'client-ns-demo',
    time: '1 hour ago',
  },
  {
    id: 'a4',
    severity: 'info',
    message: 'Scheduled maintenance window approaching',
    service: 'platform',
    time: '3 hours ago',
  },
] as const;

const RESOLVED_ALERTS: readonly Alert[] = [
  {
    id: 'h1',
    severity: 'critical',
    message: 'Database connection pool exhausted',
    service: 'mariadb-primary',
    time: '1 day ago',
  },
  {
    id: 'h2',
    severity: 'warning',
    message: 'Disk usage exceeded 80%',
    service: 'k8s-node-01',
    time: '2 days ago',
  },
  {
    id: 'h3',
    severity: 'info',
    message: 'Flux reconciliation completed',
    service: 'flux-system',
    time: '3 days ago',
  },
] as const;

const TABS: readonly { readonly key: Tab; readonly label: string }[] = [
  { key: 'active-alerts', label: 'Active Alerts' },
  { key: 'alert-history', label: 'Alert History' },
  { key: 'system-metrics', label: 'System Metrics' },
] as const;

const severityToBadgeStatus = {
  critical: 'error',
  warning: 'warning',
  info: 'active',
} as const;

function AlertTable({
  alerts,
  resolved = false,
}: {
  readonly alerts: readonly Alert[];
  readonly resolved?: boolean;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full" data-testid="alerts-table">
        <thead>
          <tr className="border-b border-gray-100 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
            <th className="px-5 py-3">Severity</th>
            <th className="px-5 py-3">Message</th>
            <th className="hidden px-5 py-3 md:table-cell">Service</th>
            <th className="hidden px-5 py-3 sm:table-cell">Time</th>
            {resolved && <th className="px-5 py-3">Status</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {alerts.map((alert) => (
            <tr key={alert.id} className="transition-colors hover:bg-gray-50">
              <td className="px-5 py-3.5">
                <StatusBadge
                  status={severityToBadgeStatus[alert.severity]}
                  label={alert.severity}
                />
              </td>
              <td className="px-5 py-3.5 text-sm text-gray-900">{alert.message}</td>
              <td className="hidden px-5 py-3.5 text-sm text-gray-500 md:table-cell">
                {alert.service}
              </td>
              <td className="hidden px-5 py-3.5 text-sm text-gray-500 sm:table-cell">
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
  const { data: statusData } = usePlatformStatus();

  const platformStatus = statusData?.data?.status ?? 'unknown';

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Monitoring</h1>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title="Platform Status"
          value={platformStatus}
          icon={Activity}
          accent={platformStatus === 'healthy' ? 'green' : 'amber'}
        />
        <StatCard
          title="Active Alerts"
          value={ACTIVE_ALERTS.length}
          icon={AlertTriangle}
          accent="red"
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

      <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="border-b border-gray-200">
          <nav className="flex gap-0" data-testid="tab-bar">
            {TABS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveTab(tab.key)}
                className={
                  activeTab === tab.key
                    ? 'border-b-2 border-brand-500 px-5 py-3 text-sm font-medium text-brand-600'
                    : 'border-b-2 border-transparent px-5 py-3 text-sm font-medium text-gray-500 hover:text-gray-700'
                }
                data-testid={`tab-${tab.key}`}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        </div>

        {activeTab === 'active-alerts' && <AlertTable alerts={ACTIVE_ALERTS} />}
        {activeTab === 'alert-history' && <AlertTable alerts={RESOLVED_ALERTS} resolved />}
        {activeTab === 'system-metrics' && <SystemMetrics />}
      </div>
    </div>
  );
}
