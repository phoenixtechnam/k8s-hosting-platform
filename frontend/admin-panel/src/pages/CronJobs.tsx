import { useState } from 'react';
import { Plus, Loader2, Clock, Play, Pause, RotateCw, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import CreateCronJobModal from '@/components/CreateCronJobModal';
import SearchableClientSelect from '@/components/ui/SearchableClientSelect';
import { useCronJobs, useUpdateCronJob, useRunCronJob, useDeleteCronJob } from '@/hooks/use-cron-jobs';
import { useSortable } from '@/hooks/use-sortable';
import SortableHeader from '@/components/ui/SortableHeader';

export default function CronJobs() {
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const { data: cronJobsData, isLoading: cronJobsLoading, error } = useCronJobs(
    selectedClientId ?? undefined,
  );
  const updateCronJob = useUpdateCronJob(selectedClientId ?? undefined);
  const runCronJob = useRunCronJob(selectedClientId ?? undefined);
  const deleteCronJob = useDeleteCronJob(selectedClientId ?? undefined);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const cronJobs = cronJobsData?.data ?? [];
  const totalCount = cronJobsData?.pagination?.total_count ?? 0;
  const { sortedData: sortedCronJobs, sortKey, sortDirection, onSort } = useSortable(cronJobs, 'name');

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Clock size={24} className="text-gray-700 dark:text-gray-300" />
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Cron Jobs</h1>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          disabled={!selectedClientId}
          className={clsx(
            'inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium text-white shadow-sm transition-colors',
            selectedClientId
              ? 'bg-brand-500 hover:bg-brand-600'
              : 'bg-gray-300 cursor-not-allowed',
          )}
          data-testid="add-cron-job-button"
        >
          <Plus size={16} />
          Add Cron Job
        </button>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <SearchableClientSelect
          selectedClientId={selectedClientId}
          onSelect={setSelectedClientId}
        />
      </div>

      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm">
        {cronJobsLoading && (
          <div className="flex items-center justify-center py-10">
            <Loader2 size={24} className="animate-spin text-gray-400" />
          </div>
        )}

        {error && (
          <div className="px-5 py-10 text-center text-sm text-red-500 dark:text-red-400" data-testid="cron-jobs-error">
            {error instanceof Error ? error.message : 'Failed to load cron jobs'}
          </div>
        )}

        {!cronJobsLoading && !error && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full" data-testid="cron-jobs-table">
                <thead>
                  <tr className="border-b border-gray-100 dark:border-gray-700 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    <SortableHeader label="Name" sortKey="name" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
                    <SortableHeader label="Schedule" sortKey="schedule" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
                    <SortableHeader label="Command" sortKey="command" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="hidden md:table-cell" />
                    <SortableHeader label="Enabled" sortKey="enabled" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
                    <SortableHeader label="Last Run" sortKey="lastRunAt" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="hidden lg:table-cell" />
                    <SortableHeader label="Status" sortKey="lastRunStatus" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="hidden lg:table-cell" />
                    <th className="px-5 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {sortedCronJobs.map((job) => (
                    <tr key={job.id} className="transition-colors hover:bg-gray-50 dark:hover:bg-gray-700/50">
                      <td className="px-5 py-3.5">
                        <span className="font-medium text-gray-900 dark:text-gray-100">{job.name}</span>
                      </td>
                      <td className="px-5 py-3.5">
                        <code className="rounded bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 text-xs text-gray-700 dark:text-gray-300">
                          {job.schedule}
                        </code>
                      </td>
                      <td className="hidden px-5 py-3.5 text-sm text-gray-600 dark:text-gray-400 md:table-cell">
                        <code className="text-xs">{job.command}</code>
                      </td>
                      <td className="px-5 py-3.5">
                        <span
                          className={clsx(
                            'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                            job.enabled
                              ? 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400'
                              : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400',
                          )}
                        >
                          {job.enabled ? 'Active' : 'Disabled'}
                        </span>
                      </td>
                      <td className="hidden px-5 py-3.5 text-sm text-gray-500 dark:text-gray-400 lg:table-cell">
                        {job.lastRunAt
                          ? new Date(job.lastRunAt).toLocaleString()
                          : '\u2014'}
                      </td>
                      <td className="hidden px-5 py-3.5 lg:table-cell">
                        {job.lastRunStatus ? (
                          <span
                            className={clsx(
                              'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                              job.lastRunStatus === 'success'
                                ? 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400'
                                : job.lastRunStatus === 'running'
                                  ? 'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400'
                                  : 'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400',
                            )}
                          >
                            {job.lastRunStatus}
                          </span>
                        ) : (
                          <span className="text-sm text-gray-400">{'\u2014'}</span>
                        )}
                      </td>
                      <td className="px-5 py-3.5 text-right">
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => updateCronJob.mutate({ cronJobId: job.id, enabled: !job.enabled })}
                            className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1.5 text-xs text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
                            title={job.enabled ? 'Stop (disable)' : 'Start (enable)'}
                            data-testid={`toggle-cron-${job.id}`}
                          >
                            {job.enabled ? <Pause size={12} /> : <Play size={12} />}
                          </button>
                          <button
                            type="button"
                            onClick={() => runCronJob.mutate(job.id)}
                            className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1.5 text-xs text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
                            title="Run Now"
                            data-testid={`run-cron-${job.id}`}
                          >
                            <RotateCw size={12} />
                          </button>
                          {deleteConfirmId === job.id ? (
                            <>
                              <button type="button" onClick={async () => { await deleteCronJob.mutateAsync(job.id); setDeleteConfirmId(null); }} disabled={deleteCronJob.isPending} className="rounded-md bg-red-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50" data-testid={`confirm-delete-cron-${job.id}`}>Confirm</button>
                              <button type="button" onClick={() => setDeleteConfirmId(null)} className="rounded-md border border-gray-200 dark:border-gray-700 px-2.5 py-1.5 text-xs text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50">Cancel</button>
                            </>
                          ) : (
                            <button type="button" onClick={() => setDeleteConfirmId(job.id)} className="rounded-md border border-red-200 dark:border-red-800 bg-white dark:bg-gray-800 px-2 py-1.5 text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20" data-testid={`delete-cron-${job.id}`}>
                              <Trash2 size={12} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {cronJobs.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-5 py-10 text-center text-sm text-gray-500 dark:text-gray-400">
                        {selectedClientId
                          ? 'No cron jobs yet. Click "Add Cron Job" to create one.'
                          : 'No cron jobs found across any client.'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="border-t border-gray-100 dark:border-gray-700 px-5 py-3 text-sm text-gray-500 dark:text-gray-400">
              {totalCount} cron job{totalCount !== 1 ? 's' : ''}
            </div>
          </>
        )}
      </div>

      {selectedClientId && (
        <CreateCronJobModal
          open={showCreate}
          onClose={() => setShowCreate(false)}
          clientId={selectedClientId}
        />
      )}
    </div>
  );
}
