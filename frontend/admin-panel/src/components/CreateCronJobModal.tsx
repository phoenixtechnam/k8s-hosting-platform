import { useState, type FormEvent } from 'react';
import { X, Loader2 } from 'lucide-react';
import { useCreateCronJob } from '@/hooks/use-cron-jobs';

interface CreateCronJobModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly clientId: string;
}

export default function CreateCronJobModal({ open, onClose, clientId }: CreateCronJobModalProps) {
  const [name, setName] = useState('');
  const [schedule, setSchedule] = useState('');
  const [command, setCommand] = useState('');
  const [enabled, setEnabled] = useState(true);

  const createCronJob = useCreateCronJob(clientId);

  const resetForm = () => {
    setName('');
    setSchedule('');
    setCommand('');
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
      await createCronJob.mutateAsync({ name, schedule, command, enabled });
      handleClose();
    } catch {
      // error displayed in modal
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" data-testid="create-cron-job-modal">
      <div className="fixed inset-0 bg-black/50" onClick={handleClose} />
      <div className="relative w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold text-gray-900">Add Cron Job</h2>
          <button
            onClick={handleClose}
            className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>

        {createCronJob.error && (
          <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600" data-testid="create-cron-job-error">
            {createCronJob.error instanceof Error ? createCronJob.error.message : 'Failed to create cron job'}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4" data-testid="create-cron-job-form">
          <div>
            <label htmlFor="cron-job-name" className="block text-sm font-medium text-gray-700">
              Name *
            </label>
            <input
              id="cron-job-name"
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              placeholder="My cron job"
              data-testid="cron-job-name-input"
            />
          </div>

          <div>
            <label htmlFor="cron-job-schedule" className="block text-sm font-medium text-gray-700">
              Schedule *
            </label>
            <input
              id="cron-job-schedule"
              type="text"
              required
              value={schedule}
              onChange={(e) => setSchedule(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              placeholder="*/5 * * * *"
              data-testid="cron-job-schedule-input"
            />
          </div>

          <div>
            <label htmlFor="cron-job-command" className="block text-sm font-medium text-gray-700">
              Command *
            </label>
            <input
              id="cron-job-command"
              type="text"
              required
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              placeholder="/usr/bin/php /var/www/cron.php"
              data-testid="cron-job-command-input"
            />
          </div>

          <div className="flex items-center gap-2">
            <input
              id="cron-job-enabled"
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-brand-500 focus:ring-brand-500"
              data-testid="cron-job-enabled-checkbox"
            />
            <label htmlFor="cron-job-enabled" className="text-sm font-medium text-gray-700">
              Enabled
            </label>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={handleClose}
              className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
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
