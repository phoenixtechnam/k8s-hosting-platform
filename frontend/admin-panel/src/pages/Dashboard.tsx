import { Link } from 'react-router-dom';
import { Users, Globe, Server, Archive, Loader2, CheckCircle, AlertCircle } from 'lucide-react';
import StatCard from '@/components/ui/StatCard';
import StatusBadge from '@/components/ui/StatusBadge';
import { useClients } from '@/hooks/use-clients';
import { usePlatformStatus, useDashboardMetrics } from '@/hooks/use-dashboard';
import { useClusterNodes } from '@/hooks/use-cluster-nodes';
import { useSortable } from '@/hooks/use-sortable';
import SortableHeader from '@/components/ui/SortableHeader';

export default function Dashboard() {
  const { data: clientsData, isLoading: clientsLoading, error: clientsError } = useClients({ limit: 5 });
  const { data: statusData } = usePlatformStatus();
  const { data: metricsData, isLoading: metricsLoading } = useDashboardMetrics();
  const { data: nodesData, isLoading: nodesLoading } = useClusterNodes();
  const nodes = nodesData?.data ?? [];

  const clients = clientsData?.data ?? [];
  const metrics = metricsData?.data;
  const { sortedData: sortedClients, sortKey, sortDirection, onSort } = useSortable(clients, 'companyName');
  const platformStatus = statusData?.data?.status ?? 'unknown';

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Dashboard</h1>

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
          accent={platformStatus === 'healthy' ? 'green' : platformStatus === 'unhealthy' ? 'red' : 'amber'}
        />
        <StatCard
          title="Domains"
          value={metricsLoading ? '...' : (metrics?.total_domains ?? 0)}
          icon={Globe}
          accent="green"
        />
        <StatCard
          title="Backups"
          value={metricsLoading ? '...' : (metrics?.total_backups ?? 0)}
          icon={Archive}
          accent="amber"
        />
      </div>

      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm">
        <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 px-5 py-4">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Recent Clients</h2>
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
          <div className="px-5 py-10 text-center text-sm text-red-500 dark:text-red-400">
            {clientsError instanceof Error ? clientsError.message : 'Failed to load clients'}
          </div>
        )}

        {!clientsLoading && !clientsError && (
          <div className="overflow-x-auto">
            <table className="w-full" data-testid="clients-table">
              <thead>
                <tr className="border-b border-gray-100 dark:border-gray-700 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  <SortableHeader label="Name" sortKey="companyName" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
                  <SortableHeader label="Status" sortKey="status" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
                  <SortableHeader label="Namespace" sortKey="kubernetesNamespace" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="hidden md:table-cell" />
                  <SortableHeader label="Created" sortKey="createdAt" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="hidden lg:table-cell" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {sortedClients.map((client) => (
                  <tr key={client.id} className="transition-colors hover:bg-gray-50 dark:hover:bg-gray-700/50">
                    <td className="px-5 py-3.5">
                      <Link
                        to={`/clients/${client.id}`}
                        className="font-medium text-gray-900 dark:text-gray-100 hover:text-brand-500"
                      >
                        {client.companyName}
                      </Link>
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        {client.companyEmail}
                      </div>
                    </td>
                    <td className="px-5 py-3.5">
                      <StatusBadge status={client.status} />
                    </td>
                    <td className="hidden px-5 py-3.5 text-xs font-mono text-gray-500 dark:text-gray-400 md:table-cell">
                      {client.kubernetesNamespace ?? '—'}
                    </td>
                    <td className="hidden px-5 py-3.5 text-sm text-gray-500 dark:text-gray-400 lg:table-cell">
                      {(client.createdAt ?? client.createdAt) ? new Date(client.createdAt ?? client.createdAt!).toLocaleDateString() : '—'}
                    </td>
                  </tr>
                ))}
                {clients.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-5 py-10 text-center text-sm text-gray-500 dark:text-gray-400">
                      No clients yet. Create your first client to get started.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {/* Cluster Nodes Overview */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm" data-testid="cluster-nodes-overview">
        <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 px-5 py-4">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Cluster Nodes</h2>
          <Link to="/settings/nodes-and-storage" className="text-sm font-medium text-brand-500 hover:text-brand-600">Manage</Link>
        </div>
        {nodesLoading && (
          <div className="flex items-center justify-center py-8"><Loader2 size={20} className="animate-spin text-gray-400" /></div>
        )}
        {!nodesLoading && nodes.length === 0 && (
          <div className="px-5 py-8 text-center text-sm text-gray-500 dark:text-gray-400">No nodes found.</div>
        )}
        {!nodesLoading && nodes.length > 0 && (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-700">
                  <th className="px-5 py-2.5 font-medium">Name</th>
                  <th className="px-5 py-2.5 font-medium">Role</th>
                  <th className="px-5 py-2.5 font-medium">Status</th>
                  <th className="px-5 py-2.5 font-medium">Address</th>
                  <th className="px-5 py-2.5 font-medium text-right">CPU / Memory</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {nodes.map((n) => {
                  const readyCondition = n.statusConditions?.find((c) => c.type === 'Ready');
                  const ready = readyCondition?.status === 'True';
                  const cpuPct = n.cpuRequestsMillicores != null && n.cpuMillicores
                    ? `${Math.round((n.cpuRequestsMillicores / n.cpuMillicores) * 100)}%`
                    : '—';
                  const memPct = n.memoryRequestsBytes != null && n.memoryBytes
                    ? `${Math.round((n.memoryRequestsBytes / n.memoryBytes) * 100)}%`
                    : '—';
                  return (
                    <tr key={n.name} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                      <td className="px-5 py-2.5 font-medium text-gray-900 dark:text-gray-100">{n.displayName ?? n.name}</td>
                      <td className="px-5 py-2.5 text-gray-600 dark:text-gray-400 capitalize">{n.role}</td>
                      <td className="px-5 py-2.5">
                        <span className={`inline-flex items-center gap-1 text-xs font-medium ${
                          ready ? 'text-green-700 dark:text-green-400' : 'text-amber-700 dark:text-amber-400'
                        }`}>
                          {ready ? <CheckCircle size={12} /> : <AlertCircle size={12} />}
                          {ready ? 'Ready' : 'NotReady'}
                        </span>
                      </td>
                      <td className="px-5 py-2.5 text-gray-600 dark:text-gray-400 font-mono text-xs">{n.publicIp ?? '—'}</td>
                      <td className="px-5 py-2.5 text-right text-xs text-gray-600 dark:text-gray-400">
                        <span className="tabular-nums" title="CPU requests / capacity">{cpuPct}</span>
                        <span className="mx-1 text-gray-400">/</span>
                        <span className="tabular-nums" title="Memory requests / capacity">{memPct}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
