import { useState } from 'react';
import { RefreshCw, X, CheckCircle, AlertCircle } from 'lucide-react';
import { usePlatformVersion, useTriggerUpdate } from '@/hooks/use-platform-updates';

export default function UpdateBanner() {
  const [dismissed, setDismissed] = useState(false);
  const { data: versionRes } = usePlatformVersion();
  const triggerUpdate = useTriggerUpdate();

  const version = versionRes?.data;

  if (!version?.updateAvailable || dismissed) {
    return null;
  }

  return (
    <div
      data-testid="update-banner"
      className="mx-4 mt-4 lg:mx-6 lg:mt-6 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/30 px-4 py-3"
    >
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2 text-sm text-blue-800 dark:text-blue-200">
          <RefreshCw size={16} className="shrink-0" />
          <span>
            Platform update available: <strong>{version.latestVersion}</strong>{' '}
            (current: {version.currentVersion})
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {triggerUpdate.isSuccess && (
            <span className="flex items-center gap-1 text-sm text-green-700 dark:text-green-300">
              <CheckCircle size={14} />
              Update started
            </span>
          )}
          {triggerUpdate.isError && (
            <span className="flex items-center gap-1 text-sm text-red-700 dark:text-red-300">
              <AlertCircle size={14} />
              Update failed
            </span>
          )}
          <button
            type="button"
            data-testid="update-banner-trigger"
            disabled={triggerUpdate.isPending}
            onClick={() => triggerUpdate.mutate()}
            className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {triggerUpdate.isPending ? (
              <>
                <RefreshCw size={14} className="animate-spin" />
                Updating...
              </>
            ) : (
              'Update Now'
            )}
          </button>
          <button
            type="button"
            data-testid="update-banner-dismiss"
            onClick={() => setDismissed(true)}
            className="rounded-md p-1 text-blue-600 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-800 transition-colors"
            aria-label="Dismiss update banner"
          >
            <X size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
