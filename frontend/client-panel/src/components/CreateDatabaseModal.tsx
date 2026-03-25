import { useState, type FormEvent } from 'react';
import { X, Loader2, Copy, Check, AlertTriangle } from 'lucide-react';
import { useCreateDatabase } from '@/hooks/use-databases';

interface CreateDatabaseModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly clientId: string;
}

export default function CreateDatabaseModal({ open, onClose, clientId }: CreateDatabaseModalProps) {
  const [name, setName] = useState('');
  const [dbType, setDbType] = useState<'mysql' | 'postgresql'>('mysql');
  const [createdPassword, setCreatedPassword] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const createDatabase = useCreateDatabase(clientId);

  const resetForm = () => {
    setName('');
    setDbType('mysql');
    setCreatedPassword(null);
    setCopied(false);
    createDatabase.reset();
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const result = await createDatabase.mutateAsync({ name, db_type: dbType });
      setCreatedPassword(result.data.password);
    } catch {
      // error displayed in modal
    }
  };

  const handleCopyPassword = async () => {
    if (!createdPassword) return;
    await navigator.clipboard.writeText(createdPassword);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" data-testid="create-database-modal">
      <div className="fixed inset-0 bg-black/50" onClick={handleClose} />
      <div className="relative w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold text-gray-900">Create Database</h2>
          <button
            onClick={handleClose}
            className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>

        {createDatabase.error && !createdPassword && (
          <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600" data-testid="create-database-error">
            {createDatabase.error instanceof Error ? createDatabase.error.message : 'Failed to create database'}
          </div>
        )}

        {createdPassword ? (
          <div className="space-y-4" data-testid="password-reveal">
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
              <div className="flex items-start gap-3">
                <AlertTriangle size={20} className="mt-0.5 shrink-0 text-amber-600" />
                <div>
                  <p className="text-sm font-medium text-amber-800">Save this password now!</p>
                  <p className="mt-1 text-sm text-amber-700">
                    This is the only time the password will be shown. Store it securely.
                  </p>
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
              <div className="flex items-center justify-between">
                <code className="text-sm font-mono text-gray-900 break-all" data-testid="created-password">
                  {createdPassword}
                </code>
                <button
                  onClick={handleCopyPassword}
                  className="ml-3 shrink-0 rounded-md p-1.5 text-gray-500 hover:bg-gray-200 hover:text-gray-700"
                  aria-label="Copy password"
                  data-testid="copy-password-button"
                >
                  {copied ? <Check size={16} className="text-green-600" /> : <Copy size={16} />}
                </button>
              </div>
            </div>

            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={handleClose}
                className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700"
                data-testid="done-button"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4" data-testid="create-database-form">
            <div>
              <label htmlFor="db-name" className="block text-sm font-medium text-gray-700">
                Database Name *
              </label>
              <input
                id="db-name"
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-green-500 focus:outline-none focus:ring-1 focus:ring-green-500"
                placeholder="my_database"
                pattern="^[a-zA-Z0-9_]+$"
                title="Only alphanumeric characters and underscores"
                data-testid="db-name-input"
              />
            </div>

            <div>
              <label htmlFor="db-type" className="block text-sm font-medium text-gray-700">
                Database Type *
              </label>
              <select
                id="db-type"
                required
                value={dbType}
                onChange={(e) => setDbType(e.target.value as 'mysql' | 'postgresql')}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-green-500 focus:outline-none focus:ring-1 focus:ring-green-500"
                data-testid="db-type-select"
              >
                <option value="mysql">MySQL / MariaDB</option>
                <option value="postgresql">PostgreSQL</option>
              </select>
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={handleClose}
                className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={createDatabase.isPending}
                className="inline-flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
                data-testid="submit-database-button"
              >
                {createDatabase.isPending && <Loader2 size={14} className="animate-spin" />}
                Create Database
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
