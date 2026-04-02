import { useState, useCallback } from 'react';
import {
  X, Database, Copy, Check, Eye, EyeOff, RefreshCw, RotateCcw,
  Loader2, Server, Key, Link,
} from 'lucide-react';
import { useDeploymentCredentials, useRegenerateCredentials, useRestartDeployment } from '@/hooks/use-deployments';
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

export default function DatabaseManagementModal({
  open,
  deployment,
  catalogEntry,
  clientId,
  onClose,
}: DatabaseManagementModalProps) {
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [revealedCredentials, setRevealedCredentials] = useState<Set<string>>(new Set());
  const [regenConfirmOpen, setRegenConfirmOpen] = useState(false);
  const [restartConfirmOpen, setRestartConfirmOpen] = useState(false);

  const deploymentId = deployment?.id;
  const { data: credentialsData, isLoading: credentialsLoading } = useDeploymentCredentials(
    clientId,
    open ? deploymentId : undefined,
  );
  const regenerateCredentials = useRegenerateCredentials(clientId);
  const restartMutation = useRestartDeployment(clientId);

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
        <div className="flex items-center justify-end border-t border-gray-200 dark:border-gray-700 pt-4 mt-6">
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
