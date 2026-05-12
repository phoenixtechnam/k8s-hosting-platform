import { X, ArrowRight, CheckCircle, XCircle, Loader2 } from 'lucide-react';
import { useMailMigrationStatus } from '@/hooks/use-mail-migration';
import type { MailMigrationStatusResponse } from '@k8s-hosting/api-contracts';

const STEP_LABELS: Record<string, string> = {
  preflight: 'Preflight disk check',
  snapshotting: 'Safety snapshot',
  'scaling-down': 'Scaling Stalwart to 0',
  'creating-target-pvc': 'Creating target PVC',
  rsync: 'rsync data transfer',
  verifying: 'Verifying sentinel',
  cutover: 'Cutover (PVC swap)',
  done: 'Complete',
  failed: 'Failed',
  'rolled-back': 'Rolled back',
};

const STEP_ORDER = [
  'preflight',
  'snapshotting',
  'scaling-down',
  'creating-target-pvc',
  'rsync',
  'verifying',
  'cutover',
  'done',
];

function stepIndex(step: string): number {
  return STEP_ORDER.indexOf(step);
}

interface Props {
  readonly runId: string;
  readonly onClose: () => void;
}

export default function MailMigrationProgressModal({ runId, onClose }: Props) {
  const { data, isLoading, isError } = useMailMigrationStatus(runId);
  const status = data?.data;

  const isTerminal = status?.state === 'done' || status?.state === 'failed' || status?.state === 'rolled-back';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="relative w-full max-w-lg bg-white dark:bg-gray-900 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 p-6 space-y-5">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute top-3 right-3 rounded-md p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
        >
          <X size={14} />
        </button>

        <div className="flex items-center gap-3">
          {!isTerminal ? (
            <Loader2 size={20} className="animate-spin text-brand-500" />
          ) : status?.state === 'done' ? (
            <CheckCircle size={20} className="text-green-600" />
          ) : (
            <XCircle size={20} className="text-red-600" />
          )}
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            Mail Storage Migration
          </h3>
        </div>

        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
            <Loader2 size={14} className="animate-spin" /> Loading…
          </div>
        )}

        {isError && (
          <p className="text-sm text-red-700 dark:text-red-300">
            Could not fetch migration status.
          </p>
        )}

        {status && (
          <>
            <div className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 font-mono">
              <span>{status.sourceNode}</span>
              <ArrowRight size={14} className="shrink-0 text-gray-400" />
              <span>{status.targetNode}</span>
            </div>

            <MigrationStepList status={status} />

            {status.progressBytes != null && status.state === 'rsync' && (
              <div className="text-xs text-gray-500 dark:text-gray-400">
                Transferred: {formatBytes(status.progressBytes)}
              </div>
            )}

            {status.error && (
              <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2.5 text-sm text-red-700 dark:text-red-300">
                {status.error}
              </div>
            )}

            <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
              <span>Run ID: <code className="font-mono">{runId.slice(0, 8)}</code></span>
              <span>
                Started {new Date(status.startedAt).toLocaleTimeString()}
                {status.finishedAt ? ` · Finished ${new Date(status.finishedAt).toLocaleTimeString()}` : ''}
              </span>
            </div>
          </>
        )}

        {isTerminal && (
          <div className="flex justify-end">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600"
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function MigrationStepList({ status }: { readonly status: MailMigrationStatusResponse }) {
  const current = status.currentStep ?? status.state;
  const currentIdx = stepIndex(current);
  const isDone = status.state === 'done';
  const isFailed = status.state === 'failed' || status.state === 'rolled-back';

  return (
    <ol className="space-y-1.5">
      {STEP_ORDER.filter(s => s !== 'done').map((step) => {
        const idx = stepIndex(step);
        const isActive = current === step;
        const isPast = isDone || (!isFailed && idx < currentIdx);
        const isCurrent = isActive && !isDone && !isFailed;
        const isFailedStep = isFailed && isActive;

        return (
          <li key={step} className="flex items-center gap-2.5">
            <div className="w-5 h-5 flex items-center justify-center shrink-0">
              {isPast ? (
                <CheckCircle size={16} className="text-green-600" />
              ) : isFailedStep ? (
                <XCircle size={16} className="text-red-500" />
              ) : isCurrent ? (
                <Loader2 size={16} className="animate-spin text-brand-500" />
              ) : (
                <div className="w-3 h-3 rounded-full border-2 border-gray-300 dark:border-gray-600" />
              )}
            </div>
            <span
              className={`text-sm ${
                isCurrent
                  ? 'font-medium text-gray-900 dark:text-gray-100'
                  : isPast
                  ? 'text-gray-500 dark:text-gray-500 line-through'
                  : 'text-gray-400 dark:text-gray-600'
              }`}
            >
              {STEP_LABELS[step] ?? step}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function formatBytes(b: number): string {
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GiB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(2)} MiB`;
  if (b >= 1024) return `${(b / 1024).toFixed(2)} KiB`;
  return `${b} B`;
}
