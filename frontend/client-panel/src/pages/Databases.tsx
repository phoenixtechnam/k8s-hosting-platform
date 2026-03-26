import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Database as DatabaseIcon, Plus, KeyRound, Copy, Check, AlertTriangle } from 'lucide-react';
import { useClientContext } from '@/hooks/use-client-context';
import { useDatabases, useRotateCredentials } from '@/hooks/use-databases';
import CreateDatabaseModal from '@/components/CreateDatabaseModal';

function TypeBadge({ dbType }: { readonly dbType: string }) {
  const colorMap: Record<string, string> = {
    mysql: 'bg-blue-50 text-blue-700 border-blue-200',
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

function RotatedPasswordAlert({
  password,
  onDismiss,
}: {
  readonly password: string;
  readonly onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(password);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4" data-testid="rotated-password-alert">
      <div className="flex items-start gap-3">
        <AlertTriangle size={20} className="mt-0.5 shrink-0 text-amber-600" />
        <div className="flex-1">
          <p className="text-sm font-medium text-amber-800">New password generated</p>
          <p className="mt-1 text-sm text-amber-700">
            Save this password now. It will not be shown again.
          </p>
          <div className="mt-2 flex items-center gap-2 rounded-md border border-amber-200 bg-white px-3 py-2">
            <code className="text-sm font-mono text-gray-900 break-all" data-testid="rotated-password">
              {password}
            </code>
            <button
              onClick={handleCopy}
              className="ml-auto shrink-0 rounded-md p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-700"
              aria-label="Copy password"
              data-testid="copy-rotated-password"
            >
              {copied ? <Check size={14} className="text-green-600" /> : <Copy size={14} />}
            </button>
          </div>
        </div>
        <button
          onClick={onDismiss}
          className="shrink-0 text-sm text-amber-700 underline hover:text-amber-900"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

export default function Databases() {
  const { clientId } = useClientContext();
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error } = useDatabases(clientId ?? undefined);
  const rotateCredentials = useRotateCredentials(clientId ?? undefined);

  const [modalOpen, setModalOpen] = useState(false);
  const [rotatedPassword, setRotatedPassword] = useState<{ databaseId: string; password: string } | null>(null);
  const [rotatingId, setRotatingId] = useState<string | null>(null);

  const databases = data?.data ?? [];

  const handleRotate = async (databaseId: string) => {
    setRotatingId(databaseId);
    try {
      const result = await rotateCredentials.mutateAsync(databaseId);
      setRotatedPassword({ databaseId, password: result.data.password });
    } catch {
      // error can be shown via rotateCredentials.error
    } finally {
      setRotatingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
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
        <button
          onClick={() => setModalOpen(true)}
          className="inline-flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700"
          data-testid="create-database-button"
        >
          <Plus size={16} />
          Create Database
        </button>
      </div>

      {rotatedPassword && (
        <RotatedPasswordAlert
          password={rotatedPassword.password}
          onDismiss={() => setRotatedPassword(null)}
        />
      )}

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
              Create your first database to get started.
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
                  <th className="hidden px-6 py-3 font-medium text-gray-500 sm:table-cell">Username</th>
                  <th className="px-6 py-3 font-medium text-gray-500">Status</th>
                  <th className="hidden px-6 py-3 font-medium text-gray-500 sm:table-cell">Created</th>
                  <th className="px-6 py-3 font-medium text-gray-500">Actions</th>
                </tr>
              </thead>
              <tbody>
                {databases.map((db) => (
                  <tr key={db.id} className="border-b border-gray-100 last:border-0">
                    <td className="px-6 py-4 font-medium text-gray-900">{db.name}</td>
                    <td className="px-6 py-4">
                      <TypeBadge dbType={db.databaseType} />
                    </td>
                    <td className="hidden px-6 py-4 font-mono text-sm text-gray-600 sm:table-cell">
                      {db.username}
                    </td>
                    <td className="px-6 py-4">
                      <StatusBadge status={db.status} />
                    </td>
                    <td className="hidden px-6 py-4 text-gray-500 sm:table-cell">
                      {new Date(db.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-6 py-4">
                      <button
                        onClick={() => handleRotate(db.id)}
                        disabled={rotatingId === db.id}
                        className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                        data-testid={`rotate-password-${db.id}`}
                        title="Rotate password"
                      >
                        <KeyRound size={12} />
                        {rotatingId === db.id ? 'Rotating...' : 'Rotate Password'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {clientId && (
        <CreateDatabaseModal
          open={modalOpen}
          onClose={() => {
            setModalOpen(false);
            queryClient.invalidateQueries({ queryKey: ['databases', clientId] });
          }}
          clientId={clientId}
        />
      )}
    </div>
  );
}
