import { useState, useCallback } from 'react';
import { X, Play, Square, Cpu, HardDrive, Server, Clock, Shield, Eye, EyeOff, AppWindow, Loader2, Copy, Check, KeyRound, RefreshCw, Link } from 'lucide-react';
import { getStatusColor } from '@/lib/status-colors';
import { useDeploymentCredentials, useRegenerateCredentials } from '@/hooks/use-deployments';
import type { Deployment, CatalogEntry } from '@/types/api';

interface ComponentEntry {
  readonly name?: string;
  readonly type?: string;
  readonly image?: string;
}

interface ParameterEntry {
  readonly key?: string;
  readonly label?: string;
  readonly type?: string;
  readonly default?: unknown;
  readonly required?: boolean;
}

function parseJsonField<T>(value: unknown): T | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
  return value as T;
}

function getIconUrl(entryId: string | null | undefined): string | null {
  if (!entryId) return null;
  const base = import.meta.env.VITE_API_URL || '';
  return `${base}/api/v1/catalog/${entryId}/icon`;
}

function AppIcon({ entryId, size = 48 }: { readonly entryId?: string | null; readonly size?: number }) {
  const [failed, setFailed] = useState(false);
  const url = getIconUrl(entryId);
  if (!url || failed) {
    return (
      <div className="flex items-center justify-center rounded-lg bg-gray-100 dark:bg-gray-700" style={{ width: size, height: size }}>
        <AppWindow size={size * 0.5} className="text-gray-400" />
      </div>
    );
  }
  return (
    <img
      src={url}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      className="rounded-lg object-contain"
      style={{ width: size, height: size }}
    />
  );
}

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '-';
  try {
    return new Date(dateStr).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return dateStr;
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

const typeBadgeColors: Record<string, string> = {
  deployment: 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  statefulset: 'bg-purple-50 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
  cronjob: 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  job: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
};

interface InstalledAppDetailModalProps {
  readonly open: boolean;
  readonly deployment: Deployment | null;
  readonly catalogEntry: CatalogEntry | null;
  readonly clientId: string | undefined;
  readonly onClose: () => void;
  readonly onToggleStatus: (deploymentId: string, newStatus: 'running' | 'stopped') => void;
  readonly isToggling: boolean;
}

export default function InstalledAppDetailModal({
  open,
  deployment,
  catalogEntry,
  clientId,
  onClose,
  onToggleStatus,
  isToggling,
}: InstalledAppDetailModalProps) {
  const [revealedSecrets, setRevealedSecrets] = useState<Set<string>>(new Set());
  const [revealedCredentials, setRevealedCredentials] = useState<Set<string>>(new Set());
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [regenConfirmOpen, setRegenConfirmOpen] = useState(false);

  const deploymentId = deployment?.id;
  const { data: credentialsData, isLoading: credentialsLoading } = useDeploymentCredentials(
    clientId,
    open ? deploymentId : undefined,
  );
  const regenerateCredentials = useRegenerateCredentials(clientId);

  const credentialsResult = credentialsData?.data ?? null;
  const hasCredentials = credentialsResult != null &&
    (Object.keys(credentialsResult.credentials).length > 0 || credentialsResult.connectionInfo != null);

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

  const copyToClipboard = useCallback(async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2000);
    } catch {
      // Clipboard API not available
    }
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

  if (!open || !deployment) return null;

  const components = parseJsonField<readonly ComponentEntry[]>(catalogEntry?.components) ?? (Array.isArray(catalogEntry?.components) ? catalogEntry.components as readonly ComponentEntry[] : []);

  const parameters = parseJsonField<readonly ParameterEntry[]>(catalogEntry?.parameters) ?? (Array.isArray(catalogEntry?.parameters) ? catalogEntry.parameters as readonly ParameterEntry[] : []);

  const configuration: Record<string, unknown> = (() => {
    const raw = deployment.configuration;
    if (raw == null) return {};
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {};
      } catch {
        return {};
      }
    }
    return typeof raw === 'object' ? raw as Record<string, unknown> : {};
  })();

  const configKeys = Object.keys(configuration);

  const secretKeys = new Set(
    parameters
      .filter((p) => p.type === 'secret')
      .map((p) => p.key)
      .filter((k): k is string => k != null),
  );

  const toggleSecret = (key: string) => {
    const next = new Set(revealedSecrets);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    setRevealedSecrets(next);
  };

  const isActionable = deployment.status === 'running' || deployment.status === 'stopped' || deployment.status === 'failed';
  const isTransitioning = deployment.status === 'deploying' || deployment.status === 'pending' || deployment.status === 'upgrading';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" data-testid="installed-app-detail-modal">
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/50" onClick={onClose} />

      {/* Panel */}
      <div
        className="relative w-full max-w-2xl rounded-2xl bg-white dark:bg-gray-800 p-6 shadow-xl max-h-[90vh] overflow-y-auto"
        role="dialog"
        aria-label={`${deployment.name} details`}
      >
        {/* Header */}
        <div className="flex items-start justify-between mb-6">
          <div className="flex items-center gap-4">
            <AppIcon entryId={catalogEntry?.id} size={48} />
            <div>
              <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100">
                {deployment.name}
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {catalogEntry?.name ?? 'Unknown application'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span
              className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${getStatusColor(deployment.status)}`}
            >
              {deployment.status}
            </span>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
              data-testid="modal-close-button"
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Status Section */}
        <div className="mb-6 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">
            <Clock size={16} className="text-blue-600 dark:text-blue-400" />
            Status Details
          </h3>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Installed Version</span>
              <p className="text-gray-900 dark:text-gray-100">{deployment.installedVersion ?? 'latest'}</p>
            </div>
            <div>
              <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Created</span>
              <p className="text-gray-900 dark:text-gray-100">{formatDate(deployment.createdAt)}</p>
            </div>
            {deployment.lastUpgradedAt && (
              <div>
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Last Upgraded</span>
                <p className="text-gray-900 dark:text-gray-100">{formatDate(deployment.lastUpgradedAt)}</p>
              </div>
            )}
            {deployment.domainName && (
              <div>
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Domain</span>
                <p className="text-gray-900 dark:text-gray-100">{deployment.domainName}</p>
              </div>
            )}
          </div>
        </div>

        {/* Components Section */}
        {components.length > 0 && (
          <div className="mb-6">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">
              <Server size={16} className="text-blue-600 dark:text-blue-400" />
              Components
            </h3>
            <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    <th className="px-3 py-2">Name</th>
                    <th className="px-3 py-2">Type</th>
                    <th className="px-3 py-2">Image</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {components.map((comp) => (
                    <tr key={comp.name ?? comp.image}>
                      <td className="px-3 py-2 font-medium text-gray-900 dark:text-gray-100">{comp.name ?? '-'}</td>
                      <td className="px-3 py-2">
                        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${typeBadgeColors[comp.type ?? ''] ?? typeBadgeColors.job}`}>
                          {comp.type ?? 'unknown'}
                        </span>
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-gray-500 dark:text-gray-400">{comp.image ?? '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Connection Details Section */}
        {hasCredentials && (
          <div className="mb-6" data-testid="connection-details-section">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">
              <KeyRound size={16} className="text-blue-600 dark:text-blue-400" />
              Connection Details
            </h3>
            <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-4 space-y-3">
              {credentialsLoading ? (
                <div className="flex items-center justify-center py-4">
                  <Loader2 size={20} className="animate-spin text-gray-400" />
                </div>
              ) : (
                <>
                  {/* Connection info fields */}
                  {credentialsResult?.connectionInfo && (
                    <div className="space-y-2">
                      {credentialsResult.connectionInfo.host && (
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-gray-500 dark:text-gray-400 w-32 shrink-0">Host</span>
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="font-mono text-xs text-gray-900 dark:text-gray-100 truncate">
                              {credentialsResult.connectionInfo.host}
                            </span>
                            <button
                              type="button"
                              onClick={() => copyToClipboard(credentialsResult.connectionInfo!.host!, 'host')}
                              className="shrink-0 rounded p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                              data-testid="copy-host"
                            >
                              {copiedKey === 'host' ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
                            </button>
                          </div>
                        </div>
                      )}
                      {credentialsResult.connectionInfo.port != null && (
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-gray-500 dark:text-gray-400 w-32 shrink-0">Port</span>
                          <span className="font-mono text-xs text-gray-900 dark:text-gray-100">
                            {credentialsResult.connectionInfo.port}
                          </span>
                        </div>
                      )}
                      {credentialsResult.connectionInfo.database && (
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-gray-500 dark:text-gray-400 w-32 shrink-0">Database</span>
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="font-mono text-xs text-gray-900 dark:text-gray-100 truncate">
                              {credentialsResult.connectionInfo.database}
                            </span>
                            <button
                              type="button"
                              onClick={() => copyToClipboard(credentialsResult.connectionInfo!.database!, 'database')}
                              className="shrink-0 rounded p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                              data-testid="copy-database"
                            >
                              {copiedKey === 'database' ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
                            </button>
                          </div>
                        </div>
                      )}
                      {credentialsResult.connectionInfo.username && (
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-gray-500 dark:text-gray-400 w-32 shrink-0">Username</span>
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="font-mono text-xs text-gray-900 dark:text-gray-100 truncate">
                              {credentialsResult.connectionInfo.username}
                            </span>
                            <button
                              type="button"
                              onClick={() => copyToClipboard(credentialsResult.connectionInfo!.username!, 'username')}
                              className="shrink-0 rounded p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                              data-testid="copy-username"
                            >
                              {copiedKey === 'username' ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Credential key/value rows */}
                  {Object.keys(credentialsResult?.credentials ?? {}).length > 0 && (
                    <div className="space-y-2 border-t border-gray-100 dark:border-gray-700 pt-3">
                      {Object.entries(credentialsResult!.credentials).map(([key, value]) => {
                        const isRevealed = revealedCredentials.has(key);
                        return (
                          <div key={key} className="flex items-center justify-between text-sm" data-testid={`credential-row-${key}`}>
                            <span className="text-gray-500 dark:text-gray-400 w-32 shrink-0">
                              {humanizeEnvVar(key)}
                            </span>
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span className="font-mono text-xs text-gray-900 dark:text-gray-100 truncate">
                                {isRevealed ? value : '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'}
                              </span>
                              <button
                                type="button"
                                onClick={() => toggleCredentialVisibility(key)}
                                className="shrink-0 rounded p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                                data-testid={`toggle-credential-${key}`}
                              >
                                {isRevealed ? <EyeOff size={14} /> : <Eye size={14} />}
                              </button>
                              <button
                                type="button"
                                onClick={() => copyToClipboard(value, key)}
                                className="shrink-0 rounded p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                                data-testid={`copy-credential-${key}`}
                              >
                                {copiedKey === key ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Connection URL */}
                  {credentialsResult?.connectionInfo && (() => {
                    const url = credentialsResult.connectionInfo.connectionUrl
                      ?? buildConnectionUrl(credentialsResult.connectionInfo);
                    if (!url) return null;
                    return (
                      <div className="border-t border-gray-100 dark:border-gray-700 pt-3">
                        <div className="flex items-center gap-2 text-sm mb-1">
                          <Link size={14} className="text-gray-400" />
                          <span className="text-gray-500 dark:text-gray-400">Connection URL</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <code className="flex-1 rounded bg-gray-50 dark:bg-gray-900 px-2 py-1.5 font-mono text-xs text-gray-700 dark:text-gray-300 truncate">
                            {url}
                          </code>
                          <button
                            type="button"
                            onClick={() => copyToClipboard(url, 'connection-url')}
                            className="shrink-0 rounded p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                            data-testid="copy-connection-url"
                          >
                            {copiedKey === 'connection-url' ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
                          </button>
                        </div>
                      </div>
                    );
                  })()}

                  {/* Regenerate Passwords button */}
                  {(credentialsResult?.generatedKeys?.length ?? 0) > 0 && (
                    <div className="border-t border-gray-100 dark:border-gray-700 pt-3">
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
                            Are you sure? Applications using these credentials will need to be updated.
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
                </>
              )}
            </div>
          </div>
        )}

        {/* Configuration Section */}
        <div className="mb-6">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">
            <Shield size={16} className="text-blue-600 dark:text-blue-400" />
            Configuration
          </h3>
          {configKeys.length > 0 ? (
            <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    <th className="px-3 py-2">Key</th>
                    <th className="px-3 py-2">Value</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {configKeys.map((key) => {
                    const isSecret = secretKeys.has(key);
                    const isRevealed = revealedSecrets.has(key);
                    const value = String(configuration[key] ?? '');
                    return (
                      <tr key={key}>
                        <td className="px-3 py-2 font-medium text-gray-900 dark:text-gray-100">{key}</td>
                        <td className="px-3 py-2 text-gray-600 dark:text-gray-400">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-xs">
                              {isSecret && !isRevealed ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' : value}
                            </span>
                            {isSecret && (
                              <button
                                type="button"
                                onClick={() => toggleSecret(key)}
                                className="rounded p-0.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                                data-testid={`toggle-secret-${key}`}
                              >
                                {isRevealed ? <EyeOff size={14} /> : <Eye size={14} />}
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-gray-500 dark:text-gray-400">No custom configuration</p>
          )}
        </div>

        {/* Resources Section */}
        <div className="mb-6">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">
            <Cpu size={16} className="text-blue-600 dark:text-blue-400" />
            Resources
          </h3>
          <div className="grid grid-cols-3 gap-4">
            <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-700/50 p-3 text-center">
              <Server size={16} className="mx-auto mb-1 text-gray-400" />
              <p className="text-xs text-gray-500 dark:text-gray-400">Replicas</p>
              <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">{deployment.replicaCount}</p>
            </div>
            <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-700/50 p-3 text-center">
              <Cpu size={16} className="mx-auto mb-1 text-gray-400" />
              <p className="text-xs text-gray-500 dark:text-gray-400">CPU</p>
              <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">{deployment.cpuRequest}</p>
            </div>
            <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-700/50 p-3 text-center">
              <HardDrive size={16} className="mx-auto mb-1 text-gray-400" />
              <p className="text-xs text-gray-500 dark:text-gray-400">Memory</p>
              <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">{deployment.memoryRequest}</p>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 border-t border-gray-200 dark:border-gray-700 pt-4">
          {isActionable && (
            <button
              type="button"
              onClick={() => {
                const newStatus = deployment.status === 'running' ? 'stopped' : 'running';
                onToggleStatus(deployment.id, newStatus);
              }}
              disabled={isToggling}
              className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                deployment.status === 'running'
                  ? 'bg-orange-50 text-orange-700 hover:bg-orange-100 dark:bg-orange-900/20 dark:text-orange-400 dark:hover:bg-orange-900/40'
                  : 'bg-green-50 text-green-700 hover:bg-green-100 dark:bg-green-900/20 dark:text-green-400 dark:hover:bg-green-900/40'
              }`}
              data-testid="modal-toggle-status"
            >
              {isToggling ? (
                <Loader2 size={16} className="animate-spin" />
              ) : deployment.status === 'running' ? (
                <Square size={16} />
              ) : (
                <Play size={16} />
              )}
              {deployment.status === 'running' ? 'Stop' : 'Start'}
            </button>
          )}
          {isTransitioning && (
            <span className="inline-flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
              <Loader2 size={16} className="animate-spin" />
              {deployment.status}...
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
            data-testid="modal-close-footer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
