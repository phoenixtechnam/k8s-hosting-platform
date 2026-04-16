import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { API_BASE } from '@/lib/api-client';
import { X, Play, Square, Cpu, HardDrive, Server, Clock, Shield, Eye, EyeOff, AppWindow, Loader2, Database, AlertTriangle, Tag as TagIcon, Save, AlertCircle, Terminal, RefreshCw, Pencil } from 'lucide-react';
import { getStatusColor } from '@/lib/status-colors';
import { useUpdateDeploymentResources, useUpdateDeployment, useResourceAvailability, useDeploymentLiveMetrics } from '@/hooks/use-deployments';
import { useCatalogEntryVersions } from '@/hooks/use-catalog';
import clsx from 'clsx';
import DatabaseManagementModal from './DatabaseManagementModal';
import LogViewer from './LogViewer';
import WebTerminal from './WebTerminal';
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

interface VolumeEntry {
  readonly local_path?: string;
  readonly container_path?: string;
  readonly description?: string;
  readonly optional?: boolean;
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
  return `${API_BASE}/api/v1/catalog/${entryId}/icon`;
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
  readonly onRestart?: (id: string) => void;
}

export default function InstalledAppDetailModal({
  open,
  deployment,
  catalogEntry,
  clientId,
  onClose,
  onToggleStatus,
  isToggling,
  onRestart,
}: InstalledAppDetailModalProps) {
  const [revealedSecrets, setRevealedSecrets] = useState<Set<string>>(new Set());
  const [dbModalOpen, setDbModalOpen] = useState(false);
  const { data: versionsData } = useCatalogEntryVersions(catalogEntry?.id);

  // ─── Resource editing (Issue 7) ─────────────────────────────────────────────
  const [editingResources, setEditingResources] = useState(false);
  const [editCpu, setEditCpu] = useState('');
  const [editMemoryValue, setEditMemoryValue] = useState('');
  const [editMemoryUnit, setEditMemoryUnit] = useState<'Mi' | 'Gi'>('Mi');
  const queryClient = useQueryClient();
  // Derived: combine value + unit for submission
  const editMemory = `${editMemoryValue}${editMemoryUnit}`;
  const updateResources = useUpdateDeploymentResources(clientId);
  const availability = useResourceAvailability(clientId, editingResources ? deployment?.id : undefined);
  const avail = availability.data?.data;
  const [showLogs, setShowLogs] = useState(false);
  const [showTerminal, setShowTerminal] = useState(false);
  const liveMetrics = useDeploymentLiveMetrics(clientId, deployment?.status === 'running' ? deployment?.id : undefined);

  // ─── Configuration editing ────────────────────────────────────────────────
  const [editingConfig, setEditingConfig] = useState(false);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const updateDeployment = useUpdateDeployment(clientId);

  if (!open || !deployment) return null;

  const isDatabase = catalogEntry?.type === 'database';

  const components = parseJsonField<readonly ComponentEntry[]>(catalogEntry?.components) ?? (Array.isArray(catalogEntry?.components) ? catalogEntry.components as readonly ComponentEntry[] : []);

  const parameters = parseJsonField<readonly ParameterEntry[]>(catalogEntry?.parameters) ?? (Array.isArray(catalogEntry?.parameters) ? catalogEntry.parameters as readonly ParameterEntry[] : []);

  const volumes: readonly VolumeEntry[] = (() => {
    const raw = catalogEntry?.volumes;
    if (raw == null) return [];
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    return Array.isArray(raw) ? raw : [];
  })();

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

  // Derive configurable env var keys from catalog entry
  const configurableKeys = new Set<string>(
    (() => {
      const raw = catalogEntry?.envVars;
      if (raw == null) return [];
      const parsed = typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : raw;
      if (parsed && typeof parsed === 'object' && 'configurable' in parsed && Array.isArray((parsed as Record<string, unknown>).configurable)) {
        return (parsed as { configurable: string[] }).configurable;
      }
      return [];
    })(),
  );

  const enterConfigEdit = () => {
    const initial: Record<string, string> = {};
    for (const key of configKeys) {
      if (configurableKeys.has(key)) {
        initial[key] = String(configuration[key] ?? '');
      }
    }
    setEditValues(initial);
    setEditingConfig(true);
  };

  const saveConfigEdit = () => {
    const merged: Record<string, unknown> = { ...configuration, ...editValues };
    updateDeployment.mutate(
      { deploymentId: deployment.id, configuration: merged },
      {
        onSuccess: () => {
          setEditingConfig(false);
          queryClient.invalidateQueries({ queryKey: ['deployments'] });
          onRestart?.(deployment.id);
          onClose();
        },
      },
    );
  };

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

        {/* Last Error Banner */}
        {deployment.lastError && (
          <div
            className="mb-6 flex items-start gap-2 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-700 dark:text-red-400"
            data-testid="last-error-banner"
          >
            <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
            <span>Last error: {deployment.lastError}</span>
          </div>
        )}

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
            <div>
              <span className="text-xs font-medium text-gray-500 dark:text-gray-400">K8s Name</span>
              <p className="font-mono text-gray-900 dark:text-gray-100">{deployment.name}</p>
            </div>
            {deployment.storagePath && (
              <div>
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Storage Path</span>
                <p className="font-mono text-gray-900 dark:text-gray-100">{deployment.storagePath}</p>
              </div>
            )}
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

        {/* Supported Versions */}
        {(versionsData?.data ?? []).length > 0 && (
          <div className="mb-6">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">
              <TagIcon size={16} className="text-blue-600 dark:text-blue-400" />
              Supported Versions
            </h3>
            <div className="flex flex-wrap items-center gap-2">
              {(versionsData?.data ?? []).map(v => (
                <span
                  key={v.id}
                  className={clsx(
                    'inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm',
                    deployment.installedVersion === v.version
                      ? 'border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 font-medium'
                      : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400',
                  )}
                >
                  {v.version}
                  {v.isDefault ? <span className="text-[10px] font-medium text-blue-500 dark:text-blue-400">default</span> : null}
                  {deployment.installedVersion === v.version ? <span className="text-[10px] font-medium text-green-600 dark:text-green-400">installed</span> : null}
                </span>
              ))}
              {deployment.status === 'running' && onRestart && (
                <button
                  type="button"
                  onClick={() => { onRestart(deployment.id); onClose(); }}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-blue-300 dark:border-blue-600 bg-blue-50 dark:bg-blue-900/30 px-3 py-1.5 text-sm font-medium text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/50 transition-colors"
                  data-testid="pull-latest-restart"
                >
                  <RefreshCw size={14} />
                  Pull Latest
                </button>
              )}
            </div>
          </div>
        )}

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

        {/* Volumes Section (Issue 9: real K8s path) */}
        {volumes.length > 0 && (
          <div className="mb-6" data-testid="volumes-section">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">
              <HardDrive size={16} className="text-blue-600 dark:text-blue-400" />
              Volumes
            </h3>
            <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    <th className="px-3 py-2">K8s Path</th>
                    <th className="px-3 py-2">Container Path</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {(() => {
                    // Use volumePaths from the deployment response if available (computed by backend)
                    const deploymentVolumePaths = deployment.volumePaths;
                    if (deploymentVolumePaths && deploymentVolumePaths.length > 0) {
                      return deploymentVolumePaths.map((vp) => (
                        <tr key={vp.containerPath ?? vp.k8sPath}>
                          <td className="px-3 py-2 font-mono text-xs text-gray-900 dark:text-gray-100">{vp.k8sPath}</td>
                          <td className="px-3 py-2 font-mono text-xs text-gray-500 dark:text-gray-400">{vp.containerPath ?? '-'}</td>
                        </tr>
                      ));
                    }
                    // Fallback: compute K8s path from catalog volumes + deployment name
                    return volumes.map((vol) => {
                      const parentDir = vol.local_path?.split('/').slice(0, -1).join('/') ?? '';
                      const k8sPath = parentDir ? `${parentDir}/${deployment.name}` : (vol.local_path ?? deployment.name);
                      return (
                        <tr key={vol.container_path ?? vol.local_path}>
                          <td className="px-3 py-2 font-mono text-xs text-gray-900 dark:text-gray-100">{k8sPath}</td>
                          <td className="px-3 py-2 font-mono text-xs text-gray-500 dark:text-gray-400">{vol.container_path ?? '-'}</td>
                        </tr>
                      );
                    });
                  })()}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Configuration Section */}
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-3">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
              <Shield size={16} className="text-blue-600 dark:text-blue-400" />
              Configuration
            </h3>
            {!editingConfig && configurableKeys.size > 0 && configKeys.length > 0 && (
              <button
                type="button"
                onClick={enterConfigEdit}
                className="inline-flex items-center gap-1 rounded-md border border-blue-300 dark:border-blue-600 px-2 py-0.5 text-xs font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20"
                data-testid="edit-config-button"
              >
                <Pencil size={12} />
                Edit
              </button>
            )}
          </div>
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
                    const isConfigurable = configurableKeys.has(key);
                    const value = String(configuration[key] ?? '');
                    return (
                      <tr key={key}>
                        <td className="px-3 py-2 font-medium text-gray-900 dark:text-gray-100">{key}</td>
                        <td className="px-3 py-2 text-gray-600 dark:text-gray-400">
                          {editingConfig && isConfigurable && !isSecret ? (
                            <input
                              type="text"
                              value={editValues[key] ?? ''}
                              onChange={(e) => setEditValues({ ...editValues, [key]: e.target.value })}
                              className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-2 py-1 font-mono text-xs text-gray-900 dark:text-gray-100 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                              data-testid={`edit-config-${key}`}
                            />
                          ) : (
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
                          )}
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
          {editingConfig && (
            <div className="mt-3 space-y-3">
              <div className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span>Saving will restart the deployment to apply changes. The application will be briefly unavailable.</span>
              </div>
              <div className="flex gap-2">
              <button
                type="button"
                onClick={saveConfigEdit}
                disabled={updateDeployment.isPending}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="save-config-button"
              >
                {updateDeployment.isPending ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                Apply Changes
              </button>
              <button
                type="button"
                onClick={() => { setEditingConfig(false); updateDeployment.reset(); }}
                className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
                data-testid="cancel-config-button"
              >
                Cancel
              </button>
              </div>
            </div>
          )}
          {updateDeployment.isError && editingConfig && (
            <p className="mt-2 text-xs text-red-600 dark:text-red-400">
              {updateDeployment.error instanceof Error ? updateDeployment.error.message : 'Failed to update configuration'}
            </p>
          )}
          {secretKeys.size > 0 && (
            <p className="mt-3 text-xs text-gray-500 dark:text-gray-400" data-testid="credentials-readonly-note">
              Set at deployment time. Change passwords inside the application if needed.
            </p>
          )}
        </div>

        {/* Resources Section (Issue 7: editable) */}
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-3">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
              <Cpu size={16} className="text-blue-600 dark:text-blue-400" />
              Assigned Resources
            </h3>
            {!editingResources && (
              <button
                type="button"
                onClick={() => {
                  setEditCpu(deployment.cpuRequest);
                  // Parse "256Mi" or "1Gi" into value + unit
                  const mem = deployment.memoryRequest;
                  if (mem.endsWith('Gi')) { setEditMemoryValue(mem.slice(0, -2)); setEditMemoryUnit('Gi'); }
                  else if (mem.endsWith('Mi')) { setEditMemoryValue(mem.slice(0, -2)); setEditMemoryUnit('Mi'); }
                  else { setEditMemoryValue(mem); setEditMemoryUnit('Mi'); }
                  setEditingResources(true);
                }}
                className="rounded-md border border-blue-300 dark:border-blue-600 px-2 py-0.5 text-xs font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20"
                data-testid="edit-resources-button"
              >
                Edit
              </button>
            )}
          </div>
          {editingResources ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">CPU Request</label>
                  <input
                    type="text"
                    value={editCpu}
                    onChange={(e) => setEditCpu(e.target.value)}
                    className="w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    data-testid="edit-cpu-input"
                  />
                  {avail && (
                    <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                      Min: {avail.cpu.min} &middot; Max: {avail.cpu.max} cores
                    </p>
                  )}
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Memory Request</label>
                  <div className="flex gap-1">
                    <input
                      type="number"
                      min="1"
                      value={editMemoryValue}
                      onChange={(e) => setEditMemoryValue(e.target.value)}
                      className="flex-1 rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                      data-testid="edit-memory-input"
                    />
                    <select
                      value={editMemoryUnit}
                      onChange={(e) => setEditMemoryUnit(e.target.value as 'Mi' | 'Gi')}
                      className="rounded-lg border border-gray-300 dark:border-gray-600 px-2 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 focus:border-blue-500 focus:outline-none"
                      data-testid="edit-memory-unit"
                    >
                      <option value="Mi">MB</option>
                      <option value="Gi">GB</option>
                    </select>
                  </div>
                  {avail && (
                    <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                      Min: {avail.memory.min} &middot; Max: {avail.memory.max}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                <AlertCircle size={12} className="shrink-0" />
                <span>Applying changes will restart the deployment</span>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    updateResources.mutate(
                      { deploymentId: deployment.id, cpu_request: editCpu, memory_request: editMemory },
                      {
                        onSuccess: () => {
                          setEditingResources(false);
                          queryClient.invalidateQueries({ queryKey: ['deployments'] });
                          onClose();
                        },
                      },
                    );
                  }}
                  disabled={updateResources.isPending || (editCpu === deployment.cpuRequest && editMemory === deployment.memoryRequest)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  data-testid="apply-resources-button"
                >
                  {updateResources.isPending ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                  Apply Changes
                </button>
                <button
                  type="button"
                  onClick={() => setEditingResources(false)}
                  className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
                >
                  Cancel
                </button>
              </div>
              {updateResources.isError && (
                <p className="text-xs text-red-600 dark:text-red-400">
                  {updateResources.error instanceof Error ? updateResources.error.message : 'Failed to update resources'}
                </p>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              <DetailMetricCard
                icon={<Cpu size={16} className="mx-auto mb-1 text-gray-400" />}
                label="CPU"
                request={deployment.cpuRequest}
                used={liveMetrics.data?.data?.cpuUsed}
                type="cpu"
              />
              <DetailMetricCard
                icon={<HardDrive size={16} className="mx-auto mb-1 text-gray-400" />}
                label="Memory"
                request={deployment.memoryRequest}
                used={liveMetrics.data?.data?.memoryUsedMi}
                type="memory"
              />
              {liveMetrics.data?.data?.storageUsedBytes != null && liveMetrics.data.data.storageUsedBytes > 0 && (() => {
                const usedGb = liveMetrics.data.data.storageUsedBytes / (1024 * 1024 * 1024);
                const pct = Math.min((usedGb / 10) * 100, 100);
                const barColor = pct >= 80 ? 'bg-red-500' : pct >= 50 ? 'bg-amber-500' : 'bg-green-500';
                return (
                  <div className="col-span-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-700/50 p-3 text-center">
                    <HardDrive size={16} className="mx-auto mb-1 text-gray-400" />
                    <p className="text-xs text-gray-500 dark:text-gray-400">Disk Usage</p>
                    <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">{liveMetrics.data.data.storageUsedFormatted}</p>
                    <div className="mt-1.5 h-1.5 w-full rounded-full bg-gray-200 dark:bg-gray-600 overflow-hidden">
                      <div className={clsx('h-full rounded-full transition-all', barColor)} style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
        </div>

        {/* Unified Logs (static snapshot default, with Stream Live toggle) */}
        {showLogs && deployment && (
          <div className="mb-6">
            <div className="flex items-center justify-between mb-2">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
                <Terminal size={16} className="text-gray-600 dark:text-gray-400" />
                Logs
              </h3>
              <button
                type="button"
                onClick={() => setShowLogs(false)}
                className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
              >
                Hide
              </button>
            </div>
            <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden h-80">
              <LogViewer deploymentId={deployment.id} />
            </div>
          </div>
        )}

        {/* Web Terminal */}
        {showTerminal && deployment && (
          <div className="mb-6">
            <div className="flex items-center justify-between mb-2">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
                <Terminal size={16} className="text-gray-600 dark:text-gray-400" />
                Terminal
              </h3>
              <button
                type="button"
                onClick={() => setShowTerminal(false)}
                className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
              >
                Hide
              </button>
            </div>
            <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden h-80">
              <WebTerminal deploymentId={deployment.id} />
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 border-t border-gray-200 dark:border-gray-700 pt-4">
          <button
            type="button"
            onClick={() => setShowLogs(!showLogs)}
            className={clsx(
              'inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-colors',
              showLogs
                ? 'border-brand-500 text-brand-600 dark:text-brand-400 bg-brand-50 dark:bg-brand-900/20'
                : 'border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50'
            )}
            data-testid="logs-button"
          >
            <Terminal size={16} />
            Logs
          </button>
          <button
            type="button"
            onClick={() => setShowTerminal(!showTerminal)}
            className={clsx(
              'inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-colors',
              showTerminal
                ? 'border-brand-500 text-brand-600 dark:text-brand-400 bg-brand-50 dark:bg-brand-900/20'
                : 'border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50'
            )}
            data-testid="terminal-button"
          >
            <Terminal size={16} />
            Terminal
          </button>
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

function DetailMetricCard({
  icon,
  label,
  request,
  used,
  type,
}: {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly request: string;
  readonly used: number | undefined;
  readonly type: 'cpu' | 'memory';
}) {
  let requestNum = 0;
  const usedNum = used ?? 0;
  let usedLabel = '';

  if (type === 'cpu') {
    requestNum = request.endsWith('m') ? parseFloat(request) / 1000 : parseFloat(request) || 0;
    usedLabel = used != null ? `${(usedNum * 1000).toFixed(0)}m used` : '';
  } else {
    if (request.endsWith('Gi')) requestNum = parseFloat(request) * 1024;
    else if (request.endsWith('Mi')) requestNum = parseFloat(request);
    else requestNum = parseFloat(request) || 0;
    usedLabel = used != null ? `${Math.round(usedNum)}Mi used` : '';
  }

  const ratio = requestNum > 0 ? (type === 'cpu' ? usedNum / requestNum : usedNum / requestNum) : 0;
  const pct = Math.min(ratio * 100, 100);
  const barColor = pct >= 80 ? 'bg-red-500' : pct >= 50 ? 'bg-amber-500' : 'bg-green-500';

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-700/50 p-3 text-center">
      {icon}
      <p className="text-xs text-gray-500 dark:text-gray-400">{label}</p>
      <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">{request}</p>
      {used != null && (
        <>
          <div className="mt-1.5 h-1.5 w-full rounded-full bg-gray-200 dark:bg-gray-600 overflow-hidden">
            <div className={clsx('h-full rounded-full transition-all', barColor)} style={{ width: `${pct}%` }} />
          </div>
          <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5">{usedLabel}</p>
        </>
      )}
    </div>
  );
}
