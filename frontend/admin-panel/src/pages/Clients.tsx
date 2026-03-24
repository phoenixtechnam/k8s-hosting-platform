import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Search } from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';
import ResourceBar from '@/components/ui/ResourceBar';
import { mockClients } from '@/lib/mock-data';

type PlanFilter = 'all' | 'starter' | 'business' | 'premium';
type StatusFilter = 'all' | 'active' | 'suspended' | 'pending';

export default function Clients() {
  const [search, setSearch] = useState('');
  const [planFilter, setPlanFilter] = useState<PlanFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return mockClients.filter((c) => {
      if (q && !c.name.toLowerCase().includes(q) && !c.email.toLowerCase().includes(q)) {
        return false;
      }
      if (planFilter !== 'all' && c.plan !== planFilter) return false;
      if (statusFilter !== 'all' && c.status !== statusFilter) return false;
      return true;
    });
  }, [search, planFilter, statusFilter]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Clients</h1>
        <button className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-brand-600">
          <Plus size={16} />
          Add Client
        </button>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1 max-w-sm">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="search"
            placeholder="Search by name or email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border border-gray-200 bg-white py-2 pl-9 pr-4 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            data-testid="client-search"
          />
        </div>
        <select
          value={planFilter}
          onChange={(e) => setPlanFilter(e.target.value as PlanFilter)}
          className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          data-testid="plan-filter"
        >
          <option value="all">All Plans</option>
          <option value="starter">Starter</option>
          <option value="business">Business</option>
          <option value="premium">Premium</option>
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          data-testid="status-filter"
        >
          <option value="all">All Statuses</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
          <option value="pending">Pending</option>
        </select>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full" data-testid="clients-table">
            <thead>
              <tr className="border-b border-gray-100 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                <th className="px-5 py-3">Client</th>
                <th className="px-5 py-3">Plan</th>
                <th className="px-5 py-3">Status</th>
                <th className="hidden px-5 py-3 md:table-cell">Storage</th>
                <th className="hidden px-5 py-3 lg:table-cell">Expires</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.map((client) => (
                <tr key={client.id} className="transition-colors hover:bg-gray-50">
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
                  <td className="hidden px-5 py-3.5 md:table-cell">
                    <ResourceBar
                      used={client.usage.storage_gb}
                      total={client.quota.storage_gb}
                    />
                  </td>
                  <td className="hidden px-5 py-3.5 text-sm text-gray-500 lg:table-cell">
                    {new Date(client.subscription.expiry_date).toLocaleDateString()}
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-5 py-10 text-center text-sm text-gray-500">
                    No clients found matching your filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="border-t border-gray-100 px-5 py-3 text-sm text-gray-500">
          {filtered.length} client{filtered.length !== 1 ? 's' : ''}
        </div>
      </div>
    </div>
  );
}
