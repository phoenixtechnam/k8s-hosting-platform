import { useState } from 'react';
import { X, Play, Square, Cpu, HardDrive, Server, Clock, Shield, Eye, EyeOff, AppWindow, Loader2, Database } from 'lucide-react';
import { getStatusColor } from '@/lib/status-colors';
import DatabaseManagementModal from './DatabaseManagementModal';
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
  const [dbModalOpen, setDbModalOpen] = useState(false);

  if (!open || !deployment) return null;

  const isDatabase = catalogEntry?.type === 'database';

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
          {isDatabase && (
            <button
              type="button"
              onClick={() => setDbModalOpen(true)}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600 transition-colors"
              data-testid="manage-database-button"
            >
              <Database size={16} />
              Manage Database
            </button>
          )}
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

      {/* Database Management Modal */}
      {isDatabase && (
        <DatabaseManagementModal
          open={dbModalOpen}
          deployment={deployment}
          catalogEntry={catalogEntry}
          clientId={clientId}
          onClose={() => setDbModalOpen(false)}
        />
      )}
    </div>
  );
}
