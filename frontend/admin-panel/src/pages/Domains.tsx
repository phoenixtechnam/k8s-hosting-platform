import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Search, Loader2, Globe, Shield, ChevronDown, ChevronRight, Info, ExternalLink } from 'lucide-react';
import clsx from 'clsx';
import StatusBadge from '@/components/ui/StatusBadge';
import CreateDomainModal from '@/components/CreateDomainModal';
import SearchableClientSelect from '@/components/ui/SearchableClientSelect';
import { useDomains } from '@/hooks/use-domains';
import { useClients } from '@/hooks/use-clients';

export default function Domains() {
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [expandedDomainId, setExpandedDomainId] = useState<string | null>(null);

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
                    <th className="px-5 py-3">Domain Name</th>
                    <th className="px-5 py-3">Client</th>
                    <th className="px-5 py-3">Status</th>
                    <th className="hidden px-5 py-3 md:table-cell">DNS Mode</th>
                    <th className="hidden px-5 py-3 lg:table-cell">SSL</th>
                    <th className="hidden px-5 py-3 lg:table-cell">Created</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {domains.map((domain) => {
                    const isExpanded = expandedDomainId === domain.id;
                    const ssl = (
                      <span className={clsx(
                        'inline-flex items-center gap-1 text-xs font-medium',
                        domain.sslAutoRenew ? 'text-green-600 dark:text-green-400' : 'text-gray-400',
                      )}>
                        <Shield size={12} />
                        {domain.sslAutoRenew ? 'Auto' : 'Off'}
                      </span>
                    );
                    const created = domain.createdAt
                      ? new Date(domain.createdAt).toLocaleDateString()
                      : '\u2014';
                    return (
                      <tr
                        key={domain.id}
                        className="cursor-pointer transition-colors hover:bg-gray-50 dark:hover:bg-gray-700/50"
                        onClick={() => setExpandedDomainId(isExpanded ? null : domain.id)}
                        data-testid={`domain-row-${domain.id}`}
                      >
                        <td className="px-5 py-3.5">
                          <div className="flex items-center gap-2">
                            {isExpanded
                              ? <ChevronDown size={14} className="text-gray-400" />
                              : <ChevronRight size={14} className="text-gray-400" />}
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
                        <td className="hidden px-5 py-3.5 lg:table-cell">{ssl}</td>
                        <td className="hidden px-5 py-3.5 text-sm text-gray-500 dark:text-gray-400 lg:table-cell">
                          {created}
                        </td>
                      </tr>
                    );
                  })}
                  {domains.map((domain) => {
                    const isExpanded = expandedDomainId === domain.id;
                    if (!isExpanded) return null;
                    return (
                      <tr key={`${domain.id}-detail`}>
                        <td colSpan={6} className="p-0">
                          <div
                            className="border-t border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 px-5 py-4"
                            data-testid={`domain-detail-${domain.id}`}
                          >
                            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                              <div>
                                <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100" data-testid="domain-detail-name">
                                  {domain.domainName}
                                </h3>
                                <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">Domain Name</p>
                              </div>
                              <div>
                                <p className="text-sm font-medium text-gray-900 dark:text-gray-100 uppercase" data-testid="domain-detail-dns-mode">
                                  {domain.dnsMode}
                                </p>
                                <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">DNS Mode</p>
                              </div>
                              <div>
                                <p className="text-sm font-medium text-gray-900 dark:text-gray-100" data-testid="domain-detail-ssl">
                                  {domain.sslAutoRenew ? 'Yes' : 'No'}
                                </p>
                                <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">SSL Auto-Renew</p>
                              </div>
                              <div>
                                <StatusBadge status={domain.status as 'active' | 'pending' | 'suspended'} />
                                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Status</p>
                              </div>
                            </div>
                            <div className="mt-4 flex items-center justify-between">
                              <div className="flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 dark:bg-blue-900/20 px-4 py-3 flex-1">
                                <Info size={16} className="mt-0.5 shrink-0 text-blue-500 dark:text-blue-400" />
                                <p className="text-sm text-blue-700 dark:text-blue-400" data-testid="domain-detail-dns-notice">
                                  DNS records are managed via PowerDNS. Configure in the infrastructure project.
                                </p>
                              </div>
                              <Link
                                to={`/clients/${domain.clientId}/domains/${domain.id}`}
                                className="ml-3 inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-600"
                                data-testid={`manage-domain-${domain.id}`}
                                onClick={(e) => e.stopPropagation()}
                              >
                                <ExternalLink size={14} />
                                Manage
                              </Link>
                            </div>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
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
