import { useState, type FormEvent } from 'react';
import { Clock, Plus, Loader2, AlertCircle, Trash2, X, Play, Pause, RotateCw, Globe, Terminal } from 'lucide-react';
import clsx from 'clsx';
import { useClientContext } from '@/hooks/use-client-context';
import { useCanManage } from '@/hooks/use-can-manage';
import ReadOnlyNotice from '@/components/ReadOnlyNotice';
import { useCronJobs, useCreateCronJob, useUpdateCronJob, useRunCronJob, useDeleteCronJob } from '@/hooks/use-cron-jobs';
import { useDeployments } from '@/hooks/use-deployments';
import { useSortable } from '@/hooks/use-sortable';
import SortableHeader from '@/components/ui/SortableHeader';

function StatusBadge({ status }: { readonly status: string }) {
  const colorMap: Record<string, string> = {
    success: 'bg-green-50 text-green-700 border-green-200 dark:bg-green-900/40 dark:text-green-300 dark:border-green-700',
    failed: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-900/40 dark:text-red-300 dark:border-red-700',
    running: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/40 dark:text-blue-300 dark:border-blue-700',
  };
  const colors = colorMap[status] ?? 'bg-gray-50 text-gray-600 border-gray-200 dark:bg-gray-700 dark:text-gray-400 dark:border-gray-600';
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${colors}`}>
      {status}
    </span>
  );
}

function TypeBadge({ type }: { readonly type: 'webcron' | 'deployment' }) {
  if (type === 'webcron') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-blue-200 bg-blue-50 px-2.5 py-0.5 text-xs font-medium text-blue-700 dark:border-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
        <Globe size={10} />
        Webcron
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-purple-200 bg-purple-50 px-2.5 py-0.5 text-xs font-medium text-purple-700 dark:border-purple-700 dark:bg-purple-900/40 dark:text-purple-300">
      <Terminal size={10} />
      Deployment
    </span>
  );
}

const INPUT_CLASS = 'w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500';
const SELECT_CLASS = 'w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500';

interface CronFormState {
  readonly name: string;
  readonly type: 'webcron' | 'deployment';
  readonly schedule: string;
  readonly url: string;
  readonly httpMethod: 'GET' | 'POST' | 'PUT';
  readonly command: string;
  readonly deploymentId: string;
}

const INITIAL_FORM: CronFormState = {
  name: '',
  type: 'webcron',
  schedule: '',
  url: '',
  httpMethod: 'GET',
  command: '',
  deploymentId: '',
};

export default function CronJobs() {
  const { clientId } = useClientContext();
  const canManage = useCanManage();
  const { data: response, isLoading, isError, error } = useCronJobs(clientId ?? undefined);
  const createJob = useCreateCronJob(clientId ?? undefined);
  const updateJob = useUpdateCronJob(clientId ?? undefined);
  const runJob = useRunCronJob(clientId ?? undefined);
  const deleteJob = useDeleteCronJob(clientId ?? undefined);
  const { data: deploymentsResponse } = useDeployments(clientId ?? undefined);

  const deployments = (deploymentsResponse?.data ?? []).filter((d) => d.status === 'running');

  const jobsRaw = response?.data ?? [];
  const { sortedData: jobs, sortKey, sortDirection, onSort } = useSortable(jobsRaw, 'name');

  const [showForm, setShowForm] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [form, setForm] = useState<CronFormState>(INITIAL_FORM);

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.schedule.trim()) return;

    if (form.type === 'webcron' && !form.url.trim()) return;
    if (form.type === 'deployment' && (!form.command.trim() || !form.deploymentId)) return;

    try {
      await createJob.mutateAsync({
        name: form.name.trim(),
        type: form.type,
        schedule: form.schedule.trim(),
        ...(form.type === 'webcron'
          ? { url: form.url.trim(), http_method: form.httpMethod }
          : { command: form.command.trim(), deployment_id: form.deploymentId }),
        enabled: true,
      });
      setForm(INITIAL_FORM);
      setShowForm(false);
    } catch { /* error via createJob.error */ }
  };

  const handleDelete = async (id: string) => {
    try { await deleteJob.mutateAsync(id); setDeleteConfirmId(null); }
    catch { /* error via deleteJob.error */ }
  };

  const formatTarget = (job: (typeof jobsRaw)[number]) => {
    if (job.type === 'webcron') {
      return `${job.httpMethod ?? 'GET'} ${job.url ?? ''}`;
    }
    return job.command ?? '';
  };

  const formatDuration = (ms: number | null | undefined) => {
    if (ms == null) return null;
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-orange-50 text-orange-600 dark:bg-orange-900/40 dark:text-orange-400">
            <Clock size={20} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100" data-testid="cron-jobs-heading">Cron Jobs</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400">Schedule recurring tasks.</p>
          </div>
        </div>
        {canManage && (
          <button
            type="button"
            onClick={() => setShowForm((p) => !p)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
            data-testid="add-cron-job-button"
          >
            {showForm ? <X size={14} /> : <Plus size={14} />}
            {showForm ? 'Cancel' : 'Add Cron Job'}
          </button>
        )}
      </div>

      {!canManage && <ReadOnlyNotice message="You have read-only access to scheduled tasks. Creating, editing, and running cron jobs require administrator access." />}

      {showForm && (
        <form onSubmit={handleCreate} className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-4 space-y-4" data-testid="cron-job-form">
          {/* Type selector */}
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-2">Type</label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setForm({ ...form, type: 'webcron' })}
                className={clsx(
                  'flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-colors',
                  form.type === 'webcron'
                    ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-500'
                    : 'border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-700',
                )}
                data-testid="cron-type-webcron"
              >
                <Globe size={16} />
                Webcron
              </button>
              <button
                type="button"
                onClick={() => setForm({ ...form, type: 'deployment' })}
                className={clsx(
                  'flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-colors',
                  form.type === 'deployment'
                    ? 'border-purple-500 bg-purple-50 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300 dark:border-purple-500'
                    : 'border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-700',
                )}
                data-testid="cron-type-deployment"
              >
                <Terminal size={16} />
                Deployment
              </button>
            </div>
          </div>

          {/* Type-specific fields */}
          {form.type === 'webcron' ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="cj-url" className="block text-xs font-medium text-gray-700 dark:text-gray-300">URL *</label>
                <input id="cj-url" type="url" className={INPUT_CLASS + ' mt-1'} placeholder="https://example.com/cron.php" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} required data-testid="cron-url-input" />
              </div>
              <div>
                <label htmlFor="cj-method" className="block text-xs font-medium text-gray-700 dark:text-gray-300">HTTP Method</label>
                <select id="cj-method" className={SELECT_CLASS + ' mt-1'} value={form.httpMethod} onChange={(e) => setForm({ ...form, httpMethod: e.target.value as 'GET' | 'POST' | 'PUT' })} data-testid="cron-method-select">
                  <option value="GET">GET</option>
                  <option value="POST">POST</option>
                  <option value="PUT">PUT</option>
                </select>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="cj-deployment" className="block text-xs font-medium text-gray-700 dark:text-gray-300">Deployment *</label>
                <select id="cj-deployment" className={SELECT_CLASS + ' mt-1'} value={form.deploymentId} onChange={(e) => setForm({ ...form, deploymentId: e.target.value })} required data-testid="cron-deployment-select">
                  <option value="">Select a deployment...</option>
                  {deployments.map((d) => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="cj-cmd" className="block text-xs font-medium text-gray-700 dark:text-gray-300">Command *</label>
                <input id="cj-cmd" type="text" className={INPUT_CLASS + ' mt-1'} placeholder="php artisan schedule:run" value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} required data-testid="cron-command-input" />
              </div>
            </div>
          )}

          {/* Common fields */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label htmlFor="cj-name" className="block text-xs font-medium text-gray-700 dark:text-gray-300">Name *</label>
              <input id="cj-name" type="text" className={INPUT_CLASS + ' mt-1'} placeholder="daily-backup" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required data-testid="cron-name-input" />
            </div>
            <div>
              <label htmlFor="cj-schedule" className="block text-xs font-medium text-gray-700 dark:text-gray-300">Schedule (cron) *</label>
              <input id="cj-schedule" type="text" className={INPUT_CLASS + ' mt-1'} placeholder="*/15 * * * *" value={form.schedule} onChange={(e) => setForm({ ...form, schedule: e.target.value })} required data-testid="cron-schedule-input" />
            </div>
            <div className="flex items-end">
              <button type="submit" disabled={createJob.isPending} className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50" data-testid="submit-cron-job">
                {createJob.isPending && <Loader2 size={14} className="animate-spin" />}
                Add
              </button>
            </div>
          </div>

          {createJob.error && (
            <div className="flex items-center gap-2 text-sm text-red-600" data-testid="cron-create-error">
              <AlertCircle size={14} />
              {createJob.error instanceof Error ? createJob.error.message : 'Failed to create cron job'}
            </div>
          )}
        </form>
      )}

      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm">
        {isLoading && (
          <div className="flex items-center justify-center py-16" data-testid="cron-jobs-loading">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-200 border-t-blue-600" />
            <span className="ml-3 text-sm text-gray-500 dark:text-gray-400">Loading cron jobs...</span>
          </div>
        )}

        {isError && (
          <div className="px-6 py-16 text-center" data-testid="cron-jobs-error">
            <p className="text-sm text-red-600">Failed to load: {error instanceof Error ? error.message : 'Unknown error'}</p>
          </div>
        )}

        {!isLoading && !isError && jobsRaw.length === 0 && (
          <div className="px-6 py-16 text-center" data-testid="cron-jobs-empty">
            <Clock size={40} className="mx-auto text-gray-300 dark:text-gray-600" />
            <p className="mt-3 text-sm font-medium text-gray-900 dark:text-gray-100">No cron jobs yet</p>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Click &quot;Add Cron Job&quot; to schedule one.</p>
          </div>
        )}

        {!isLoading && !isError && jobsRaw.length > 0 && (
          <div className="overflow-x-auto" data-testid="cron-jobs-table">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/50">
                  <SortableHeader label="Name" sortKey="name" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="px-6 font-medium text-gray-500 dark:text-gray-400" />
                  <SortableHeader label="Type" sortKey="type" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="px-6 font-medium text-gray-500 dark:text-gray-400" />
                  <SortableHeader label="Schedule" sortKey="schedule" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="px-6 font-medium text-gray-500 dark:text-gray-400" />
                  <th className="hidden px-6 py-3 font-medium text-gray-500 dark:text-gray-400 md:table-cell">Target</th>
                  <SortableHeader label="Enabled" sortKey="enabled" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="px-6 font-medium text-gray-500 dark:text-gray-400" />
                  <SortableHeader label="Last Run" sortKey="lastRunStatus" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="hidden px-6 font-medium text-gray-500 dark:text-gray-400 sm:table-cell" />
                  <th className="px-6 py-3 font-medium text-gray-500 dark:text-gray-400">Actions</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id} className="border-b border-gray-100 dark:border-gray-700 last:border-0">
                    <td className="px-6 py-4 font-medium text-gray-900 dark:text-gray-100">{job.name}</td>
                    <td className="px-6 py-4">
                      <TypeBadge type={job.type} />
                    </td>
                    <td className="px-6 py-4 font-mono text-gray-600 dark:text-gray-400">{job.schedule}</td>
                    <td className="hidden px-6 py-4 text-gray-600 dark:text-gray-400 md:table-cell max-w-xs truncate">
                      <code className="text-xs">{formatTarget(job)}</code>
                    </td>
                    <td className="px-6 py-4">
                      <span className={job.enabled ? 'text-green-600' : 'text-gray-400'}>{job.enabled ? 'Yes' : 'No'}</span>
                    </td>
                    <td className="hidden px-6 py-4 sm:table-cell">
                      <div className="flex flex-col gap-1">
                        {job.lastRunStatus ? (
                          <>
                            <StatusBadge status={job.lastRunStatus} />
                            <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                              {formatDuration(job.lastRunDurationMs) && (
                                <span>{formatDuration(job.lastRunDurationMs)}</span>
                              )}
                              {job.type === 'webcron' && job.lastRunResponseCode != null && (
                                <span className="font-mono">{job.lastRunResponseCode}</span>
                              )}
                            </div>
                          </>
                        ) : (
                          <span className="text-gray-400">Never</span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => updateJob.mutate({ cronJobId: job.id, enabled: !job.enabled })}
                          className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1.5 text-xs text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
                          title={job.enabled ? 'Stop (disable)' : 'Start (enable)'}
                          data-testid={`toggle-cron-${job.id}`}
                        >
                          {job.enabled ? <Pause size={12} /> : <Play size={12} />}
                        </button>
                        <button
                          type="button"
                          onClick={() => runJob.mutate(job.id)}
                          className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1.5 text-xs text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
                          title="Run Now"
                          data-testid={`run-cron-${job.id}`}
                        >
                          <RotateCw size={12} />
                        </button>
                        {deleteConfirmId === job.id ? (
                          <>
                            <button type="button" onClick={() => handleDelete(job.id)} disabled={deleteJob.isPending} className="rounded-md bg-red-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50" data-testid={`confirm-delete-cj-${job.id}`}>Confirm</button>
                            <button type="button" onClick={() => setDeleteConfirmId(null)} className="rounded-md border border-gray-200 dark:border-gray-700 px-2.5 py-1.5 text-xs text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50">Cancel</button>
                          </>
                        ) : (
                          <button type="button" onClick={() => setDeleteConfirmId(job.id)} className="rounded-md border border-red-200 dark:border-red-700 bg-white dark:bg-gray-800 px-2 py-1.5 text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30" data-testid={`delete-cron-${job.id}`}>
                            <Trash2 size={12} />
                          </button>
                        )}
                      </div>
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
