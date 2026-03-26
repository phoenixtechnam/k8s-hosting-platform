import { useState } from 'react';
import { Plus, Loader2, Clock, RefreshCw } from 'lucide-react';
import clsx from 'clsx';
import CreateCronJobModal from '@/components/CreateCronJobModal';
import { useCronJobs } from '@/hooks/use-cron-jobs';
import { useClients } from '@/hooks/use-clients';

export default function CronJobs() {
  const [selectedClientId, setSelectedClientId] = useState('');
  const [showCreate, setShowCreate] = useState(false);

  const { data: clientsData, isLoading: clientsLoading, error: clientsError, refetch: refetchClients } = useClients({ limit: 100 });
  const clients = clientsData?.data ?? [];

  const { data: cronJobsData, isLoading: cronJobsLoading, error } = useCronJobs(
    selectedClientId || undefined,
  );

  const cronJobs = cronJobsData?.data ?? [];
  const totalCount = cronJobsData?.pagination?.total_count ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Clock size={24} className="text-gray-700" />
          <h1 className="text-2xl font-bold text-gray-900">Cron Jobs</h1>
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
        <div className="w-full max-w-xs">
          {clientsError ? (
            <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2" data-testid="client-selector-error">
              <p className="text-sm text-red-600">Failed to load clients</p>
              <button
                onClick={() => refetchClients()}
                className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-100"
                data-testid="retry-clients-button"
              >
                <RefreshCw size={12} />
                Retry
              </button>
            </div>
          ) : (
            <select
              value={selectedClientId}
              onChange={(e) => setSelectedClientId(e.target.value)}
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              data-testid="client-selector"
            >
              <option value="">All Clients</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.companyName}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
        {(cronJobsLoading || clientsLoading) && (
          <div className="flex items-center justify-center py-10">
            <Loader2 size={24} className="animate-spin text-gray-400" />
          </div>
        )}

        {error && (
          <div className="px-5 py-10 text-center text-sm text-red-500" data-testid="cron-jobs-error">
            {error instanceof Error ? error.message : 'Failed to load cron jobs'}
          </div>
        )}

        {!cronJobsLoading && !error && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full" data-testid="cron-jobs-table">
                <thead>
                  <tr className="border-b border-gray-100 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                    <th className="px-5 py-3">Name</th>
                    <th className="px-5 py-3">Schedule</th>
                    <th className="hidden px-5 py-3 md:table-cell">Command</th>
                    <th className="px-5 py-3">Enabled</th>
                    <th className="hidden px-5 py-3 lg:table-cell">Last Run</th>
                    <th className="hidden px-5 py-3 lg:table-cell">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {cronJobs.map((job) => (
                    <tr key={job.id} className="transition-colors hover:bg-gray-50">
                      <td className="px-5 py-3.5">
                        <span className="font-medium text-gray-900">{job.name}</span>
                      </td>
                      <td className="px-5 py-3.5">
                        <code className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-700">
                          {job.schedule}
                        </code>
                      </td>
                      <td className="hidden px-5 py-3.5 text-sm text-gray-600 md:table-cell">
                        <code className="text-xs">{job.command}</code>
                      </td>
                      <td className="px-5 py-3.5">
                        <span
                          className={clsx(
                            'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                            job.enabled
                              ? 'bg-green-100 text-green-700'
                              : 'bg-gray-100 text-gray-500',
                          )}
                        >
                          {job.enabled ? 'Active' : 'Disabled'}
                        </span>
                      </td>
                      <td className="hidden px-5 py-3.5 text-sm text-gray-500 lg:table-cell">
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
                                ? 'bg-green-100 text-green-700'
                                : job.lastRunStatus === 'running'
                                  ? 'bg-blue-100 text-blue-700'
                                  : 'bg-red-100 text-red-700',
                            )}
                          >
                            {job.lastRunStatus}
                          </span>
                        ) : (
                          <span className="text-sm text-gray-400">{'\u2014'}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {cronJobs.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-5 py-10 text-center text-sm text-gray-500">
                        {selectedClientId
                          ? 'No cron jobs yet. Click "Add Cron Job" to create one.'
                          : 'No cron jobs found across any client.'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="border-t border-gray-100 px-5 py-3 text-sm text-gray-500">
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
