import { useState } from 'react';
import { Plus, Search, Loader2, Globe, Shield } from 'lucide-react';
import clsx from 'clsx';
import StatusBadge from '@/components/ui/StatusBadge';
import CreateDomainModal from '@/components/CreateDomainModal';
import { useDomains } from '@/hooks/use-domains';
import { useClients } from '@/hooks/use-clients';

export default function Domains() {
  const [selectedClientId, setSelectedClientId] = useState('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);

  const { data: clientsData, isLoading: clientsLoading } = useClients({ limit: 200 });
  const clients = clientsData?.data ?? [];

  const { data: domainsData, isLoading: domainsLoading, error } = useDomains(
    selectedClientId || undefined,
    { search: debouncedSearch || undefined, limit: 50 },
  );

  const domains = domainsData?.data ?? [];
  const totalCount = domainsData?.pagination?.total_count ?? 0;

  const filteredDomains = search && !debouncedSearch
    ? domains
    : domains;

  const handleSearchChange = (value: string) => {
    setSearch(value);
    const key = '__domainSearchTimeout';
    const w = window as unknown as Record<string, ReturnType<typeof setTimeout>>;
    clearTimeout(w[key]);
    w[key] = setTimeout(() => setDebouncedSearch(value), 300);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Domains</h1>
        <button
          onClick={() => setShowCreate(true)}
          disabled={!selectedClientId}
          className={clsx(
            'inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium text-white shadow-sm transition-colors',
            selectedClientId
              ? 'bg-brand-500 hover:bg-brand-600'
              : 'bg-gray-300 cursor-not-allowed',
          )}
          data-testid="add-domain-button"
        >
          <Plus size={16} />
          Add Domain
        </button>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="w-full max-w-xs">
          <select
            value={selectedClientId}
            onChange={(e) => setSelectedClientId(e.target.value)}
            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            data-testid="client-selector"
          >
            <option value="">Select a client...</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.companyName ?? c.name}
              </option>
            ))}
          </select>
        </div>

        <div className="relative flex-1 max-w-sm">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="search"
            placeholder="Search domains..."
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
            disabled={!selectedClientId}
            className={clsx(
              'w-full rounded-lg border border-gray-200 bg-white py-2 pl-9 pr-4 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500',
              !selectedClientId && 'opacity-50 cursor-not-allowed',
            )}
            data-testid="domain-search"
          />
        </div>
      </div>

      {!selectedClientId && (
        <div className="rounded-xl border border-gray-200 bg-white px-5 py-16 text-center shadow-sm">
          <Globe size={40} className="mx-auto text-gray-300" />
          <p className="mt-4 text-sm text-gray-500" data-testid="select-client-prompt">
            Select a client to view and manage their domains.
          </p>
        </div>
      )}

      {selectedClientId && (
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
          {(domainsLoading || clientsLoading) && (
            <div className="flex items-center justify-center py-10">
              <Loader2 size={24} className="animate-spin text-gray-400" />
            </div>
          )}

          {error && (
            <div className="px-5 py-10 text-center text-sm text-red-500" data-testid="domains-error">
              {error instanceof Error ? error.message : 'Failed to load domains'}
            </div>
          )}

          {!domainsLoading && !error && (
            <>
              <div className="overflow-x-auto">
                <table className="w-full" data-testid="domains-table">
                  <thead>
                    <tr className="border-b border-gray-100 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                      <th className="px-5 py-3">Domain Name</th>
                      <th className="px-5 py-3">Status</th>
                      <th className="hidden px-5 py-3 md:table-cell">DNS Mode</th>
                      <th className="hidden px-5 py-3 lg:table-cell">SSL</th>
                      <th className="hidden px-5 py-3 lg:table-cell">Created</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {filteredDomains.map((domain) => (
                      <tr key={domain.id} className="transition-colors hover:bg-gray-50">
                        <td className="px-5 py-3.5">
                          <div className="flex items-center gap-2">
                            <Globe size={14} className="text-gray-400" />
                            <span className="font-medium text-gray-900">{domain.domainName}</span>
                          </div>
                        </td>
                        <td className="px-5 py-3.5">
                          <StatusBadge status={domain.status} />
                        </td>
                        <td className="hidden px-5 py-3.5 text-sm text-gray-600 uppercase md:table-cell">
                          {domain.dnsMode}
                        </td>
                        <td className="hidden px-5 py-3.5 lg:table-cell">
                          <span className={clsx(
                            'inline-flex items-center gap-1 text-xs font-medium',
                            domain.sslAutoRenew ? 'text-green-600' : 'text-gray-400',
                          )}>
                            <Shield size={12} />
                            {domain.sslAutoRenew ? 'Auto' : 'Off'}
                          </span>
                        </td>
                        <td className="hidden px-5 py-3.5 text-sm text-gray-500 lg:table-cell">
                          {domain.createdAt
                            ? new Date(domain.createdAt).toLocaleDateString()
                            : '\u2014'}
                        </td>
                      </tr>
                    ))}
                    {filteredDomains.length === 0 && (
                      <tr>
                        <td colSpan={5} className="px-5 py-10 text-center text-sm text-gray-500">
                          {debouncedSearch
                            ? 'No domains found matching your search.'
                            : 'No domains yet. Click "Add Domain" to create one.'}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="border-t border-gray-100 px-5 py-3 text-sm text-gray-500">
                {totalCount} domain{totalCount !== 1 ? 's' : ''}
              </div>
            </>
          )}
        </div>
      )}

      {selectedClientId && (
        <CreateDomainModal
          open={showCreate}
          onClose={() => setShowCreate(false)}
          clientId={selectedClientId}
        />
      )}
    </div>
  );
}
