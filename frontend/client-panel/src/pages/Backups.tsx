import { Archive } from 'lucide-react';
import { useClientContext } from '@/hooks/use-client-context';
import { useBackups } from '@/hooks/use-backups';

function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes === 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function StatusBadge({ status }: { readonly status: string }) {
  const colorMap: Record<string, string> = {
    completed: 'bg-green-50 text-green-700 border-green-200',
    in_progress: 'bg-blue-50 text-blue-700 border-blue-200',
    pending: 'bg-amber-50 text-amber-700 border-amber-200',
    failed: 'bg-red-50 text-red-700 border-red-200',
    expired: 'bg-gray-50 text-gray-600 border-gray-200',
  };
  const colors = colorMap[status.toLowerCase()] ?? 'bg-gray-50 text-gray-600 border-gray-200';

  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${colors}`}>
      {status}
    </span>
  );
}

export default function Backups() {
  const { clientId } = useClientContext();
  const { data, isLoading, isError, error } = useBackups(clientId ?? undefined);

  const backups = data?.data ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
          <Archive size={20} />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900" data-testid="backups-heading">
            Backups
          </h1>
          <p className="text-sm text-gray-500">View and manage your backup snapshots.</p>
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
        {isLoading && (
          <div className="flex items-center justify-center py-16" data-testid="backups-loading">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-200 border-t-blue-600" />
            <span className="ml-3 text-sm text-gray-500">Loading backups...</span>
          </div>
        )}

        {isError && (
          <div className="px-6 py-16 text-center" data-testid="backups-error">
            <p className="text-sm text-red-600">
              Failed to load backups: {error instanceof Error ? error.message : 'Unknown error'}
            </p>
          </div>
        )}

        {!isLoading && !isError && backups.length === 0 && (
          <div className="px-6 py-16 text-center" data-testid="backups-empty">
            <Archive size={40} className="mx-auto text-gray-300" />
            <p className="mt-3 text-sm font-medium text-gray-900">No backups yet</p>
            <p className="mt-1 text-sm text-gray-500">
              Your backup snapshots will appear here once created.
            </p>
          </div>
        )}

        {!isLoading && !isError && backups.length > 0 && (
          <div className="overflow-x-auto" data-testid="backups-table">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50/50">
                  <th className="px-6 py-3 font-medium text-gray-500">Backup ID</th>
                  <th className="px-6 py-3 font-medium text-gray-500">Type</th>
                  <th className="hidden px-6 py-3 font-medium text-gray-500 md:table-cell">Resource</th>
                  <th className="px-6 py-3 font-medium text-gray-500">Status</th>
                  <th className="hidden px-6 py-3 font-medium text-gray-500 sm:table-cell">Size</th>
                  <th className="hidden px-6 py-3 font-medium text-gray-500 lg:table-cell">Created</th>
                  <th className="hidden px-6 py-3 font-medium text-gray-500 lg:table-cell">Expires</th>
                </tr>
              </thead>
              <tbody>
                {backups.map((backup) => (
                  <tr key={backup.id} className="border-b border-gray-100 last:border-0">
                    <td className="px-6 py-4 font-mono text-xs text-gray-900">{backup.id.slice(0, 8)}</td>
                    <td className="px-6 py-4 text-gray-600">{backup.backupType}</td>
                    <td className="hidden px-6 py-4 text-gray-600 md:table-cell">{backup.resourceType}</td>
                    <td className="px-6 py-4">
                      <StatusBadge status={backup.status} />
                    </td>
                    <td className="hidden px-6 py-4 text-gray-600 sm:table-cell">
                      {formatBytes(backup.sizeBytes)}
                    </td>
                    <td className="hidden px-6 py-4 text-gray-500 lg:table-cell">
                      {new Date(backup.createdAt).toLocaleDateString()}
                    </td>
                    <td className="hidden px-6 py-4 text-gray-500 lg:table-cell">
                      {backup.expiresAt ? new Date(backup.expiresAt).toLocaleDateString() : '-'}
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
