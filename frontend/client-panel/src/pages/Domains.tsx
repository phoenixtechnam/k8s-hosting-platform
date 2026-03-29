import { Link } from 'react-router-dom';
import { Globe, ExternalLink } from 'lucide-react';
import { useClientContext } from '@/hooks/use-client-context';
import { useDomains } from '@/hooks/use-domains';

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

export default function Domains() {
  const { clientId } = useClientContext();
  const { data, isLoading, isError, error } = useDomains(clientId ?? undefined);

  const domains = data?.data ?? [];

  return (
    <div className="space-y-6">
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

        {!isLoading && !isError && domains.length === 0 && (
          <div className="px-6 py-16 text-center" data-testid="domains-empty">
            <Globe size={40} className="mx-auto text-gray-300 dark:text-gray-600" />
            <p className="mt-3 text-sm font-medium text-gray-900 dark:text-gray-100">No domains yet</p>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Your domain names will appear here once added.
            </p>
          </div>
        )}

        {!isLoading && !isError && domains.length > 0 && (
          <div className="overflow-x-auto" data-testid="domains-table">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/50">
                  <th className="px-6 py-3 font-medium text-gray-500 dark:text-gray-400">Domain Name</th>
                  <th className="px-6 py-3 font-medium text-gray-500 dark:text-gray-400">Status</th>
                  <th className="hidden px-6 py-3 font-medium text-gray-500 dark:text-gray-400 md:table-cell">DNS Mode</th>
                  <th className="hidden px-6 py-3 font-medium text-gray-500 dark:text-gray-400 sm:table-cell">SSL</th>
                  <th className="hidden px-6 py-3 font-medium text-gray-500 dark:text-gray-400 lg:table-cell">Created</th>
                  <th className="px-6 py-3 font-medium text-gray-500 dark:text-gray-400">Actions</th>
                </tr>
              </thead>
              <tbody>
                {domains.map((domain) => (
                  <tr key={domain.id} className="border-b border-gray-100 dark:border-gray-700 last:border-0">
                    <td className="px-6 py-4 font-medium text-gray-900 dark:text-gray-100">{domain.domainName}</td>
                    <td className="px-6 py-4">
                      <StatusBadge status={domain.status} />
                    </td>
                    <td className="hidden px-6 py-4 text-gray-600 dark:text-gray-400 md:table-cell">{domain.dnsMode}</td>
                    <td className="hidden px-6 py-4 sm:table-cell">
                      <span className={domain.sslAutoRenew ? 'text-green-600' : 'text-gray-400'}>
                        {domain.sslAutoRenew ? 'Yes' : 'No'}
                      </span>
                    </td>
                    <td className="hidden px-6 py-4 text-gray-500 dark:text-gray-400 lg:table-cell">
                      {new Date(domain.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-6 py-4">
                      <Link
                        to={`/domains/${domain.id}`}
                        className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
                        data-testid={`manage-domain-${domain.id}`}
                      >
                        <ExternalLink size={12} />
                        Manage
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
