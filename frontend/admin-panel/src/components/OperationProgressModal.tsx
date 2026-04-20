import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, CheckCircle2, AlertTriangle, X } from 'lucide-react';
import clsx from 'clsx';
import { apiFetch } from '@/lib/api-client';

/**
 * Shared progress modal for lifecycle & storage operations.
 *
 * Polls `/api/v1/admin/storage/operations/:opId` every 1.5s. Renders a
 * stepwise progress bar with the current state + message and an error
 * banner with remediation when the op fails. Close button is disabled
 * until the op reaches a terminal state (idle / failed).
 *
 * Used by resize, suspend, resume, archive, restore, snapshot, and any
 * storage-lifecycle op that writes to `storage_operations`.
 */

interface StorageOperationResponse {
  readonly data: {
    readonly id: string;
    readonly opType: string;
    readonly state:
      | 'idle'
      | 'snapshotting'
      | 'quiescing'
      | 'resizing'
      | 'replacing'
      | 'restoring'
      | 'unquiescing'
      | 'archiving'
      | 'failed';
    readonly progressPct: number;
    readonly progressMessage: string | null;
    readonly lastError: string | null;
    readonly completedAt: string | null;
  };
}

interface OperationProgressModalProps {
  readonly operationId: string | null;
  readonly title?: string;
  readonly onClose: () => void;
}

export default function OperationProgressModal({ operationId, title, onClose }: OperationProgressModalProps) {
  const { data, error } = useQuery<StorageOperationResponse, Error>({
    queryKey: ['operation-progress', operationId],
    queryFn: () => apiFetch(`/api/v1/admin/storage/operations/${operationId}`),
    enabled: operationId !== null,
    refetchInterval: (q) => {
      const s = q.state.data?.data.state;
      if (!s) return 1500;
      return s === 'idle' || s === 'failed' ? false : 1500;
    },
  });

  const op = data?.data;
  const isTerminal = op && (op.state === 'idle' || op.state === 'failed');
  const isFailure = op?.state === 'failed';

  // Track whether the user has already dismissed so we don't re-open
  // on late polls. Reset whenever operationId changes.
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => { setDismissed(false); }, [operationId]);

  if (!operationId || dismissed) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      data-testid="operation-progress-modal"
      onClick={(e) => { if (e.target === e.currentTarget && isTerminal) { setDismissed(true); onClose(); } }}
    >
      <div className="w-full max-w-lg rounded-xl bg-white dark:bg-gray-800 shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-700 px-5 py-3">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {title ?? (op ? `${op.opType.replace(/_/g, ' ')} operation` : 'Operation in progress')}
          </h3>
          <button
            onClick={() => { if (isTerminal) { setDismissed(true); onClose(); } }}
            disabled={!isTerminal}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-30 disabled:cursor-not-allowed"
            data-testid="operation-progress-close"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-3">
          {error && !op && (
            <div className="rounded-md bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-800 dark:text-red-200" data-testid="operation-progress-error">
              Could not load operation status: {error.message}
            </div>
          )}

          {op && (
            <>
              <div className="flex items-center gap-2 text-sm">
                {isFailure ? (
                  <AlertTriangle size={18} className="text-red-500" />
                ) : isTerminal ? (
                  <CheckCircle2 size={18} className="text-green-500" />
                ) : (
                  <Loader2 size={18} className="animate-spin text-blue-500" />
                )}
                <span className={clsx(
                  'font-medium capitalize',
                  isFailure ? 'text-red-700 dark:text-red-300' :
                  isTerminal ? 'text-green-700 dark:text-green-300' :
                  'text-gray-900 dark:text-gray-100',
                )}>
                  {op.state}
                </span>
                <span className="ml-auto text-xs font-mono text-gray-500 dark:text-gray-400">
                  {op.progressPct}%
                </span>
              </div>

              <div className="h-2 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700">
                <div
                  className={clsx(
                    'h-full transition-all duration-300',
                    isFailure ? 'bg-red-500' : isTerminal ? 'bg-green-500' : 'bg-blue-500',
                  )}
                  style={{ width: `${op.progressPct}%` }}
                  role="progressbar"
                  aria-valuenow={op.progressPct}
                  aria-valuemin={0}
                  aria-valuemax={100}
                />
              </div>

              {op.progressMessage && (
                <p className="text-sm text-gray-600 dark:text-gray-300">{op.progressMessage}</p>
              )}

              {op.lastError && (
                <div className="rounded-md bg-red-50 dark:bg-red-900/20 p-3 text-sm" data-testid="operation-progress-last-error">
                  <p className="font-medium text-red-800 dark:text-red-200">Operation failed</p>
                  <p className="mt-1 text-xs text-red-700 dark:text-red-300 whitespace-pre-wrap">{op.lastError}</p>
                </div>
              )}

              {isTerminal && !isFailure && (
                <p className="text-xs text-gray-500 dark:text-gray-400">Completed at {op.completedAt ? new Date(op.completedAt).toLocaleString() : 'just now'}</p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
