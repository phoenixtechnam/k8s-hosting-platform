import { Database as DatabaseIcon } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { useDatabases } from '@/hooks/use-databases';

function TypeBadge({ dbType }: { readonly dbType: string }) {
  const colorMap: Record<string, string> = {
    mariadb: 'bg-blue-50 text-blue-700 border-blue-200',
    postgresql: 'bg-indigo-50 text-indigo-700 border-indigo-200',
    redis: 'bg-red-50 text-red-700 border-red-200',
  };
  const colors = colorMap[dbType.toLowerCase()] ?? 'bg-gray-50 text-gray-600 border-gray-200';

  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${colors}`}>
      {dbType}
    </span>
  );
}

function StatusBadge({ status }: { readonly status: string }) {
  const colorMap: Record<string, string> = {
    active: 'bg-green-50 text-green-700 border-green-200',
    provisioning: 'bg-amber-50 text-amber-700 border-amber-200',
    stopped: 'bg-red-50 text-red-700 border-red-200',
    inactive: 'bg-gray-50 text-gray-600 border-gray-200',
  };
  const colors = colorMap[status.toLowerCase()] ?? 'bg-gray-50 text-gray-600 border-gray-200';

  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${colors}`}>
      {status}
    </span>
  );
}

export default function Databases() {
  const { user } = useAuth();
  const { data, isLoading, isError, error } = useDatabases(user?.id);

  const databases = data?.data ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-50 text-green-600">
          <DatabaseIcon size={20} />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900" data-testid="databases-heading">
            Databases
          </h1>
          <p className="text-sm text-gray-500">Manage your database instances.</p>
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
        {isLoading && (
          <div className="flex items-center justify-center py-16" data-testid="databases-loading">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-200 border-t-green-600" />
            <span className="ml-3 text-sm text-gray-500">Loading databases...</span>
          </div>
        )}

        {isError && (
          <div className="px-6 py-16 text-center" data-testid="databases-error">
            <p className="text-sm text-red-600">
              Failed to load databases: {error instanceof Error ? error.message : 'Unknown error'}
            </p>
          </div>
        )}

        {!isLoading && !isError && databases.length === 0 && (
          <div className="px-6 py-16 text-center" data-testid="databases-empty">
            <DatabaseIcon size={40} className="mx-auto text-gray-300" />
            <p className="mt-3 text-sm font-medium text-gray-900">No databases yet</p>
            <p className="mt-1 text-sm text-gray-500">
              Your database instances will appear here once created.
            </p>
          </div>
        )}

        {!isLoading && !isError && databases.length > 0 && (
          <div className="overflow-x-auto" data-testid="databases-table">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50/50">
                  <th className="px-6 py-3 font-medium text-gray-500">Name</th>
                  <th className="px-6 py-3 font-medium text-gray-500">Type</th>
                  <th className="px-6 py-3 font-medium text-gray-500">Status</th>
                  <th className="hidden px-6 py-3 font-medium text-gray-500 sm:table-cell">Created</th>
                </tr>
              </thead>
              <tbody>
                {databases.map((db) => (
                  <tr key={db.id} className="border-b border-gray-100 last:border-0">
                    <td className="px-6 py-4 font-medium text-gray-900">{db.name}</td>
                    <td className="px-6 py-4">
                      <TypeBadge dbType={db.dbType} />
                    </td>
                    <td className="px-6 py-4">
                      <StatusBadge status={db.status} />
                    </td>
                    <td className="hidden px-6 py-4 text-gray-500 sm:table-cell">
                      {new Date(db.createdAt).toLocaleDateString()}
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
