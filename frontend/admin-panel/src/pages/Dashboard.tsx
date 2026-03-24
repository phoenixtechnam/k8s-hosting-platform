import { Link } from 'react-router-dom';
import { Users, Globe, Database, AlertTriangle } from 'lucide-react';
import StatCard from '@/components/ui/StatCard';
import StatusBadge from '@/components/ui/StatusBadge';
import { mockDashboardMetrics, mockClients } from '@/lib/mock-data';

export default function Dashboard() {
  const m = mockDashboardMetrics;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title="Total Clients"
          value={m.total_clients}
          subtitle={`${m.active_clients} active`}
          icon={Users}
          accent="brand"
        />
        <StatCard
          title="Domains"
          value={m.total_domains}
          icon={Globe}
          accent="green"
        />
        <StatCard
          title="Storage"
          value={`${m.storage_used_gb} GB`}
          subtitle={`of ${m.storage_total_gb} GB`}
          icon={Database}
          accent="amber"
        />
        <StatCard
          title="Active Alerts"
          value={m.alerts_count}
          icon={AlertTriangle}
          accent="red"
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
        <div className="overflow-x-auto">
          <table className="w-full" data-testid="clients-table">
            <thead>
              <tr className="border-b border-gray-100 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                <th className="px-5 py-3">Name</th>
                <th className="px-5 py-3">Plan</th>
                <th className="px-5 py-3">Status</th>
                <th className="hidden px-5 py-3 md:table-cell">Domains</th>
                <th className="hidden px-5 py-3 lg:table-cell">Storage</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {mockClients.slice(0, 5).map((client) => (
                <tr
                  key={client.id}
                  className="transition-colors hover:bg-gray-50"
                >
                  <td className="px-5 py-3.5">
                    <Link
                      to={`/clients/${client.id}`}
                      className="font-medium text-gray-900 hover:text-brand-500"
                    >
                      {client.name}
                    </Link>
                    <div className="text-xs text-gray-500">{client.email}</div>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className="text-sm capitalize text-gray-700">{client.plan}</span>
                  </td>
                  <td className="px-5 py-3.5">
                    <StatusBadge status={client.status} />
                  </td>
                  <td className="hidden px-5 py-3.5 text-sm text-gray-700 md:table-cell">
                    {client.usage.domains} / {client.quota.domains}
                  </td>
                  <td className="hidden px-5 py-3.5 text-sm text-gray-700 lg:table-cell">
                    {client.usage.storage_gb} GB / {client.quota.storage_gb} GB
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
