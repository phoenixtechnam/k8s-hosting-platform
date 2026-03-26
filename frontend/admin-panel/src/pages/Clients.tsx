import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Search, Loader2 } from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';
import CreateClientModal from '@/components/CreateClientModal';
import { useClients } from '@/hooks/use-clients';

export default function Clients() {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);

  const { data, isLoading, error } = useClients({
    search: debouncedSearch || undefined,
    limit: 50,
  });

  const clients = data?.data ?? [];
  const totalCount = data?.pagination?.total_count ?? 0;

  const handleSearchChange = (value: string) => {
    setSearch(value);
    const key = '__searchTimeout';
    const w = window as unknown as Record<string, ReturnType<typeof setTimeout>>;
    clearTimeout(w[key]);
    w[key] = setTimeout(() => setDebouncedSearch(value), 300);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Clients</h1>
        <button
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-brand-600"
        >
          <Plus size={16} />
          Add Client
        </button>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1 max-w-sm">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="search"
            placeholder="Search by name..."
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="w-full rounded-lg border border-gray-200 bg-white py-2 pl-9 pr-4 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            data-testid="client-search"
          />
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
        {isLoading && (
          <div className="flex items-center justify-center py-10">
            <Loader2 size={24} className="animate-spin text-gray-400" />
          </div>
        )}

        {error && (
          <div className="px-5 py-10 text-center text-sm text-red-500">
            {error instanceof Error ? error.message : 'Failed to load clients'}
          </div>
        )}

        {!isLoading && !error && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full" data-testid="clients-table">
                <thead>
                  <tr className="border-b border-gray-100 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                    <th className="px-5 py-3">Client</th>
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
                          {client.companyName}
                        </Link>
                        <div className="text-xs text-gray-500">
                          {client.companyEmail}
                        </div>
                      </td>
                      <td className="px-5 py-3.5">
                        <StatusBadge status={client.status} />
                      </td>
                      <td className="hidden px-5 py-3.5 text-xs font-mono text-gray-500 md:table-cell">
                        {client.kubernetesNamespace ?? '—'}
                      </td>
                      <td className="hidden px-5 py-3.5 text-sm text-gray-500 lg:table-cell">
                        {(client.createdAt ?? client.createdAt) ? new Date(client.createdAt ?? client.createdAt!).toLocaleDateString() : '—'}
                      </td>
                    </tr>
                  ))}
                  {clients.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-5 py-10 text-center text-sm text-gray-500">
                        {debouncedSearch
                          ? 'No clients found matching your search.'
                          : 'No clients yet. Click "Add Client" to create one.'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="border-t border-gray-100 px-5 py-3 text-sm text-gray-500">
              {totalCount} client{totalCount !== 1 ? 's' : ''}
            </div>
          </>
        )}
      </div>

      <CreateClientModal open={showCreate} onClose={() => setShowCreate(false)} />
    </div>
  );
}
