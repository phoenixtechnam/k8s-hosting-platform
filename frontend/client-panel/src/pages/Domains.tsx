import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Globe, Plus, X, Loader2, Shield, Lock } from 'lucide-react';
import { useClientContext } from '@/hooks/use-client-context';
import { useCanManage } from '@/hooks/use-can-manage';
import { useDomains, useCreateDomain } from '@/hooks/use-domains';
import { useSortable } from '@/hooks/use-sortable';
import SortableHeader from '@/components/ui/SortableHeader';
import ReadOnlyNotice from '@/components/ReadOnlyNotice';

function StatusBadge({ status }: { readonly status: string }) {
  const colorMap: Record<string, string> = {
    active: 'bg-green-50 text-green-700 border-green-200 dark:bg-green-900/40 dark:text-green-300 dark:border-green-700',
    pending: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-700',
    suspended: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-900/40 dark:text-red-300 dark:border-red-700',
    inactive: 'bg-gray-50 text-gray-600 border-gray-200 dark:bg-gray-700 dark:text-gray-400 dark:border-gray-600',
  };
  const colors = colorMap[status.toLowerCase()] ?? 'bg-gray-50 text-gray-600 border-gray-200 dark:bg-gray-700 dark:text-gray-400 dark:border-gray-600';

  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${colors}`}>
      {status}
    </span>
  );
}

const INPUT_CLASS =
  'w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500';

export default function Domains() {
  const { clientId } = useClientContext();
  const navigate = useNavigate();
  const canManage = useCanManage();
  const { data, isLoading, isError, error } = useDomains(clientId ?? undefined);
  const [showAddModal, setShowAddModal] = useState(false);

  const domainsRaw = data?.data ?? [];
  const { sortedData: domains, sortKey, sortDirection, onSort } = useSortable(domainsRaw, 'domainName');

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-50 text-blue-600 dark:bg-blue-900/40 dark:text-blue-400">
            <Globe size={20} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100" data-testid="domains-heading">
              Domains
            </h1>
            <p className="text-sm text-gray-500 dark:text-gray-400">Manage your domain names and DNS settings.</p>
          </div>
        </div>
        {canManage && (
          <button
            type="button"
            onClick={() => setShowAddModal(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            data-testid="add-domain-button"
          >
            <Plus size={14} />
            Add Domain
          </button>
        )}
      </div>

      {!canManage && <ReadOnlyNotice />}

      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm">
        {isLoading && (
          <div className="flex items-center justify-center py-16" data-testid="domains-loading">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-200 border-t-blue-600" />
            <span className="ml-3 text-sm text-gray-500 dark:text-gray-400">Loading domains...</span>
          </div>
        )}

        {isError && (
          <div className="px-6 py-16 text-center" data-testid="domains-error">
            <p className="text-sm text-red-600">
              Failed to load domains: {error instanceof Error ? error.message : 'Unknown error'}
            </p>
          </div>
        )}

        {!isLoading && !isError && domainsRaw.length === 0 && (
          <div className="px-6 py-16 text-center" data-testid="domains-empty">
            <Globe size={40} className="mx-auto text-gray-300 dark:text-gray-600" />
            <p className="mt-3 text-sm font-medium text-gray-900 dark:text-gray-100">No domains yet</p>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Add a domain to start routing traffic to your workloads.
            </p>
            <button
              type="button"
              onClick={() => setShowAddModal(true)}
              className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              <Plus size={14} />
              Add Your First Domain
            </button>
          </div>
        )}

        {!isLoading && !isError && domainsRaw.length > 0 && (
          <div className="overflow-x-auto" data-testid="domains-table">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/50">
                  <SortableHeader label="Domain Name" sortKey="domainName" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="px-6 font-medium text-gray-500 dark:text-gray-400" />
                  <SortableHeader label="Status" sortKey="status" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="px-6 font-medium text-gray-500 dark:text-gray-400" />
                  <SortableHeader label="DNS Mode" sortKey="dnsMode" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="hidden px-6 font-medium text-gray-500 dark:text-gray-400 md:table-cell" />
                  <SortableHeader label="SSL" sortKey="sslAutoRenew" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="hidden px-6 font-medium text-gray-500 dark:text-gray-400 sm:table-cell" />
                  <SortableHeader label="Created" sortKey="createdAt" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="hidden px-6 font-medium text-gray-500 dark:text-gray-400 lg:table-cell" />
                </tr>
              </thead>
              <tbody>
                {domains.map((domain) => (
                  <tr
                    key={domain.id}
                    className="border-b border-gray-100 dark:border-gray-700 last:border-0 cursor-pointer transition-colors hover:bg-gray-50 dark:hover:bg-gray-700/50"
                    onClick={() => navigate(`/domains/${domain.id}`)}
                    data-testid={`domain-row-${domain.id}`}
                  >
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        <Globe size={14} className="text-gray-400" />
                        <span className="font-medium text-gray-900 dark:text-gray-100">{domain.domainName}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <StatusBadge status={domain.status} />
                    </td>
                    <td className="hidden px-6 py-4 text-gray-600 dark:text-gray-400 uppercase text-xs md:table-cell">{domain.dnsMode}</td>
                    <td className="hidden px-6 py-4 sm:table-cell">
                      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${domain.sslAutoRenew ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300' : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400'}`} data-testid={`ssl-badge-${domain.id}`}>
                        <Lock size={10} />
                        {domain.sslAutoRenew ? 'Auto' : 'None'}
                      </span>
                    </td>
                    <td className="hidden px-6 py-4 text-gray-500 dark:text-gray-400 lg:table-cell">
                      {new Date(domain.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showAddModal && (
        <AddDomainModal clientId={clientId!} onClose={() => setShowAddModal(false)} />
      )}
    </div>
  );
}

