import { useState } from 'react';
import { Plus, Search, Loader2, Globe, Shield, ChevronDown, ChevronRight, Info, RefreshCw } from 'lucide-react';
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
  const [expandedDomainId, setExpandedDomainId] = useState<string | null>(null);

  const { data: clientsData, isLoading: clientsLoading, error: clientsError, refetch: refetchClients } = useClients({ limit: 200 });
  const clients = clientsData?.data ?? [];

  const { data: domainsData, isLoading: domainsLoading, error: domainsError } = useDomains(
    selectedClientId || undefined,
    { search: debouncedSearch || undefined, limit: 50 },
  );

  const domains = domainsData?.data ?? [];
  const totalCount = domainsData?.pagination?.total_count ?? 0;

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
          {clientsError ? (
            <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2" data-testid="client-selector-error">
              <p className="text-sm text-red-600">Failed to load clients</p>
              <button
                onClick={() => refetchClients()}
                className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-100"
                data-testid="retry-clients-button"
              >
                <RefreshCw size={12} />
                Retry
              </button>
            </div>
          ) : (
            <select
              value={selectedClientId}
              onChange={(e) => setSelectedClientId(e.target.value)}
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              data-testid="client-selector"
            >
              <option value="">All Clients</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.companyName ?? c.name}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="relative flex-1 max-w-sm">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="search"
            placeholder="Search domains..."
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="w-full rounded-lg border border-gray-200 bg-white py-2 pl-9 pr-4 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            data-testid="domain-search"
          />
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
        {(domainsLoading || clientsLoading) && (
          <div className="flex items-center justify-center py-10">
            <Loader2 size={24} className="animate-spin text-gray-400" />
          </div>
        )}

        {domainsError && (
          <div className="px-5 py-10 text-center text-sm text-red-500" data-testid="domains-error">
            {domainsError instanceof Error ? domainsError.message : 'Failed to load domains'}
          </div>
        )}

        {!domainsLoading && !domainsError && (
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
                  {domains.map((domain) => {
                    const isExpanded = expandedDomainId === domain.id;
                    return (
                      <tr
                        key={domain.id}
                        className="transition-colors hover:bg-gray-50 cursor-pointer"
                        onClick={() => setExpandedDomainId(isExpanded ? null : domain.id)}
                        data-testid={`domain-row-${domain.id}`}
                      >
                        <td colSpan={5} className="p-0">
                          <div className="flex items-center">
                            <div className="px-5 py-3.5 flex-1">
                              <div className="flex items-center gap-2">
                                {isExpanded
                                  ? <ChevronDown size={14} className="text-gray-400" />
                                  : <ChevronRight size={14} className="text-gray-400" />}
                                <Globe size={14} className="text-gray-400" />
                                <span className="font-medium text-gray-900">{domain.domainName}</span>
                              </div>
                            </div>
                            <div className="px-5 py-3.5">
                              <StatusBadge status={domain.status} />
                            </div>
                            <div className="hidden px-5 py-3.5 text-sm text-gray-600 uppercase md:block">
                              {domain.dnsMode}
                            </div>
                            <div className="hidden px-5 py-3.5 lg:block">
                              <span className={clsx(
                                'inline-flex items-center gap-1 text-xs font-medium',
                                domain.sslAutoRenew ? 'text-green-600' : 'text-gray-400',
                              )}>
                                <Shield size={12} />
                                {domain.sslAutoRenew ? 'Auto' : 'Off'}
                              </span>
                            </div>
                            <div className="hidden px-5 py-3.5 text-sm text-gray-500 lg:block">
                              {domain.createdAt
                                ? new Date(domain.createdAt).toLocaleDateString()
                                : '\u2014'}
                            </div>
                          </div>
                          {isExpanded && (
                            <div
                              className="border-t border-gray-100 bg-gray-50 px-5 py-4"
                              data-testid={`domain-detail-${domain.id}`}
                            >
                              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                                <div>
                                  <h3 className="text-sm font-semibold text-gray-900" data-testid="domain-detail-name">
                                    {domain.domainName}
                                  </h3>
                                  <p className="mt-0.5 text-xs text-gray-500">Domain Name</p>
                                </div>
                                <div>
                                  <p className="text-sm font-medium text-gray-900 uppercase" data-testid="domain-detail-dns-mode">
                                    {domain.dnsMode}
                                  </p>
                                  <p className="mt-0.5 text-xs text-gray-500">DNS Mode</p>
                                </div>
                                <div>
                                  <p className="text-sm font-medium text-gray-900" data-testid="domain-detail-ssl">
                                    {domain.sslAutoRenew ? 'Yes' : 'No'}
                                  </p>
                                  <p className="mt-0.5 text-xs text-gray-500">SSL Auto-Renew</p>
                                </div>
                                <div>
                                  <StatusBadge status={domain.status} />
                                  <p className="mt-1 text-xs text-gray-500">Status</p>
                                </div>
                              </div>
                              <div className="mt-4 flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3">
                                <Info size={16} className="mt-0.5 shrink-0 text-blue-500" />
                                <p className="text-sm text-blue-700" data-testid="domain-detail-dns-notice">
                                  DNS records are managed via PowerDNS. Configure in the infrastructure project.
                                </p>
                              </div>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {domains.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-5 py-10 text-center text-sm text-gray-500">
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
            <div className="border-t border-gray-100 px-5 py-3 text-sm text-gray-500">
              {totalCount} domain{totalCount !== 1 ? 's' : ''}
            </div>
          </>
        )}
      </div>

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
