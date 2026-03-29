import { useState, useMemo, useCallback, type FormEvent } from 'react';
import { Server, Container, Rocket, Search, Loader2, AlertCircle, RefreshCw, Plus, Trash2, X, Play, Square, Heart, Settings2, Network, Cpu } from 'lucide-react';
import clsx from 'clsx';
import StatCard from '@/components/ui/StatCard';
import StatusBadge from '@/components/ui/StatusBadge';
import SearchableClientSelect from '@/components/ui/SearchableClientSelect';
import WorkloadRepoSettings from '@/components/WorkloadRepoSettings';
import { useContainerImages } from '@/hooks/use-container-images';
import { useWorkloadRepos, useSyncWorkloadRepo } from '@/hooks/use-workload-repos';
import { useWorkloads, useCreateWorkload, useUpdateWorkload, useDeleteWorkload } from '@/hooks/use-workloads';

type Tab = 'deployed' | 'available' | 'repos';

const TABS: readonly { readonly id: Tab; readonly label: string }[] = [
  { id: 'deployed', label: 'Deployed Workloads' },
  { id: 'available', label: 'Available Workloads' },
  { id: 'repos', label: 'Repositories' },
] as const;

export default function Workloads() {
  const [activeTab, setActiveTab] = useState<Tab>('deployed');

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Server size={28} className="text-brand-500" />
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Workloads</h1>
      </div>

      <div className="border-b border-gray-200 dark:border-gray-700">
        <nav className="-mb-px flex gap-6" data-testid="tab-bar">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={clsx(
                'whitespace-nowrap border-b-2 px-1 py-3 text-sm font-medium transition-colors',
                activeTab === tab.id
                  ? 'border-brand-500 text-brand-600 dark:text-brand-400'
                  : 'border-transparent text-gray-500 hover:border-gray-300 dark:hover:border-gray-600 hover:text-gray-700 dark:hover:text-gray-300',
              )}
              data-testid={`tab-${tab.id}`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {activeTab === 'deployed' && <DeployedWorkloadsTab />}
      {activeTab === 'available' && <AvailableWorkloadsTab />}
      {activeTab === 'repos' && <RepositoriesTab />}
    </div>
  );
}