// ─── Add Domain Modal ────────────────────────────────────────────────────────

function AddDomainModal({ clientId, onClose }: { readonly clientId: string; readonly onClose: () => void }) {
  const createDomain = useCreateDomain(clientId);
  const [domainName, setDomainName] = useState('');
  const [dnsMode, setDnsMode] = useState<'cname' | 'primary' | 'secondary'>('cname');

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!domainName.trim()) return;
    try {
      await createDomain.mutateAsync({ domain_name: domainName.trim(), dns_mode: dnsMode });
      onClose();
    } catch {
      // error shown in modal
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" data-testid="add-domain-modal">
      <div className="fixed inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full max-w-lg rounded-2xl bg-white dark:bg-gray-800 p-6 shadow-xl">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Add Domain</h2>
          <button onClick={onClose} className="rounded-md p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
            <X size={20} />
          </button>
        </div>

        {createDomain.error && (
          <div className="mb-4 rounded-lg bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-600 dark:text-red-400" data-testid="add-domain-error">
            {createDomain.error instanceof Error ? createDomain.error.message : 'Failed to add domain'}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4" data-testid="add-domain-form">
          <div>
            <label htmlFor="domain-name" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Domain Name *
            </label>
            <input
              id="domain-name"
              type="text"
              required
              value={domainName}
              onChange={(e) => setDomainName(e.target.value)}
              className={INPUT_CLASS}
              placeholder="example.com"
              data-testid="domain-name-input"
            />
          </div>

          <div>
            <label htmlFor="dns-mode" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              DNS Mode *
            </label>
            <select
              id="dns-mode"
              value={dnsMode}
              onChange={(e) => setDnsMode(e.target.value as 'cname' | 'primary' | 'secondary')}
              className={INPUT_CLASS}
              data-testid="dns-mode-select"
            >
              <option value="cname">CNAME — I manage my own DNS</option>
              <option value="primary">Primary — Platform manages DNS</option>
              <option value="secondary">Secondary — Zone transfer from master</option>
            </select>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {dnsMode === 'cname' && 'Point your domain to the platform via a CNAME record.'}
              {dnsMode === 'primary' && 'The platform will be the authoritative DNS server for this domain.'}
              {dnsMode === 'secondary' && 'The platform will replicate DNS records from your master server.'}
            </p>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={createDomain.isPending || !domainName.trim()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              data-testid="submit-domain-button"
            >
              {createDomain.isPending && <Loader2 size={14} className="animate-spin" />}
              Add Domain
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
