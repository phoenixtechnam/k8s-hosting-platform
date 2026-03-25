import { Link } from 'react-router-dom';
import { Users, Globe, Server, Database, Loader2 } from 'lucide-react';
import StatCard from '@/components/ui/StatCard';
import StatusBadge from '@/components/ui/StatusBadge';
import { useClients } from '@/hooks/use-clients';
import { usePlatformStatus, useDashboardMetrics } from '@/hooks/use-dashboard';

export default function Dashboard() {
  const { data: clientsData, isLoading: clientsLoading, error: clientsError } = useClients({ limit: 5 });
  const { data: statusData } = usePlatformStatus();
  const { data: metricsData, isLoading: metricsLoading } = useDashboardMetrics();

  const clients = clientsData?.data ?? [];
  const metrics = metricsData?.data;
  const platformStatus = statusData?.data?.status ?? 'unknown';

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title="Total Clients"
          value={metricsLoading ? '...' : (metrics?.total_clients ?? 0)}
          subtitle={metrics ? `${metrics.active_clients} active` : undefined}
          icon={Users}
          accent="brand"
        />
        <StatCard
          title="Platform"
          value={platformStatus}
          subtitle={statusData?.data?.version}
          icon={Server}
          accent={platformStatus === 'healthy' ? 'green' : 'amber'}
        />
        <StatCard
          title="Domains"
          value={metricsLoading ? '...' : (metrics?.total_domains ?? 0)}
          icon={Globe}
          accent="green"
        />
        <StatCard
          title="Databases"
          value={metricsLoading ? '...' : (metrics?.total_databases ?? 0)}
          subtitle={metrics ? `${metrics.total_backups} backups` : undefined}
          icon={Database}
          accent="amber"
        />
      </div>

      <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-4">
          <h2 className="text-lg font-semibold text-gray-900">Recent Clients</h2>
          <Link
            to="/clients"
            className="text-sm font-medium text-brand-500 hover:text-brand-600"
          >
            View all
          </Link>
        </div>

        {clientsLoading && (
          <div className="flex items-center justify-center py-10">
            <Loader2 size={24} className="animate-spin text-gray-400" />
          </div>
        )}

        {clientsError && (
          <div className="px-5 py-10 text-center text-sm text-red-500">
            {clientsError instanceof Error ? clientsError.message : 'Failed to load clients'}
          </div>
        )}

        {!clientsLoading && !clientsError && (
          <div className="overflow-x-auto">
            <table className="w-full" data-testid="clients-table">
              <thead>
                <tr className="border-b border-gray-100 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  <th className="px-5 py-3">Name</th>
                  <th className="px-5 py-3">Status</th>
                  <th className="hidden px-5 py-3 md:table-cell">Namespace</th>
                  <th className="hidden px-5 py-3 lg:table-cell">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {clients.map((client) => (
                  <tr key={client.id} className="transition-colors hover:bg-gray-50">
                    <td className="px-5 py-3.5">
                      <Link
                        to={`/clients/${client.id}`}
                        className="font-medium text-gray-900 hover:text-brand-500"
                      >
                        {client.companyName ?? client.name}
                      </Link>
                      <div className="text-xs text-gray-500">
                        {client.companyEmail ?? client.email}
                      </div>
                    </td>
                    <td className="px-5 py-3.5">
                      <StatusBadge status={client.status} />
                    </td>
                    <td className="hidden px-5 py-3.5 text-xs font-mono text-gray-500 md:table-cell">
                      {client.kubernetesNamespace ?? '—'}
                    </td>
                    <td className="hidden px-5 py-3.5 text-sm text-gray-500 lg:table-cell">
                      {(client.created_at ?? client.createdAt) ? new Date(client.created_at ?? client.createdAt!).toLocaleDateString() : '—'}
                    </td>
                  </tr>
                ))}
                {clients.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-5 py-10 text-center text-sm text-gray-500">
                      No clients yet. Create your first client to get started.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