function DeployedWorkloadsTab() {
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
  const { data: response, isLoading, isError, error } = useWorkloads(selectedClientId ?? undefined);
  const createWorkload = useCreateWorkload(selectedClientId ?? undefined);
  const updateWorkload = useUpdateWorkload(selectedClientId ?? undefined);
  const deleteWorkload = useDeleteWorkload(selectedClientId ?? undefined);
  const { data: imagesResponse } = useContainerImages();

  const workloads = response?.data ?? [];
  const images = imagesResponse?.data ?? [];

  const [showDeploy, setShowDeploy] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deployForm, setDeployForm] = useState({
    name: '',
    image_id: '',
    replica_count: '1',
    cpu_request: '0.25',
    memory_request: '256Mi',
  });

  const handleDeploy = async (e: FormEvent) => {
    e.preventDefault();
    if (!deployForm.name.trim() || !deployForm.image_id) return;
    try {
      await createWorkload.mutateAsync({
        name: deployForm.name.trim(),
        image_id: deployForm.image_id,
        replica_count: Number(deployForm.replica_count) || 1,
        cpu_request: deployForm.cpu_request || '0.25',
        memory_request: deployForm.memory_request || '256Mi',
      });
      setDeployForm({ name: '', image_id: '', replica_count: '1', cpu_request: '0.25', memory_request: '256Mi' });
      setShowDeploy(false);
    } catch { /* error via createWorkload.error */ }
  };

  const handleDelete = async (id: string) => {
    try { await deleteWorkload.mutateAsync(id); setDeleteConfirmId(null); }
    catch { /* error via deleteWorkload.error */ }
  };

  const handleToggleStatus = (id: string, currentStatus: string) => {
    const newStatus = currentStatus === 'running' ? 'stopped' : 'running';
    updateWorkload.mutate({ workloadId: id, status: newStatus as 'running' | 'stopped' });
  };

  return (
    <div className="space-y-4" data-testid="deployed-tab">
      <div className="flex items-center gap-3">
        <SearchableClientSelect
          selectedClientId={selectedClientId}
          onSelect={setSelectedClientId}
          placeholder="Search clients..."
        />
        {selectedClientId && (
          <button
            type="button"
            onClick={() => setShowDeploy((p) => !p)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-2 text-sm font-medium text-white hover:bg-brand-600"
            data-testid="deploy-workload-button"
          >
            {showDeploy ? <X size={14} /> : <Plus size={14} />}
            {showDeploy ? 'Cancel' : 'Deploy Workload'}
          </button>
        )}
      </div>

      {showDeploy && selectedClientId && (
        <form onSubmit={handleDeploy} className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-4" data-testid="deploy-form">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-5">
            <div>
              <label htmlFor="wl-name" className="block text-xs font-medium text-gray-700 dark:text-gray-300">Name</label>
              <input id="wl-name" type="text" className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm dark:bg-gray-700 dark:text-gray-100" placeholder="my-app" value={deployForm.name} onChange={(e) => setDeployForm({ ...deployForm, name: e.target.value })} required data-testid="deploy-name-input" />
            </div>
            <div>
              <label htmlFor="wl-image" className="block text-xs font-medium text-gray-700 dark:text-gray-300">Image</label>
              <select id="wl-image" className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm dark:bg-gray-700 dark:text-gray-100" value={deployForm.image_id} onChange={(e) => setDeployForm({ ...deployForm, image_id: e.target.value })} required data-testid="deploy-image-select">
                <option value="">Select image...</option>
                {images.map((img) => <option key={img.id} value={img.id}>{img.name}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="wl-replicas" className="block text-xs font-medium text-gray-700 dark:text-gray-300">Replicas</label>
              <input id="wl-replicas" type="number" min={1} max={10} className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm dark:bg-gray-700 dark:text-gray-100" value={deployForm.replica_count} onChange={(e) => setDeployForm({ ...deployForm, replica_count: e.target.value })} data-testid="deploy-replicas-input" />
            </div>
            <div>
              <label htmlFor="wl-cpu" className="block text-xs font-medium text-gray-700 dark:text-gray-300">CPU</label>
              <input id="wl-cpu" type="text" className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm dark:bg-gray-700 dark:text-gray-100" value={deployForm.cpu_request} onChange={(e) => setDeployForm({ ...deployForm, cpu_request: e.target.value })} data-testid="deploy-cpu-input" />
            </div>
            <div className="flex items-end">
              <button type="submit" disabled={createWorkload.isPending} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50" data-testid="submit-deploy">
                {createWorkload.isPending && <Loader2 size={14} className="animate-spin" />}
                Deploy
              </button>
            </div>
          </div>
          {createWorkload.error && (
            <div className="mt-3 flex items-center gap-2 text-sm text-red-600 dark:text-red-400" data-testid="deploy-error">
              <AlertCircle size={14} />
              {createWorkload.error instanceof Error ? createWorkload.error.message : 'Failed to deploy'}
            </div>
          )}
        </form>
      )}

      {!selectedClientId && (
        <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 px-5 py-10 text-center text-sm text-gray-500 dark:text-gray-400" data-testid="select-client-prompt">
          Select a client to view their deployed workloads.
        </div>
      )}

      {selectedClientId && isLoading && (
        <div className="flex items-center justify-center py-12" data-testid="loading-spinner">
          <Loader2 size={24} className="animate-spin text-brand-500" />
          <span className="ml-2 text-sm text-gray-500 dark:text-gray-400">Loading workloads...</span>
        </div>
      )}

      {selectedClientId && isError && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-700 dark:text-red-400" data-testid="error-message">
          <AlertCircle size={16} />
          <span>Failed to load workloads: {error?.message ?? 'Unknown error'}</span>
        </div>
      )}

      {selectedClientId && !isLoading && !isError && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full" data-testid="workloads-table">
              <thead>
                <tr className="border-b border-gray-100 dark:border-gray-700 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  <th className="px-5 py-3">Name</th>
                  <th className="px-5 py-3">Image</th>
                  <th className="px-5 py-3">Status</th>
                  <th className="px-5 py-3">Replicas</th>
                  <th className="hidden px-5 py-3 md:table-cell">CPU</th>
                  <th className="hidden px-5 py-3 md:table-cell">Memory</th>
                  <th className="px-5 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {workloads.map((workload) => (
                  <tr key={workload.id} className="transition-colors hover:bg-gray-50 dark:hover:bg-gray-700/50">
                    <td className="px-5 py-3.5 font-medium text-gray-900 dark:text-gray-100">{workload.name}</td>
                    <td className="px-5 py-3.5 text-sm text-gray-600 dark:text-gray-400">{workload.containerImageId ?? '—'}</td>
                    <td className="px-5 py-3.5">
                      <StatusBadge status={workload.status} />
                    </td>
                    <td className="px-5 py-3.5 text-sm text-gray-600 dark:text-gray-400">{workload.replicaCount}</td>
                    <td className="hidden px-5 py-3.5 text-sm text-gray-600 dark:text-gray-400 md:table-cell">{workload.cpuRequest}</td>
                    <td className="hidden px-5 py-3.5 text-sm text-gray-600 dark:text-gray-400 md:table-cell">{workload.memoryRequest}</td>
                    <td className="px-5 py-3.5 text-right">
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => handleToggleStatus(workload.id, workload.status)}
                          disabled={workload.status === 'pending' || workload.status === 'failed'}
                          className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1.5 text-xs text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 disabled:opacity-50"
                          title={workload.status === 'running' ? 'Stop' : 'Start'}
                          data-testid={`toggle-workload-${workload.id}`}
                        >
                          {workload.status === 'running' ? <Square size={12} /> : <Play size={12} />}
                        </button>
                        {deleteConfirmId === workload.id ? (
                          <>
                            <button type="button" onClick={() => handleDelete(workload.id)} disabled={deleteWorkload.isPending} className="rounded-md bg-red-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50" data-testid={`confirm-delete-wl-${workload.id}`}>Confirm</button>
                            <button type="button" onClick={() => setDeleteConfirmId(null)} className="rounded-md border border-gray-200 dark:border-gray-700 px-2.5 py-1.5 text-xs text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50">Cancel</button>
                          </>
                        ) : (
                          <button type="button" onClick={() => setDeleteConfirmId(workload.id)} className="rounded-md border border-red-200 dark:border-red-800 bg-white dark:bg-gray-800 px-2 py-1.5 text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20" data-testid={`delete-workload-${workload.id}`}>
                            <Trash2 size={12} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {workloads.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-5 py-10 text-center text-sm text-gray-500 dark:text-gray-400">
                      No deployed workloads for this client.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="border-t border-gray-100 dark:border-gray-700 px-5 py-3 text-sm text-gray-500 dark:text-gray-400">
            {workloads.length} workload{workloads.length !== 1 ? 's' : ''}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Workload Detail Helpers ─────────────────────────────────────────────────

interface HealthCheckData {
  readonly path?: string;
  readonly command?: string;
  readonly port?: number;
  readonly initial_delay_seconds?: number;
  readonly period_seconds?: number;
}

interface ServiceRequirement {
  readonly engine?: string;
  readonly minVersion?: string;
  readonly envMapping?: Record<string, string>;
}

function safeJsonParse<T>(val: unknown): T | undefined {
  if (val == null) return undefined;
  if (typeof val === 'object') return val as T;
  if (typeof val === 'string') {
    try { return JSON.parse(val) as T; } catch { return undefined; }
  }
  return undefined;
}

function safeJsonParseArray(val: unknown): readonly string[] | undefined {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    try { const parsed = JSON.parse(val); return Array.isArray(parsed) ? parsed : undefined; } catch { return undefined; }
  }
  return undefined;
}

function SectionHeading({ icon: Icon, title }: { readonly icon: React.ElementType; readonly title: string }) {
  return (
    <h4 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">
      <Icon size={16} className="text-brand-500" />
      {title}
    </h4>
  );
}

// ─── Workload Detail Panel ──────────────────────────────────────────────────

function WorkloadDetailPanel({
  image,
  onClose,
}: {
  readonly image: Record<string, unknown>;
  readonly onClose: () => void;
}) {
  const name = image.name as string;
  const version = image.version as string | undefined;
  const imageType = image.imageType as string;
  const description = image.description as string | undefined;

  // Deployment info
  const runtime = image.runtime as string | undefined;
  const webServer = image.webServer as string | undefined;
  const deploymentStrategy = image.deploymentStrategy as string | undefined;
  const containerPort = image.containerPort as number | string | undefined;
  const mountPath = image.mountPath as string | undefined;
  const minPlan = image.minPlan as string | undefined;

  // Resources
  const resourceCpu = image.resourceCpu as string | undefined;
  const resourceMemory = image.resourceMemory as string | undefined;
  const resourceStorage = image.resourceStorage as string | undefined;

  // Health check
  const healthCheck = safeJsonParse<HealthCheckData>(image.healthCheck);

  // Environment variables
  const envVars = safeJsonParse<readonly Record<string, unknown>[]>(image.envVars) ?? safeJsonParseArray(image.envVars);
  const configurableEnvVars: string[] = [];
  const fixedEnvVars: Array<{ key: string; value: string }> = [];

  if (Array.isArray(envVars)) {
    for (const v of envVars) {
      if (typeof v === 'string') {
        configurableEnvVars.push(v);
      } else if (v && typeof v === 'object') {
        const entries = Object.entries(v as Record<string, unknown>);
        for (const [key, value] of entries) {
          if (value != null && String(value).length > 0) {
            fixedEnvVars.push({ key, value: String(value) });
          } else {
            configurableEnvVars.push(key);
          }
        }
      }
    }
  }

  // Tags
  const tags = safeJsonParseArray(image.tags) ?? [];

  // Services
  const services = safeJsonParse<readonly ServiceRequirement[]>(image.services);

  // Provides
  const provides = safeJsonParse<Record<string, unknown>>(image.provides);

  const typeBadgeColor = imageType === 'runtime'
    ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300'
    : imageType === 'database'
      ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300'
      : 'bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300';

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4" data-testid="workload-detail-panel">
      <div
        className="relative my-8 w-full max-w-3xl rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-xl"
        role="dialog"
        aria-label={`${name} details`}
      >
        {/* Close button */}
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 rounded-md p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          data-testid="detail-close-button"
        >
          <X size={20} />
        </button>

        <div className="p-6 space-y-6">
          {/* Header */}
          <div>
            <div className="flex items-start justify-between pr-8">
              <div>
                <h3 className="text-xl font-bold text-gray-900 dark:text-gray-100">{name}</h3>
                {version && <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">v{version}</p>}
              </div>
              <span className={clsx('inline-flex rounded-full px-3 py-1 text-xs font-medium', typeBadgeColor)}>
                {imageType}
              </span>
            </div>
            {description && <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{description}</p>}
          </div>

          {/* Deployment Info */}
          <div>
            <SectionHeading icon={Server} title="Deployment Info" />
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 rounded-lg border border-gray-200 dark:border-gray-700 p-3">
              <div><span className="text-xs font-medium text-gray-500 dark:text-gray-400">Runtime</span><p className="text-sm text-gray-900 dark:text-gray-100">{runtime ?? '-'}</p></div>
              <div><span className="text-xs font-medium text-gray-500 dark:text-gray-400">Web Server</span><p className="text-sm text-gray-900 dark:text-gray-100">{webServer ?? '-'}</p></div>
              <div><span className="text-xs font-medium text-gray-500 dark:text-gray-400">Deployment Strategy</span><p className="text-sm text-gray-900 dark:text-gray-100">{deploymentStrategy ?? '-'}</p></div>
              <div><span className="text-xs font-medium text-gray-500 dark:text-gray-400">Container Port</span><p className="text-sm text-gray-900 dark:text-gray-100">{containerPort ?? '-'}</p></div>
              <div><span className="text-xs font-medium text-gray-500 dark:text-gray-400">Mount Path</span><p className="text-sm font-mono text-gray-900 dark:text-gray-100">{mountPath ?? '-'}</p></div>
              <div><span className="text-xs font-medium text-gray-500 dark:text-gray-400">Min Plan</span><p className="text-sm text-gray-900 dark:text-gray-100">{minPlan ?? 'Any'}</p></div>
            </div>
          </div>

          {/* Resources */}
          {(resourceCpu ?? resourceMemory ?? resourceStorage) && (
            <div>
              <SectionHeading icon={Cpu} title="Resources" />
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 rounded-lg border border-gray-200 dark:border-gray-700 p-3">
                <div><span className="text-xs font-medium text-gray-500 dark:text-gray-400">CPU</span><p className="text-sm text-gray-900 dark:text-gray-100">{resourceCpu ?? 'Default'}</p></div>
                <div><span className="text-xs font-medium text-gray-500 dark:text-gray-400">Memory</span><p className="text-sm text-gray-900 dark:text-gray-100">{resourceMemory ?? 'Default'}</p></div>
                {resourceStorage && (
                  <div><span className="text-xs font-medium text-gray-500 dark:text-gray-400">Storage</span><p className="text-sm text-gray-900 dark:text-gray-100">{resourceStorage}</p></div>
                )}
              </div>
            </div>
          )}

          {/* Health Check */}
          {healthCheck && (healthCheck.path ?? healthCheck.command) && (
            <div>
              <SectionHeading icon={Heart} title="Health Check" />
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 rounded-lg border border-gray-200 dark:border-gray-700 p-3">
                <div>
                  <span className="text-xs font-medium text-gray-500 dark:text-gray-400">{healthCheck.path ? 'Path' : 'Command'}</span>
                  <p className="text-sm font-mono text-gray-900 dark:text-gray-100">{healthCheck.path ?? healthCheck.command}</p>
                </div>
                <div><span className="text-xs font-medium text-gray-500 dark:text-gray-400">Port</span><p className="text-sm text-gray-900 dark:text-gray-100">{healthCheck.port ?? '-'}</p></div>
                <div><span className="text-xs font-medium text-gray-500 dark:text-gray-400">Initial Delay</span><p className="text-sm text-gray-900 dark:text-gray-100">{healthCheck.initial_delay_seconds != null ? `${healthCheck.initial_delay_seconds}s` : '-'}</p></div>
                <div><span className="text-xs font-medium text-gray-500 dark:text-gray-400">Period</span><p className="text-sm text-gray-900 dark:text-gray-100">{healthCheck.period_seconds != null ? `${healthCheck.period_seconds}s` : '-'}</p></div>
              </div>
            </div>
          )}

          {/* Environment Variables */}
          {(configurableEnvVars.length > 0 || fixedEnvVars.length > 0) && (
            <div>
              <SectionHeading icon={Settings2} title="Environment Variables" />
              <div className="space-y-3">
                {configurableEnvVars.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Configurable</p>
                    <div className="flex flex-wrap gap-1">
                      {configurableEnvVars.map((v) => (
                        <span key={v} className="rounded bg-gray-200 dark:bg-gray-600 px-2 py-0.5 text-xs font-mono text-gray-700 dark:text-gray-300">{v}</span>
                      ))}
                    </div>
                  </div>
                )}
                {fixedEnvVars.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Fixed</p>
                    <div className="flex flex-wrap gap-1">
                      {fixedEnvVars.map((v) => (
                        <span key={v.key} className="rounded bg-gray-200 dark:bg-gray-600 px-2 py-0.5 text-xs font-mono text-gray-700 dark:text-gray-300">{v.key}={v.value}</span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Services */}
          {Array.isArray(services) && services.length > 0 && (
            <div>
              <SectionHeading icon={Network} title="Services" />
              <div className="space-y-2">
                {services.map((svc, i) => (
                  <div key={i} className="rounded-lg border border-gray-200 dark:border-gray-700 p-3">
                    <div className="flex items-center gap-3 text-sm">
                      <span className="font-medium text-gray-900 dark:text-gray-100">{svc.engine ?? 'Unknown'}</span>
                      {svc.minVersion && <span className="text-gray-500 dark:text-gray-400">min v{svc.minVersion}</span>}
                    </div>
                    {svc.envMapping && Object.keys(svc.envMapping).length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {Object.entries(svc.envMapping).map(([key, val]) => (
                          <span key={key} className="rounded bg-gray-100 dark:bg-gray-700 px-2 py-0.5 text-xs font-mono text-gray-600 dark:text-gray-400">{key}={String(val)}</span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Provides */}
          {provides && Object.keys(provides).length > 0 && (
            <div>
              <SectionHeading icon={Server} title="Provides" />
              <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-3">
                <div className="grid grid-cols-2 gap-3 text-sm">
                  {Object.entries(provides).map(([key, val]) => (
                    <div key={key}>
                      <span className="text-xs font-medium text-gray-500 dark:text-gray-400">{key}</span>
                      <p className="text-gray-900 dark:text-gray-100">{typeof val === 'object' ? JSON.stringify(val) : String(val ?? '-')}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Tags */}
          {tags.length > 0 && (
            <div>
              <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Tags</span>
              <div className="mt-1 flex flex-wrap gap-1">
                {tags.map((tag) => (
                  <span key={tag} className="inline-flex rounded-full bg-gray-100 dark:bg-gray-700 px-2.5 py-0.5 text-xs text-gray-600 dark:text-gray-400">{tag}</span>
                ))}
              </div>
            </div>
          )}

          {/* Footer */}
          <div className="flex items-center justify-end gap-3 border-t border-gray-200 dark:border-gray-700 pt-4">
            <button
              type="button"
              disabled
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white opacity-50 cursor-not-allowed"
              data-testid="deploy-button"
            >
              Deploy (Phase 2)
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
              data-testid="close-button"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Available Workloads Tab ────────────────────────────────────────────────

function AvailableWorkloadsTab() {
  const [search, setSearch] = useState('');
  const [repoFilter, setRepoFilter] = useState('');
  const [isSyncingAll, setIsSyncingAll] = useState(false);
  const [selectedImage, setSelectedImage] = useState<Record<string, unknown> | null>(null);
  const { data: response, isLoading, isError, error } = useContainerImages();
  const { data: reposResponse } = useWorkloadRepos();
  const syncRepo = useSyncWorkloadRepo();

  const images = response?.data ?? [];
  const repos = reposResponse?.data ?? [];

  const repoMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const repo of repos) {
      map.set(repo.id, repo.name);
    }
    return map;
  }, [repos]);

  const handleSyncAll = async () => {
    setIsSyncingAll(true);
    try {
      await Promise.allSettled(repos.map((repo) => syncRepo.mutateAsync(repo.id)));
    } finally {
      setIsSyncingAll(false);
    }
  };

  const handleRowClick = useCallback((image: Record<string, unknown>) => {
    setSelectedImage(image);
  }, []);

  const handleClose = useCallback(() => {
    setSelectedImage(null);
  }, []);

  const filteredImages = useMemo(() => {
    let result = images;

    if (search.trim()) {
      const term = search.toLowerCase();
      result = result.filter(
        (img) =>
          img.name.toLowerCase().includes(term) ||
          img.code.toLowerCase().includes(term),
      );
    }

    if (repoFilter) {
      result = result.filter((img) => {
        const imageRecord = img as unknown as Record<string, unknown>;
        const sourceRepoId = (imageRecord.sourceRepoId ?? imageRecord.source_repo_id) as string | undefined;
        return sourceRepoId === repoFilter;
      });
    }

    return result;
  }, [search, repoFilter, images]);

  return (
    <div className="space-y-4" data-testid="available-tab">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard title="Total Images" value={images.length} icon={Container} accent="brand" />
        <StatCard title="Active Workloads" value={12} icon={Server} accent="green" />
        <StatCard title="Deployments Today" value={3} icon={Rocket} accent="amber" />
      </div>

      <div className="flex items-center gap-3">
        <div className="relative max-w-sm flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="search"
            placeholder="Search images..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 py-2 pl-9 pr-4 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            data-testid="image-search"
          />
        </div>
        {repos.length > 0 && (
          <select
            value={repoFilter}
            onChange={(e) => setRepoFilter(e.target.value)}
            className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 py-2 pl-3 pr-8 text-sm text-gray-700 dark:text-gray-300 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            data-testid="repo-filter"
          >
            <option value="">All repositories</option>
            {repos.map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repo.name}
              </option>
            ))}
          </select>
        )}
        {repos.length > 0 && (
          <button
            type="button"
            onClick={handleSyncAll}
            disabled={isSyncingAll}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 disabled:opacity-50"
            data-testid="sync-all-button"
          >
            <RefreshCw size={14} className={isSyncingAll ? 'animate-spin' : ''} />
            Sync All
          </button>
        )}
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-12" data-testid="loading-spinner">
          <Loader2 size={24} className="animate-spin text-brand-500" />
          <span className="ml-2 text-sm text-gray-500 dark:text-gray-400">Loading images...</span>
        </div>
      )}

      {isError && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-700 dark:text-red-400" data-testid="error-message">
          <AlertCircle size={16} />
          <span>Failed to load container images: {error?.message ?? 'Unknown error'}</span>
        </div>
      )}

      {!isLoading && !isError && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full" data-testid="images-table">
              <thead>
                <tr className="border-b border-gray-100 dark:border-gray-700 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  <th className="px-5 py-3">Name</th>
                  <th className="px-5 py-3">Type</th>
                  <th className="hidden px-5 py-3 md:table-cell">Registry URL</th>
                  <th className="px-5 py-3">Source</th>
                  <th className="px-5 py-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {filteredImages.map((image) => {
                  const imageRecord = image as unknown as Record<string, unknown>;
                  const sourceRepoId = (imageRecord.sourceRepoId ?? imageRecord.source_repo_id) as string | undefined;
                  const sourceName = sourceRepoId ? repoMap.get(sourceRepoId) ?? 'Repository' : 'Built-in';
                  const rawTags = imageRecord.tags;
                  const tags: readonly string[] | undefined = Array.isArray(rawTags) ? rawTags : typeof rawTags === 'string' ? (() => { try { return JSON.parse(rawTags); } catch { return undefined; } })() : undefined;

                  return (
                    <tr key={image.id} className="transition-colors hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer" onClick={() => handleRowClick(imageRecord)}>
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-2">
                          <Container size={14} className="text-gray-400" />
                          <span className="font-medium text-gray-900 dark:text-gray-100">{image.name}</span>
                          {tags && tags.length > 0 && (
                            <div className="flex gap-1">{tags.map((tag) => (
                              <span key={tag} className="inline-flex rounded-full bg-gray-100 dark:bg-gray-700 px-2 py-0.5 text-xs text-gray-500 dark:text-gray-400">{tag}</span>
                            ))}</div>
                          )}
                        </div>
                      </td>
                      <td className="px-5 py-3.5 text-sm text-gray-600 dark:text-gray-400">{image.imageType}</td>
                      <td className="hidden px-5 py-3.5 text-sm font-mono text-gray-500 dark:text-gray-400 md:table-cell">{image.registryUrl ?? '—'}</td>
                      <td className="px-5 py-3.5 text-sm text-gray-600 dark:text-gray-400">{sourceName}</td>
                      <td className="px-5 py-3.5"><StatusBadge status={image.status as 'active' | 'pending' | 'error'} /></td>
                    </tr>
                  );
                })}
                {filteredImages.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-5 py-10 text-center text-sm text-gray-500 dark:text-gray-400">
                      No images found matching your search.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="border-t border-gray-100 dark:border-gray-700 px-5 py-3 text-sm text-gray-500 dark:text-gray-400">
            {filteredImages.length} image{filteredImages.length !== 1 ? 's' : ''}
          </div>
        </div>
      )}

      {selectedImage && (
        <WorkloadDetailPanel image={selectedImage} onClose={handleClose} />
      )}
    </div>
  );
}

function RepositoriesTab() {
  return (
    <div data-testid="repos-tab">
      <WorkloadRepoSettings />
    </div>
  );
}
