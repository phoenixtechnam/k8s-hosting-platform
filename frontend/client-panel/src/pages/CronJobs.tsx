import { useState, type FormEvent } from 'react';
import { Clock, Plus, Loader2, AlertCircle, Trash2, X, Play, Pause, RotateCw } from 'lucide-react';
import { useClientContext } from '@/hooks/use-client-context';
import { useCronJobs, useCreateCronJob, useUpdateCronJob, useRunCronJob, useDeleteCronJob } from '@/hooks/use-cron-jobs';

function StatusBadge({ status }: { readonly status: string }) {
  const colorMap: Record<string, string> = {
    success: 'bg-green-50 text-green-700 border-green-200',
    failed: 'bg-red-50 text-red-700 border-red-200',
    running: 'bg-blue-50 text-blue-700 border-blue-200',
  };
  const colors = colorMap[status] ?? 'bg-gray-50 text-gray-600 border-gray-200';
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${colors}`}>
      {status}
    </span>
  );
}

const INPUT_CLASS = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500';

export default function CronJobs() {
  const { clientId } = useClientContext();
  const { data: response, isLoading, isError, error } = useCronJobs(clientId ?? undefined);
  const createJob = useCreateCronJob(clientId ?? undefined);
  const updateJob = useUpdateCronJob(clientId ?? undefined);
  const runJob = useRunCronJob(clientId ?? undefined);
  const deleteJob = useDeleteCronJob(clientId ?? undefined);

  const jobs = response?.data ?? [];

  const [showForm, setShowForm] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', schedule: '', command: '' });

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.schedule.trim() || !form.command.trim()) return;
    try {
      await createJob.mutateAsync({
        name: form.name.trim(),
        schedule: form.schedule.trim(),
        command: form.command.trim(),
        enabled: true,
      });
      setForm({ name: '', schedule: '', command: '' });
      setShowForm(false);
    } catch { /* error via createJob.error */ }
  };

  const handleDelete = async (id: string) => {
    try { await deleteJob.mutateAsync(id); setDeleteConfirmId(null); }
    catch { /* error via deleteJob.error */ }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-orange-50 text-orange-600">
            <Clock size={20} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900" data-testid="cron-jobs-heading">Cron Jobs</h1>
            <p className="text-sm text-gray-500">Schedule recurring tasks.</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setShowForm((p) => !p)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
          data-testid="add-cron-job-button"
        >
          {showForm ? <X size={14} /> : <Plus size={14} />}
          {showForm ? 'Cancel' : 'Add Cron Job'}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="rounded-lg border border-gray-200 bg-gray-50 p-4" data-testid="cron-job-form">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <div>
              <label htmlFor="cj-name" className="block text-xs font-medium text-gray-700">Name</label>
              <input id="cj-name" type="text" className={INPUT_CLASS + ' mt-1'} placeholder="daily-backup" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required data-testid="cron-name-input" />
            </div>
            <div>
              <label htmlFor="cj-schedule" className="block text-xs font-medium text-gray-700">Schedule (cron)</label>
              <input id="cj-schedule" type="text" className={INPUT_CLASS + ' mt-1'} placeholder="0 2 * * *" value={form.schedule} onChange={(e) => setForm({ ...form, schedule: e.target.value })} required data-testid="cron-schedule-input" />
            </div>
            <div>
              <label htmlFor="cj-cmd" className="block text-xs font-medium text-gray-700">Command</label>
              <input id="cj-cmd" type="text" className={INPUT_CLASS + ' mt-1'} placeholder="/usr/bin/backup.sh" value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} required data-testid="cron-command-input" />
            </div>
            <div className="flex items-end">
              <button type="submit" disabled={createJob.isPending} className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50" data-testid="submit-cron-job">
                {createJob.isPending && <Loader2 size={14} className="animate-spin" />}
                Add
              </button>
            </div>
          </div>
          {createJob.error && (
            <div className="mt-3 flex items-center gap-2 text-sm text-red-600" data-testid="cron-create-error">
              <AlertCircle size={14} />
              {createJob.error instanceof Error ? createJob.error.message : 'Failed to create cron job'}
            </div>
          )}
        </form>
      )}

      <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
        {isLoading && (
          <div className="flex items-center justify-center py-16" data-testid="cron-jobs-loading">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-200 border-t-blue-600" />
            <span className="ml-3 text-sm text-gray-500">Loading cron jobs...</span>
          </div>
        )}

        {isError && (
          <div className="px-6 py-16 text-center" data-testid="cron-jobs-error">
            <p className="text-sm text-red-600">Failed to load: {error instanceof Error ? error.message : 'Unknown error'}</p>
          </div>
        )}

        {!isLoading && !isError && jobs.length === 0 && (
          <div className="px-6 py-16 text-center" data-testid="cron-jobs-empty">
            <Clock size={40} className="mx-auto text-gray-300" />
            <p className="mt-3 text-sm font-medium text-gray-900">No cron jobs yet</p>
            <p className="mt-1 text-sm text-gray-500">Click "Add Cron Job" to schedule one.</p>
          </div>
        )}

        {!isLoading && !isError && jobs.length > 0 && (
          <div className="overflow-x-auto" data-testid="cron-jobs-table">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50/50">
                  <th className="px-6 py-3 font-medium text-gray-500">Name</th>
                  <th className="px-6 py-3 font-medium text-gray-500">Schedule</th>
                  <th className="hidden px-6 py-3 font-medium text-gray-500 md:table-cell">Command</th>
                  <th className="px-6 py-3 font-medium text-gray-500">Enabled</th>
                  <th className="hidden px-6 py-3 font-medium text-gray-500 sm:table-cell">Last Run</th>
                  <th className="px-6 py-3 font-medium text-gray-500">Actions</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id} className="border-b border-gray-100 last:border-0">
                    <td className="px-6 py-4 font-medium text-gray-900">{job.name}</td>
                    <td className="px-6 py-4 font-mono text-gray-600">{job.schedule}</td>
                    <td className="hidden px-6 py-4 text-gray-600 md:table-cell max-w-xs truncate">{job.command}</td>
                    <td className="px-6 py-4">
                      <span className={job.enabled ? 'text-green-600' : 'text-gray-400'}>{job.enabled ? 'Yes' : 'No'}</span>
                    </td>
                    <td className="hidden px-6 py-4 sm:table-cell">
                      {job.lastRunStatus ? <StatusBadge status={job.lastRunStatus} /> : <span className="text-gray-400">Never</span>}
                    </td>
                    <td className="px-6 py-4">
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => updateJob.mutate({ cronJobId: job.id, enabled: !job.enabled })}
                          className="rounded-md border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
                          title={job.enabled ? 'Stop (disable)' : 'Start (enable)'}
                          data-testid={`toggle-cron-${job.id}`}
                        >
                          {job.enabled ? <Pause size={12} /> : <Play size={12} />}
                        </button>
                        <button
                          type="button"
                          onClick={() => runJob.mutate(job.id)}
                          className="rounded-md border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
                          title="Run Now"
                          data-testid={`run-cron-${job.id}`}
                        >
                          <RotateCw size={12} />
                        </button>
                        {deleteConfirmId === job.id ? (
                          <>
                            <button type="button" onClick={() => handleDelete(job.id)} disabled={deleteJob.isPending} className="rounded-md bg-red-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50" data-testid={`confirm-delete-cj-${job.id}`}>Confirm</button>
                            <button type="button" onClick={() => setDeleteConfirmId(null)} className="rounded-md border border-gray-200 px-2.5 py-1.5 text-xs text-gray-600 hover:bg-gray-50">Cancel</button>
                          </>
                        ) : (
                          <button type="button" onClick={() => setDeleteConfirmId(job.id)} className="rounded-md border border-red-200 bg-white px-2 py-1.5 text-xs text-red-600 hover:bg-red-50" data-testid={`delete-cron-${job.id}`}>
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
