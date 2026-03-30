import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Search, Loader2, Globe, Shield } from 'lucide-react';
import clsx from 'clsx';
import StatusBadge from '@/components/ui/StatusBadge';
import CreateDomainModal from '@/components/CreateDomainModal';
import SearchableClientSelect from '@/components/ui/SearchableClientSelect';
import { useDomains } from '@/hooks/use-domains';
import { useClients } from '@/hooks/use-clients';
import { useSortable } from '@/hooks/use-sortable';
import SortableHeader from '@/components/ui/SortableHeader';

export default function Domains() {
  const navigate = useNavigate();
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);

  const { data: domainsData, isLoading: domainsLoading, error: domainsError } = useDomains(
    selectedClientId ?? undefined,
    { search: debouncedSearch || undefined, limit: 50 },
  );

  const { data: clientsData } = useClients({ limit: 100 });
  const clientMap = new Map(
    (clientsData?.data ?? []).map((c) => [c.id, c.companyName]),
  );

  const domains = domainsData?.data ?? [];
  const totalCount = domainsData?.pagination?.total_count ?? 0;
  const { sortedData: sortedDomains, sortKey, sortDirection, onSort } = useSortable(domains, 'domainName');

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
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Domains</h1>
        <button
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-brand-600"
          data-testid="add-domain-button"
        >
          <Plus size={16} />
          Add Domain
        </button>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <SearchableClientSelect
          selectedClientId={selectedClientId}
          onSelect={setSelectedClientId}
        />

        <div className="relative flex-1 max-w-sm">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="search"
            placeholder="Search domains..."
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 py-2 pl-9 pr-4 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            data-testid="domain-search"
          />
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm">
        {domainsLoading && (
          <div className="flex items-center justify-center py-10">
            <Loader2 size={24} className="animate-spin text-gray-400" />
          </div>
        )}

        {domainsError && (
          <div className="px-5 py-10 text-center text-sm text-red-500 dark:text-red-400" data-testid="domains-error">
            {domainsError instanceof Error ? domainsError.message : 'Failed to load domains'}
          </div>
        )}

        {!domainsLoading && !domainsError && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full" data-testid="domains-table">
                <thead>
                  <tr className="border-b border-gray-100 dark:border-gray-700 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    <SortableHeader label="Domain Name" sortKey="domainName" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
                    <SortableHeader label="Client" sortKey="clientId" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
                    <SortableHeader label="Status" sortKey="status" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
                    <SortableHeader label="DNS Mode" sortKey="dnsMode" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="hidden md:table-cell" />
                    <SortableHeader label="SSL" sortKey="sslAutoRenew" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="hidden lg:table-cell" />
                    <SortableHeader label="Created" sortKey="createdAt" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="hidden lg:table-cell" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {sortedDomains.map((domain) => (
                    <tr
                      key={domain.id}
                      className="cursor-pointer transition-colors hover:bg-gray-50 dark:hover:bg-gray-700/50"
                      onClick={() => navigate(`/clients/${domain.clientId}/domains/${domain.id}`)}
                      data-testid={`domain-row-${domain.id}`}
                    >
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-2">
                          <Globe size={14} className="text-gray-400" />
                          <span className="font-medium text-gray-900 dark:text-gray-100">{domain.domainName}</span>
                        </div>
                      </td>
                      <td className="px-5 py-3.5 text-sm text-gray-600 dark:text-gray-400">
                        {clientMap.get(domain.clientId) ?? '\u2014'}
                      </td>
                      <td className="px-5 py-3.5">
                        <StatusBadge status={domain.status as 'active' | 'pending' | 'suspended'} />
                      </td>
                      <td className="hidden px-5 py-3.5 text-sm text-gray-600 dark:text-gray-400 uppercase md:table-cell">
                        {domain.dnsMode}
                      </td>
                      <td className="hidden px-5 py-3.5 lg:table-cell">
                        <span className={clsx(
                          'inline-flex items-center gap-1 text-xs font-medium',
                          domain.sslAutoRenew ? 'text-green-600 dark:text-green-400' : 'text-gray-400',
                        )}>
                          <Shield size={12} />
                          {domain.sslAutoRenew ? 'Auto (TLS)' : 'Manual'}
                        </span>
                      </td>
                      <td className="hidden px-5 py-3.5 text-sm text-gray-500 dark:text-gray-400 lg:table-cell">
                        {domain.createdAt ? new Date(domain.createdAt).toLocaleDateString() : '\u2014'}
                      </td>
                    </tr>
                  ))}
                  {domains.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-5 py-10 text-center text-sm text-gray-500 dark:text-gray-400">
                        {debouncedSearch
                          ? 'No domains found matching your search.'
                          : selectedClientId
                            ? 'No domains yet. Click "Add Domain" to create one.'
                            : 'No domains found across any client.'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="border-t border-gray-100 dark:border-gray-700 px-5 py-3 text-sm text-gray-500 dark:text-gray-400">
              {totalCount} domain{totalCount !== 1 ? 's' : ''}
            </div>
          </>
        )}
      </div>

      <CreateDomainModal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        clientId={selectedClientId}
      />
    </div>
  );
}
