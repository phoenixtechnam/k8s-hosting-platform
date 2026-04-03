import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  X, Database, Copy, Check, Eye, EyeOff, RefreshCw, RotateCcw,
  Loader2, Server, Key, Link, Plus, Trash2, Users, ExternalLink, Terminal,
} from 'lucide-react';
import {
  useDeploymentCredentials,
  useRegenerateCredentials,
  useRestartDeployment,
  useDbDatabases,
  useCreateDbDatabase,
  useDropDbDatabase,
  useDbUsers,
  useCreateDbUser,
  useDropDbUser,
  useSetDbUserPassword,
  useAdminerLogin,
} from '@/hooks/use-deployments';
import type { Deployment, CatalogEntry } from '@/types/api';

interface DatabaseManagementModalProps {
  readonly open: boolean;
  readonly deployment: Deployment | null;
  readonly catalogEntry: CatalogEntry | null;
  readonly clientId: string | undefined;
  readonly onClose: () => void;
}

function copyToClipboard(text: string): void {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text);
  } else {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }
}

function humanizeEnvVar(key: string): string {
  return key
    .replace(/^(MARIADB|MYSQL|POSTGRES|POSTGRESQL|MONGODB|REDIS|MINIO)_/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function buildConnectionUrl(connectionInfo: {
  readonly host?: string;
  readonly port?: number;
  readonly database?: string;
  readonly username?: string;
}): string | null {
  if (!connectionInfo.host || !connectionInfo.port) return null;
  const protocol = connectionInfo.port === 3306
    ? 'mysql'
    : connectionInfo.port === 5432
      ? 'postgresql'
      : 'redis';
  const userPart = connectionInfo.username ? `${connectionInfo.username}:***@` : '';
  const dbPart = connectionInfo.database ? `/${connectionInfo.database}` : '';
  return `${protocol}://${userPart}${connectionInfo.host}:${connectionInfo.port}${dbPart}`;
}

function generateRandomPassword(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

function CopyButton({
  field,
  value,
  copiedField,
  onCopy,
}: {
  readonly field: string;
  readonly value: string;
  readonly copiedField: string | null;
  readonly onCopy: (field: string, value: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onCopy(field, value)}
      className="shrink-0 rounded p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
      data-testid={`copy-${field}`}
    >
      {copiedField === field ? (
        <Check size={14} className="text-green-500" />
      ) : (
        <Copy size={14} />
      )}
    </button>
  );
}

function ConnectionRow({
  label,
  value,
  field,
  copiedField,
  onCopy,
}: {
  readonly label: string;
  readonly value: string;
  readonly field: string;
  readonly copiedField: string | null;
  readonly onCopy: (field: string, value: string) => void;
}) {
  return (
    <div className="flex items-center justify-between text-sm" data-testid={`conn-row-${field}`}>
      <span className="text-xs font-medium text-gray-500 dark:text-gray-400 w-28 shrink-0">{label}</span>
      <div className="flex items-center gap-2 min-w-0">
        <span className="font-mono text-sm text-gray-900 dark:text-gray-100 truncate select-all">
          {value}
        </span>
        <CopyButton field={field} value={value} copiedField={copiedField} onCopy={onCopy} />
      </div>
    </div>
  );
}

// ─── Databases Section ────────────────────────────────────────────────────────

function DatabasesSection({
  clientId,
  deploymentId,
}: {
  readonly clientId: string | undefined;
  readonly deploymentId: string | undefined;
}) {
  const [newDbName, setNewDbName] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const { data: dbData, isLoading, isError } = useDbDatabases(clientId, deploymentId);
  const createDb = useCreateDbDatabase(clientId);
  const dropDb = useDropDbDatabase(clientId);

  const databases = dbData?.data ?? [];

  const handleCreate = useCallback(() => {
    if (!deploymentId || !newDbName.trim()) return;
    setErrorMessage(null);
    createDb.mutate(
      { deploymentId, name: newDbName.trim() },
      {
        onSuccess: () => setNewDbName(''),
        onError: (err) => setErrorMessage(err instanceof Error ? err.message : 'Failed to create database'),
      },
    );
  }, [deploymentId, newDbName, createDb]);

  const handleDrop = useCallback(
    (name: string) => {
      if (!deploymentId) return;
      setErrorMessage(null);
      dropDb.mutate(
        { deploymentId, name },
        {
          onSuccess: () => setDeleteConfirm(null),
          onError: (err) => setErrorMessage(err instanceof Error ? err.message : 'Failed to delete database'),
        },
      );
    },
    [deploymentId, dropDb],
  );

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-4" data-testid="databases-card">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100 mb-4">
        <Database size={16} className="text-blue-600 dark:text-blue-400" />
        Databases
      </h3>

      {isLoading && (
        <div className="flex items-center justify-center py-4">
          <Loader2 size={18} className="animate-spin text-gray-400" />
        </div>
      )}

      {isError && (
        <p className="text-sm text-red-600 dark:text-red-400 py-2" data-testid="databases-error">
          Failed to load databases. The deployment may not be running.
        </p>
      )}

      {!isLoading && !isError && (
        <>
          {databases.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400 py-2">No databases found.</p>
          ) : (
            <div className="space-y-2 mb-4">
              {databases.map((db) => (
                <div
                  key={db.name}
                  className="flex items-center justify-between rounded-md bg-gray-50 dark:bg-gray-900/50 px-3 py-2"
                  data-testid={`db-row-${db.name}`}
                >
                  <span className="font-mono text-sm text-gray-900 dark:text-gray-100">{db.name}</span>
                  {deleteConfirm === db.name ? (
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => handleDrop(db.name)}
                        disabled={dropDb.isPending}
                        className="rounded px-2 py-1 text-xs font-medium text-red-700 bg-red-100 hover:bg-red-200 dark:text-red-300 dark:bg-red-900/30 dark:hover:bg-red-900/50 disabled:opacity-50"
                        data-testid={`db-delete-confirm-${db.name}`}
                      >
                        {dropDb.isPending ? <Loader2 size={12} className="animate-spin" /> : 'Confirm'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteConfirm(null)}
                        className="rounded px-2 py-1 text-xs font-medium text-gray-600 bg-gray-200 hover:bg-gray-300 dark:text-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600"
                        data-testid={`db-delete-cancel-${db.name}`}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setDeleteConfirm(db.name)}
                      className="rounded p-1 text-gray-400 hover:text-red-500 dark:hover:text-red-400 transition-colors"
                      data-testid={`db-delete-${db.name}`}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Create Database Form */}
          <div className="flex items-center gap-2 pt-2 border-t border-gray-100 dark:border-gray-700" data-testid="create-db-form">
            <input
              type="text"
              value={newDbName}
              onChange={(e) => setNewDbName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
              placeholder="new_database_name"
              className="flex-1 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-1.5 text-sm font-mono text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
              data-testid="create-db-input"
            />
            <button
              type="button"
              onClick={handleCreate}
              disabled={createDb.isPending || !newDbName.trim()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              data-testid="create-db-button"
            >
              {createDb.isPending ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Plus size={14} />
              )}
              Create
            </button>
          </div>

          {errorMessage && (
            <p className="mt-2 text-sm text-red-600 dark:text-red-400" data-testid="db-action-error">
              {errorMessage}
            </p>
          )}
        </>
      )}
    </div>
  );
}

// ─── Users Section ────────────────────────────────────────────────────────────

function UsersSection({
  clientId,
  deploymentId,
  databases,
}: {
  readonly clientId: string | undefined;
  readonly deploymentId: string | undefined;
  readonly databases: readonly { name: string }[];
}) {
  const [newUsername, setNewUsername] = useState('');
  const [newDatabase, setNewDatabase] = useState('__all__');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [createdPassword, setCreatedPassword] = useState<string | null>(null);
  const [regeneratedPassword, setRegeneratedPassword] = useState<{ username: string; password: string } | null>(null);

  const { data: usersData, isLoading, isError } = useDbUsers(clientId, deploymentId);
  const createUser = useCreateDbUser(clientId);
  const dropUser = useDropDbUser(clientId);
  const setPassword = useSetDbUserPassword(clientId);
  const adminerLogin = useAdminerLogin(clientId);

  const users = usersData?.data ?? [];

  const handleAdminerLogin = useCallback(
    (username: string) => {
      if (!deploymentId) return;
      setErrorMessage(null);
      adminerLogin.mutate(
        { deploymentId, username },
        {
          onSuccess: (result) => {
            // The loginUrl is a relative path (/adminer/auto-login?...)
            // served by the client panel's nginx proxy on the same origin.
            // No need to prepend any external URL.
            window.open(result.data.loginUrl, '_blank');
          },
          onError: (err) => setErrorMessage(err instanceof Error ? err.message : 'Failed to open Adminer'),
        },
      );
    },
    [deploymentId, adminerLogin],
  );

  const handleCreate = useCallback(() => {
    if (!deploymentId || !newUsername.trim()) return;
    setErrorMessage(null);
    setCreatedPassword(null);
    const generatedPassword = generateRandomPassword();
    createUser.mutate(
      {
        deploymentId,
        username: newUsername.trim(),
        password: generatedPassword,
        database: newDatabase === '__all__' ? undefined : newDatabase,
      },
      {
        onSuccess: () => {
          setCreatedPassword(generatedPassword);
          setNewUsername('');
          setNewDatabase('__all__');
          setShowCreateForm(false);
        },
        onError: (err) => setErrorMessage(err instanceof Error ? err.message : 'Failed to create user'),
      },
    );
  }, [deploymentId, newUsername, newDatabase, createUser]);

  const handleDrop = useCallback(
    (username: string) => {
      if (!deploymentId) return;
      setErrorMessage(null);
      dropUser.mutate(
        { deploymentId, username },
        {
          onSuccess: () => setDeleteConfirm(null),
          onError: (err) => setErrorMessage(err instanceof Error ? err.message : 'Failed to delete user'),
        },
      );
    },
    [deploymentId, dropUser],
  );

  const handleRegeneratePassword = useCallback(
    (username: string) => {
      if (!deploymentId) return;
      setErrorMessage(null);
      setRegeneratedPassword(null);
      const generatedPassword = generateRandomPassword();
      setPassword.mutate(
        { deploymentId, username, password: generatedPassword },
        {
          onSuccess: () => {
            setRegeneratedPassword({ username, password: generatedPassword });
          },
          onError: (err) => setErrorMessage(err instanceof Error ? err.message : 'Failed to regenerate password'),
        },
      );
    },
    [deploymentId, setPassword],
  );

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-4" data-testid="db-users-card">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100 mb-4">
        <Users size={16} className="text-blue-600 dark:text-blue-400" />
        Database Users
      </h3>

      {isLoading && (
        <div className="flex items-center justify-center py-4">
          <Loader2 size={18} className="animate-spin text-gray-400" />
        </div>
      )}

      {isError && (
        <p className="text-sm text-red-600 dark:text-red-400 py-2" data-testid="db-users-error">
          Failed to load users. The deployment may not be running.
        </p>
      )}

      {!isLoading && !isError && (
        <>
          {/* Root user row — always shown */}
          <div className="space-y-2 mb-4">
            <div data-testid="user-row-root">
              <div className="flex items-center justify-between rounded-md bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-3 py-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-mono text-sm font-semibold text-amber-800 dark:text-amber-300">
                    root
                  </span>
                  <span className="text-xs text-amber-600 dark:text-amber-400">
                    — Superuser
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => handleAdminerLogin('root')}
                    disabled={adminerLogin.isPending}
                    className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-amber-700 bg-amber-100 hover:bg-amber-200 dark:text-amber-300 dark:bg-amber-900/40 dark:hover:bg-amber-900/60 transition-colors disabled:opacity-50"
                    title="Open in Adminer as root"
                    data-testid="user-adminer-root"
                  >
                    {adminerLogin.isPending ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <ExternalLink size={12} />
                    )}
                    Adminer
                  </button>
                </div>
              </div>
            </div>
          </div>

          {users.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400 py-2">No additional users found.</p>
          ) : (
            <div className="space-y-2 mb-4">
              {users.map((user) => (
                <div key={user.username} data-testid={`user-row-${user.username}`}>
                  <div className="flex items-center justify-between rounded-md bg-gray-50 dark:bg-gray-900/50 px-3 py-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm text-gray-900 dark:text-gray-100">
                          {user.username}
                        </span>
                      </div>
                      <span className="text-xs text-gray-400 dark:text-gray-500">
                        {user.databases && user.databases.length > 0
                          ? user.databases.map((d) => `@${d}`).join(', ')
                          : '@ALL'}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => handleAdminerLogin(user.username)}
                        disabled={adminerLogin.isPending}
                        className="rounded p-1 text-gray-400 hover:text-green-500 dark:hover:text-green-400 transition-colors"
                        title="Open in Adminer"
                        data-testid={`user-adminer-${user.username}`}
                      >
                        {adminerLogin.isPending ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <ExternalLink size={14} />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRegeneratePassword(user.username)}
                        disabled={setPassword.isPending}
                        className="rounded p-1 text-gray-400 hover:text-blue-500 dark:hover:text-blue-400 transition-colors"
                        title="Regenerate password"
                        data-testid={`user-set-password-${user.username}`}
                      >
                        {setPassword.isPending ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <RefreshCw size={14} />
                        )}
                      </button>
                      {deleteConfirm === user.username ? (
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => handleDrop(user.username)}
                            disabled={dropUser.isPending}
                            className="rounded px-2 py-1 text-xs font-medium text-red-700 bg-red-100 hover:bg-red-200 dark:text-red-300 dark:bg-red-900/30 dark:hover:bg-red-900/50 disabled:opacity-50"
                            data-testid={`user-delete-confirm-${user.username}`}
                          >
                            {dropUser.isPending ? <Loader2 size={12} className="animate-spin" /> : 'Delete'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeleteConfirm(null)}
                            className="rounded px-2 py-1 text-xs font-medium text-gray-600 bg-gray-200 hover:bg-gray-300 dark:text-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600"
                            data-testid={`user-delete-cancel-${user.username}`}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setDeleteConfirm(user.username)}
                          className="rounded p-1 text-gray-400 hover:text-red-500 dark:hover:text-red-400 transition-colors"
                          data-testid={`user-delete-${user.username}`}
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Regenerated password banner */}
          {regeneratedPassword && (
            <div className="mb-4 rounded-lg border border-green-200 dark:border-green-700 bg-green-50 dark:bg-green-900/20 p-3" data-testid="regenerated-password-banner">
              <p className="text-sm font-medium text-green-800 dark:text-green-300 mb-1">
                New password for <span className="font-mono font-semibold">{regeneratedPassword.username}</span>. Copy it now — it will not be shown again.
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded bg-white dark:bg-gray-900 border border-green-200 dark:border-green-700 px-3 py-1.5 font-mono text-sm text-gray-900 dark:text-gray-100 select-all truncate">
                  {regeneratedPassword.password}
                </code>
                <button
                  type="button"
                  onClick={() => copyToClipboard(regeneratedPassword.password)}
                  className="shrink-0 rounded-lg bg-green-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-green-700"
                  data-testid="copy-regenerated-password"
                >
                  <Copy size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => setRegeneratedPassword(null)}
                  className="shrink-0 rounded p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                  data-testid="dismiss-regenerated-password"
                >
                  <X size={14} />
                </button>
              </div>
            </div>
          )}

          {/* Create User Form */}
          <div className="pt-2 border-t border-gray-100 dark:border-gray-700">
            {!showCreateForm ? (
              <button
                type="button"
                onClick={() => setShowCreateForm(true)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
                data-testid="show-create-user-form"
              >
                <Plus size={14} />
                Add User
              </button>
            ) : (
              <div className="space-y-3" data-testid="create-user-form">
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={newUsername}
                    onChange={(e) => setNewUsername(e.target.value)}
                    placeholder="username"
                    className="flex-1 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-1.5 text-sm font-mono text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                    data-testid="create-user-username"
                  />
                </div>
                <select
                  value={newDatabase}
                  onChange={(e) => setNewDatabase(e.target.value)}
                  className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                  data-testid="create-user-database"
                >
                  <option value="__all__">All databases</option>
                  {databases.map((db) => (
                    <option key={db.name} value={db.name}>
                      {db.name}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  A secure password will be generated automatically.
                </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleCreate}
                    disabled={createUser.isPending || !newUsername.trim()}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    data-testid="create-user-submit"
                  >
                    {createUser.isPending ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Plus size={14} />
                    )}
                    Create User
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowCreateForm(false);
                      setNewUsername('');
                      setNewDatabase('__all__');
                    }}
                    className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
                    data-testid="create-user-cancel"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>

          {createdPassword && (
            <div className="mt-3 rounded-lg border border-green-200 dark:border-green-700 bg-green-50 dark:bg-green-900/20 p-3" data-testid="created-password-banner">
              <p className="text-sm font-medium text-green-800 dark:text-green-300 mb-1">
                User created successfully. Copy the password now — it will not be shown again.
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded bg-white dark:bg-gray-900 border border-green-200 dark:border-green-700 px-3 py-1.5 font-mono text-sm text-gray-900 dark:text-gray-100 select-all truncate">
                  {createdPassword}
                </code>
                <button
                  type="button"
                  onClick={() => {
                    copyToClipboard(createdPassword);
                  }}
                  className="shrink-0 rounded-lg bg-green-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-green-700"
                  data-testid="copy-created-password"
                >
                  <Copy size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => setCreatedPassword(null)}
                  className="shrink-0 rounded p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                  data-testid="dismiss-created-password"
                >
                  <X size={14} />
                </button>
              </div>
            </div>
          )}

          {errorMessage && (
            <p className="mt-2 text-sm text-red-600 dark:text-red-400" data-testid="user-action-error">
              {errorMessage}
            </p>
          )}
        </>
      )}
    </div>
  );
}

// ─── Main Modal ───────────────────────────────────────────────────────────────

export default function DatabaseManagementModal({
  open,
  deployment,
  catalogEntry,
  clientId,
  onClose,
}: DatabaseManagementModalProps) {
  const navigate = useNavigate();
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [revealedCredentials, setRevealedCredentials] = useState<Set<string>>(new Set());
  const [regenConfirmOpen, setRegenConfirmOpen] = useState(false);
  const [restartConfirmOpen, setRestartConfirmOpen] = useState(false);

  const deploymentId = deployment?.id;
  const isDatabase = catalogEntry?.type === 'database';

  const { data: credentialsData, isLoading: credentialsLoading } = useDeploymentCredentials(
    clientId,
    open ? deploymentId : undefined,
  );
  const regenerateCredentials = useRegenerateCredentials(clientId);
  const restartMutation = useRestartDeployment(clientId);

  // Only fetch databases list when modal is open and deployment is a database type
  const { data: dbData } = useDbDatabases(
    clientId,
    open && isDatabase ? deploymentId : undefined,
  );
  const databases = dbData?.data ?? [];

  const credentialsResult = credentialsData?.data ?? null;

  const handleCopy = useCallback((field: string, value: string) => {
    copyToClipboard(value);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  }, []);

  const toggleCredentialVisibility = useCallback((key: string) => {
    setRevealedCredentials((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const handleRegenerate = useCallback(() => {
    if (!deploymentId) return;
    regenerateCredentials.mutate(
      { deploymentId, keys: credentialsResult?.generatedKeys ? [...credentialsResult.generatedKeys] : undefined },
      {
        onSuccess: () => {
          setRegenConfirmOpen(false);
          setRevealedCredentials(new Set());
        },
      },
    );
  }, [deploymentId, regenerateCredentials, credentialsResult?.generatedKeys]);

  const handleRestart = useCallback(() => {
    if (!deploymentId) return;
    restartMutation.mutate(deploymentId, {
      onSuccess: () => {
        setRestartConfirmOpen(false);
      },
    });
  }, [deploymentId, restartMutation]);

  if (!open || !deployment) return null;

  const connectionUrl = credentialsResult?.connectionInfo
    ? (credentialsResult.connectionInfo.connectionUrl ?? buildConnectionUrl(credentialsResult.connectionInfo))
    : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" data-testid="database-management-modal">
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/50" onClick={onClose} />

      {/* Panel */}
      <div
        className="relative w-full max-w-2xl rounded-2xl bg-white dark:bg-gray-800 p-6 shadow-xl max-h-[90vh] overflow-y-auto"
        role="dialog"
        aria-label={`${deployment.name} database management`}
      >
        {/* Header */}
        <div className="flex items-start justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center rounded-lg bg-blue-50 dark:bg-blue-900/30 p-2">
              <Database size={24} className="text-blue-600 dark:text-blue-400" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100">
                {deployment.name}
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Database Management
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            data-testid="db-modal-close-button"
          >
            <X size={20} />
          </button>
        </div>

        {credentialsLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={24} className="animate-spin text-gray-400" />
          </div>
        ) : (
          <div className="space-y-6">
            {/* Connection Info Card */}
            {credentialsResult?.connectionInfo && (
              <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-4" data-testid="connection-info-card">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100 mb-4">
                  <Server size={16} className="text-blue-600 dark:text-blue-400" />
                  Connection Info
                </h3>
                <div className="space-y-3">
                  {credentialsResult.connectionInfo.host && (
                    <ConnectionRow
                      label="Host"
                      value={credentialsResult.connectionInfo.host}
                      field="host"
                      copiedField={copiedField}
                      onCopy={handleCopy}
                    />
                  )}
                  {credentialsResult.connectionInfo.port != null && (
                    <ConnectionRow
                      label="Port"
                      value={String(credentialsResult.connectionInfo.port)}
                      field="port"
                      copiedField={copiedField}
                      onCopy={handleCopy}
                    />
                  )}
                  {credentialsResult.connectionInfo.database && (
                    <ConnectionRow
                      label="Database"
                      value={credentialsResult.connectionInfo.database}
                      field="database"
                      copiedField={copiedField}
                      onCopy={handleCopy}
                    />
                  )}
                  {credentialsResult.connectionInfo.username && (
                    <ConnectionRow
                      label="Username"
                      value={credentialsResult.connectionInfo.username}
                      field="username"
                      copiedField={copiedField}
                      onCopy={handleCopy}
                    />
                  )}
                </div>

                {/* Connection URL */}
                {connectionUrl && (
                  <div className="mt-4 pt-3 border-t border-gray-100 dark:border-gray-700">
                    <div className="flex items-center gap-2 text-sm mb-2">
                      <Link size={14} className="text-gray-400" />
                      <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Connection URL</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 rounded-lg bg-gray-900 text-green-400 px-3 py-2 font-mono text-sm truncate select-all dark:bg-gray-950">
                        {connectionUrl}
                      </code>
                      <CopyButton
                        field="connection-url"
                        value={connectionUrl}
                        copiedField={copiedField}
                        onCopy={handleCopy}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Credentials Card */}
            {Object.keys(credentialsResult?.credentials ?? {}).length > 0 && (
              <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-4" data-testid="credentials-card">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100 mb-4">
                  <Key size={16} className="text-blue-600 dark:text-blue-400" />
                  Credentials
                </h3>
                <div className="space-y-3">
                  {Object.entries(credentialsResult!.credentials).map(([key, value]) => {
                    const isRevealed = revealedCredentials.has(key);
                    return (
                      <div key={key} className="flex items-center justify-between text-sm" data-testid={`credential-row-${key}`}>
                        <span className="text-xs font-medium text-gray-500 dark:text-gray-400 w-28 shrink-0">
                          {humanizeEnvVar(key)}
                        </span>
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="font-mono text-sm text-gray-900 dark:text-gray-100 truncate select-all">
                            {isRevealed ? value : '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'}
                          </span>
                          <button
                            type="button"
                            onClick={() => toggleCredentialVisibility(key)}
                            className="shrink-0 rounded p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                            data-testid={`toggle-credential-${key}`}
                          >
                            {isRevealed ? <EyeOff size={14} /> : <Eye size={14} />}
                          </button>
                          <CopyButton
                            field={`cred-${key}`}
                            value={value}
                            copiedField={copiedField}
                            onCopy={handleCopy}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Regenerate Passwords */}
                {(credentialsResult?.generatedKeys?.length ?? 0) > 0 && (
                  <div className="mt-4 pt-3 border-t border-gray-100 dark:border-gray-700">
                    {!regenConfirmOpen ? (
                      <button
                        type="button"
                        onClick={() => setRegenConfirmOpen(true)}
                        className="inline-flex items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
                        data-testid="regenerate-passwords-button"
                      >
                        <RefreshCw size={14} />
                        Regenerate Passwords
                      </button>
                    ) : (
                      <div className="rounded-lg border border-amber-200 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-3" data-testid="regenerate-confirm">
                        <p className="text-sm text-amber-800 dark:text-amber-300 mb-3">
                          This will generate new passwords. Running containers will need to be restarted.
                        </p>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={handleRegenerate}
                            disabled={regenerateCredentials.isPending}
                            className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed"
                            data-testid="regenerate-confirm-button"
                          >
                            {regenerateCredentials.isPending ? (
                              <Loader2 size={14} className="animate-spin" />
                            ) : (
                              <RefreshCw size={14} />
                            )}
                            Confirm
                          </button>
                          <button
                            type="button"
                            onClick={() => setRegenConfirmOpen(false)}
                            disabled={regenerateCredentials.isPending}
                            className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
                            data-testid="regenerate-cancel-button"
                          >
                            Cancel
                          </button>
                        </div>
                        {regenerateCredentials.isSuccess && (
                          <p className="mt-2 text-sm text-green-600 dark:text-green-400" data-testid="regenerate-success">
                            Credentials regenerated successfully
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Databases Section — only for database-type deployments */}
            {isDatabase && (
              <DatabasesSection
                clientId={clientId}
                deploymentId={deploymentId}
              />
            )}

            {/* Users Section — only for database-type deployments */}
            {isDatabase && (
              <UsersSection
                clientId={clientId}
                deploymentId={deploymentId}
                databases={databases}
              />
            )}

            {/* Actions Card */}
            <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-4" data-testid="actions-card">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100 mb-4">
                <RotateCcw size={16} className="text-blue-600 dark:text-blue-400" />
                Actions
              </h3>
              {!restartConfirmOpen ? (
                <button
                  type="button"
                  onClick={() => setRestartConfirmOpen(true)}
                  className="inline-flex items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
                  data-testid="restart-database-button"
                >
                  <RotateCcw size={14} />
                  Restart Database
                </button>
              ) : (
                <div className="rounded-lg border border-amber-200 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-3" data-testid="restart-confirm">
                  <p className="text-sm text-amber-800 dark:text-amber-300 mb-3">
                    This will perform a rolling restart of the database. There may be brief downtime.
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleRestart}
                      disabled={restartMutation.isPending}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed"
                      data-testid="restart-confirm-button"
                    >
                      {restartMutation.isPending ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <RotateCcw size={14} />
                      )}
                      Confirm Restart
                    </button>
                    <button
                      type="button"
                      onClick={() => setRestartConfirmOpen(false)}
                      disabled={restartMutation.isPending}
                      className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
                      data-testid="restart-cancel-button"
                    >
                      Cancel
                    </button>
                  </div>
                  {restartMutation.isSuccess && (
                    <p className="mt-2 text-sm text-green-600 dark:text-green-400" data-testid="restart-success">
                      Rolling restart initiated successfully
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-gray-200 dark:border-gray-700 pt-4 mt-6">
          {isDatabase && (
            <button
              type="button"
              onClick={() => {
                onClose();
                navigate(`/database-manager?deploymentId=${deployment.id}`);
              }}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              data-testid="open-sql-manager-button"
            >
              <Terminal size={14} />
              Open SQL Manager
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
            data-testid="db-modal-close-footer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
