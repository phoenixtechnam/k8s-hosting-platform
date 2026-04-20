import { useState, useEffect } from 'react';
import { Loader2, X, AlertTriangle } from 'lucide-react';
import { useResizeDryRun, useResizeClient, type ResizeDryRun } from '@/hooks/use-storage-lifecycle';

/**
 * Resize storage modal — replaces the legacy `prompt()` + `confirm()`
 * flow. Input is in MB (user-visible), converted to MiB for the API.
 *
 * Flow:
 *   1. User types new size in MB.
 *   2. Dry-run fires on input blur (debounced) or "Check" button.
 *   3. If willFit → green summary + Confirm button enabled.
 *   4. If not → red reject-reason banner, Confirm disabled.
 *   5. Confirm → POST /resize, close modal, parent opens
 *      OperationProgressModal keyed on the returned operationId.
 */

interface ResizeStorageModalProps {
  readonly clientId: string;
  readonly open: boolean;
  readonly initialMib: number;
  readonly onClose: () => void;
  readonly onStarted: (operationId: string) => void;
}

export default function ResizeStorageModal({ clientId, open, initialMib, onClose, onStarted }: ResizeStorageModalProps) {
  // Display in MB (1 MB here = 1 MiB for resize purposes). Users type
  // plain numbers; we pass that as newMib.
  const [mibStr, setMibStr] = useState(String(initialMib));
  const [dryRun, setDryRun] = useState<ResizeDryRun | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const dry = useResizeDryRun();
  const resize = useResizeClient();

  useEffect(() => {
    if (open) {
      setMibStr(String(initialMib));
      setDryRun(null);
      setApiError(null);
    }
  }, [open, initialMib]);

  if (!open) return null;

  const parsedMib = Number.parseInt(mibStr, 10);
  const mibIsValid = Number.isFinite(parsedMib) && parsedMib >= 100 && parsedMib <= 10_000_000;

  const runCheck = async () => {
    if (!mibIsValid) return;
    setApiError(null);
    try {
      const res = await dry.mutateAsync({ clientId, newMib: parsedMib });
      setDryRun(res.data);
    } catch (err) {
      setApiError(err instanceof Error ? err.message : String(err));
    }
  };

  const runResize = async () => {
    if (!dryRun || !dryRun.willFit) return;
    setApiError(null);
    try {
      const res = await resize.mutateAsync({ clientId, newMib: parsedMib });
      onStarted(res.data.operationId);
      onClose();
    } catch (err) {
      setApiError(err instanceof Error ? err.message : String(err));
    }
  };

  const formatBytes = (b: number): string => {
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KiB`;
    if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MiB`;
    return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      data-testid="resize-storage-modal"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-lg rounded-xl bg-white dark:bg-gray-800 shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-700 px-5 py-3">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Resize storage</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div>
            <label htmlFor="new-mib" className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
              New size (MiB) <span className="font-normal text-gray-500 dark:text-gray-400">— 1024 MiB = 1 GiB</span>
            </label>
            <div className="flex items-center gap-2">
              <input
                id="new-mib"
                type="number"
                min={100}
                max={10_000_000}
                step={100}
                value={mibStr}
                onChange={(e) => { setMibStr(e.target.value); setDryRun(null); }}
                onBlur={runCheck}
                className="flex-1 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm font-mono"
                placeholder="e.g. 5120 for 5 GiB"
                data-testid="resize-size-input"
              />
              <button
                type="button"
                onClick={runCheck}
                disabled={!mibIsValid || dry.isPending}
                className="rounded-md bg-gray-100 dark:bg-gray-700 px-3 py-2 text-sm hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-50"
                data-testid="resize-check-button"
              >
                {dry.isPending ? <Loader2 size={14} className="animate-spin" /> : 'Check'}
              </button>
            </div>
            {!mibIsValid && mibStr.length > 0 && (
              <p className="mt-1 text-xs text-red-500">Size must be between 100 MB and 10 TB (10,000,000 MB)</p>
            )}
          </div>

          {apiError && (
            <div className="rounded-md bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-800 dark:text-red-200" data-testid="resize-api-error">
              {apiError}
            </div>
          )}

          {dryRun && (
            <div
              className={clsxJoin(
                'rounded-md p-3 text-sm',
                dryRun.willFit
                  ? 'bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-200'
                  : 'bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-200',
              )}
              data-testid="resize-dry-run"
            >
              <div className="flex items-start gap-2">
                {!dryRun.willFit && <AlertTriangle size={16} className="shrink-0 mt-0.5" />}
                <div>
                  <p className="font-medium">
                    {dryRun.willFit ? 'Resize will succeed' : 'Resize cannot proceed'}
                  </p>
                  <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs font-mono">
                    <dt className="text-gray-500 dark:text-gray-400">Current</dt>
                    <dd>{dryRun.currentMib} MiB</dd>
                    <dt className="text-gray-500 dark:text-gray-400">Target</dt>
                    <dd>{dryRun.requestedMib} MiB</dd>
                    <dt className="text-gray-500 dark:text-gray-400">Used</dt>
                    <dd>{formatBytes(dryRun.usedBytes)}</dd>
                    <dt className="text-gray-500 dark:text-gray-400">Est. duration</dt>
                    <dd>~{dryRun.estimatedSeconds}s</dd>
                  </dl>
                  {!dryRun.willFit && dryRun.rejectReason && (
                    <p className="mt-2 text-xs">{dryRun.rejectReason}</p>
                  )}
                  {dryRun.willFit && (
                    <p className="mt-2 text-xs text-gray-600 dark:text-gray-300">
                      Workloads will briefly scale to 0 during the resize — expect ~{dryRun.estimatedSeconds}s of downtime.
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-gray-100 dark:border-gray-700 px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
          <button
            onClick={runResize}
            disabled={!dryRun || !dryRun.willFit || resize.isPending}
            className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="resize-confirm-button"
          >
            {resize.isPending ? <Loader2 size={14} className="animate-spin inline" /> : 'Resize'}
          </button>
        </div>
      </div>
    </div>
  );
}

function clsxJoin(...xs: (string | false | null | undefined)[]): string {
  return xs.filter(Boolean).join(' ');
}
