import { useState, type FormEvent } from 'react';
import { X, Loader2, Globe, Terminal } from 'lucide-react';
import clsx from 'clsx';
import { useCreateCronJob } from '@/hooks/use-cron-jobs';
import { useDeployments } from '@/hooks/use-deployments';

interface CreateCronJobModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly clientId: string;
}

const INPUT_CLASS = 'mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm dark:bg-gray-700 dark:text-gray-100 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

export default function CreateCronJobModal({ open, onClose, clientId }: CreateCronJobModalProps) {
  const [name, setName] = useState('');
  const [type, setType] = useState<'webcron' | 'deployment'>('webcron');
  const [schedule, setSchedule] = useState('');
  const [url, setUrl] = useState('');
  const [httpMethod, setHttpMethod] = useState<'GET' | 'POST' | 'PUT'>('GET');
  const [command, setCommand] = useState('');
  const [deploymentId, setDeploymentId] = useState('');
  const [enabled, setEnabled] = useState(true);

  const createCronJob = useCreateCronJob(clientId);
  const { data: deploymentsResponse } = useDeployments(clientId);
  const deployments = (deploymentsResponse?.data ?? []).filter((d) => d.status === 'running');

  const resetForm = () => {
    setName('');
    setType('webcron');
    setSchedule('');
    setUrl('');
    setHttpMethod('GET');
    setCommand('');
    setDeploymentId('');
    setEnabled(true);
    createCronJob.reset();
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await createCronJob.mutateAsync({
        name,
        type,
        schedule,
        ...(type === 'webcron'
          ? { url, http_method: httpMethod }
          : { command, deployment_id: deploymentId }),
        enabled,
      });
      handleClose();
    } catch {
      // error displayed in modal
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" data-testid="create-cron-job-modal">
      <div className="fixed inset-0 bg-black/50" onClick={handleClose} />
      <div className="relative w-full max-w-lg rounded-2xl bg-white dark:bg-gray-800 p-6 shadow-xl">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Add Cron Job</h2>
          <button
            onClick={handleClose}
            className="rounded-md p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-600 dark:hover:text-gray-400"
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>

        {createCronJob.error && (
          <div className="mb-4 rounded-lg bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-600 dark:text-red-400" data-testid="create-cron-job-error">
            {createCronJob.error instanceof Error ? createCronJob.error.message : 'Failed to create cron job'}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4" data-testid="create-cron-job-form">
          {/* Type selector */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Type</label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setType('webcron')}
                className={clsx(
                  'flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-colors',
                  type === 'webcron'
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
                onClick={() => setType('deployment')}
                className={clsx(
                  'flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-colors',
                  type === 'deployment'
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
          {type === 'webcron' ? (
            <>
              <div>
                <label htmlFor="cron-job-url" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  URL *
                </label>
                <input
                  id="cron-job-url"
                  type="url"
                  required
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  className={INPUT_CLASS}
                  placeholder="https://example.com/cron.php"
                  data-testid="cron-job-url-input"
                />
              </div>
              <div>
                <label htmlFor="cron-job-method" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  HTTP Method
                </label>
                <select
                  id="cron-job-method"
                  value={httpMethod}
                  onChange={(e) => setHttpMethod(e.target.value as 'GET' | 'POST' | 'PUT')}
                  className={INPUT_CLASS}
                  data-testid="cron-job-method-select"
                >
                  <option value="GET">GET</option>
                  <option value="POST">POST</option>
                  <option value="PUT">PUT</option>
                </select>
              </div>
            </>
          ) : (
            <>
              <div>
                <label htmlFor="cron-job-deployment" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Deployment *
                </label>
                <select
                  id="cron-job-deployment"
                  required
                  value={deploymentId}
                  onChange={(e) => setDeploymentId(e.target.value)}
                  className={INPUT_CLASS}
                  data-testid="cron-job-deployment-select"
                >
                  <option value="">Select a deployment...</option>
                  {deployments.map((d) => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="cron-job-command" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Command *
                </label>
                <input
                  id="cron-job-command"
                  type="text"
                  required
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  className={INPUT_CLASS}
                  placeholder="php artisan schedule:run"
                  data-testid="cron-job-command-input"
                />
              </div>
            </>
          )}

          {/* Common fields */}
          <div>
            <label htmlFor="cron-job-name" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Name *
            </label>
            <input
              id="cron-job-name"
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={INPUT_CLASS}
              placeholder="My cron job"
              data-testid="cron-job-name-input"
            />
          </div>

          <div>
            <label htmlFor="cron-job-schedule" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Schedule *
            </label>
            <input
              id="cron-job-schedule"
              type="text"
              required
              value={schedule}
              onChange={(e) => setSchedule(e.target.value)}
              className={INPUT_CLASS}
              placeholder="*/5 * * * *"
              data-testid="cron-job-schedule-input"
            />
          </div>

          <div className="flex items-center gap-2">
            <input
              id="cron-job-enabled"
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 dark:border-gray-600 text-brand-500 focus:ring-brand-500"
              data-testid="cron-job-enabled-checkbox"
            />
            <label htmlFor="cron-job-enabled" className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Enabled
            </label>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={handleClose}
              className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={createCronJob.isPending}
              className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
              data-testid="submit-cron-job-button"
            >
              {createCronJob.isPending && <Loader2 size={14} className="animate-spin" />}
              Add Cron Job
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
