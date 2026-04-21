import { useEffect, useRef } from 'react';
import { X, CheckCircle2, XCircle, Loader2, Circle, AlertTriangle, Trash2, RefreshCw } from 'lucide-react';
import { useProvisioningStatus } from '@/hooks/use-provisioning';
import type { ProvisioningStep } from '@/hooks/use-provisioning';

interface ProvisioningProgressModalProps {
  readonly clientId: string;
  readonly clientName: string;
  readonly onClose: () => void;
  /** Called once when the task reaches `completed`. Use to navigate away. */
  readonly onSuccess?: () => void;
  /** If provided, a "Remove artifacts" button appears on failure. */
  readonly onCleanup?: () => void;
  /** If provided, a "Retry" button appears on failure. */
  readonly onRetry?: () => void;
  readonly isCleaningUp?: boolean;
  readonly isRetrying?: boolean;
}

const stepIcons: Record<ProvisioningStep['status'], React.ReactNode> = {
  pending: <Circle size={16} className="text-gray-300 dark:text-gray-600" />,
  running: <Loader2 size={16} className="animate-spin text-brand-500" />,
  completed: <CheckCircle2 size={16} className="text-emerald-500" />,
  failed: <XCircle size={16} className="text-red-500" />,
  skipped: <Circle size={16} className="text-gray-400 dark:text-gray-500" />,
};

export default function ProvisioningProgressModal({
  clientId,
  clientName,
  onClose,
  onSuccess,
  onCleanup,
  onRetry,
  isCleaningUp = false,
  isRetrying = false,
}: ProvisioningProgressModalProps) {
  const { data: task, isLoading, error } = useProvisioningStatus(clientId);

  // Stop polling once completed or failed
  const isTerminal = task?.status === 'completed' || task?.status === 'failed';
  const isSuccess = task?.status === 'completed';
  const isFailed = task?.status === 'failed';

  // Fire onSuccess exactly once when the task transitions to completed.
  // Without the ref, React Query re-renders on cache touches could fire it
  // repeatedly and cause navigation loops.
  const successFiredRef = useRef(false);
  useEffect(() => {
    if (isSuccess && !successFiredRef.current && onSuccess) {
      successFiredRef.current = true;
      // Small delay so the 5th green checkmark is visible before we navigate.
      const t = setTimeout(onSuccess, 800);
      return () => clearTimeout(t);
    }
  }, [isSuccess, onSuccess]);

  // Close on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const progressPct = task && task.totalSteps > 0
    ? Math.round((task.completedSteps / task.totalSteps) * 100)
    : 0;

  return (
    <div
      className="fixed inset-0 z-60 flex items-center justify-center bg-black/50"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      data-testid="provisioning-modal-backdrop"
    >
      <div className="w-full max-w-lg rounded-2xl bg-white shadow-xl dark:bg-gray-800" data-testid="provisioning-modal">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4 dark:border-gray-700">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Provisioning: {clientName}
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {task?.status === 'completed'
                ? 'Provisioning complete'
                : task?.status === 'failed'
                  ? 'Provisioning failed'
                  : 'Setting up Kubernetes resources...'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
            data-testid="provisioning-modal-close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Progress bar */}
        <div className="px-6 pt-4">
          <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
            <span>{task?.completedSteps ?? 0} of {task?.totalSteps ?? 0} steps</span>
            <span>{progressPct}%</span>
          </div>
          <div className="mt-1 h-2 w-full rounded-full bg-gray-200 dark:bg-gray-600">
            <div
              className={`h-2 rounded-full transition-all duration-500 ${
                task?.status === 'failed' ? 'bg-red-500' : task?.status === 'completed' ? 'bg-emerald-500' : 'bg-brand-500'
              }`}
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>

        {/* Steps */}
        <div className="px-6 py-4">
          {isLoading && !task && (
            <div className="flex items-center justify-center py-8">
              <Loader2 size={24} className="animate-spin text-brand-500" />
            </div>
          )}

          {error && !task && (
            <div className="flex items-center gap-2 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
              <AlertTriangle size={16} />
              No provisioning task found for this client.
            </div>
          )}

          {task?.stepsLog && (
            <div className="space-y-3">
              {task.stepsLog.map((step) => (
                <div key={step.name} className="flex items-start gap-3" data-testid={`step-${step.name.toLowerCase().replace(/\s+/g, '-')}`}>
                  <div className="mt-0.5">{stepIcons[step.status]}</div>
                  <div className="flex-1">
                    <p className={`text-sm font-medium ${
                      step.status === 'completed' ? 'text-gray-900 dark:text-gray-100' :
                      step.status === 'running' ? 'text-brand-700 dark:text-brand-300' :
                      step.status === 'failed' ? 'text-red-700 dark:text-red-400' :
                      'text-gray-400 dark:text-gray-500'
                    }`}>
                      {step.name}
                    </p>
                    {step.error && (
                      <p className="mt-0.5 text-xs text-red-600 dark:text-red-400">{step.error}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Error message */}
        {task?.errorMessage && (
          <div className="mx-6 mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-400" data-testid="provisioning-error">
            {task.errorMessage}
          </div>
        )}

        {/* Footer */}
        <div className="flex flex-wrap justify-end gap-2 border-t border-gray-200 px-6 py-4 dark:border-gray-700">
          {isFailed && onCleanup && (
            <button
              onClick={onCleanup}
              disabled={isCleaningUp || isRetrying}
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-700 dark:bg-gray-800 dark:text-red-400 dark:hover:bg-red-900/20"
              data-testid="provisioning-modal-cleanup"
            >
              {isCleaningUp ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
              Remove artifacts
            </button>
          )}
          {isFailed && onRetry && (
            <button
              onClick={onRetry}
              disabled={isRetrying || isCleaningUp}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
              data-testid="provisioning-modal-retry"
            >
              {isRetrying ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              Retry
            </button>
          )}
          {isSuccess ? (
            <button
              onClick={onClose}
              className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600"
              data-testid="provisioning-modal-done"
            >
              Done
            </button>
          ) : isTerminal ? (
            <button
              onClick={onClose}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
              data-testid="provisioning-modal-close-failed"
            >
              Close
            </button>
          ) : (
            <button
              onClick={onClose}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
              data-testid="provisioning-modal-minimize"
            >
              Minimize
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
