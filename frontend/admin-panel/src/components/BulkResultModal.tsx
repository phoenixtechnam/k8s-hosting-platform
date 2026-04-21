import { X, CheckCircle2, AlertTriangle } from 'lucide-react';

/**
 * Result modal for bulk lifecycle actions (suspend / reactivate /
 * delete). The backend `/admin/clients/bulk` endpoint returns
 * `{ succeeded: string[], failed: [{id, error}] }`. This component
 * renders that summary with a table of failures so operators can see
 * exactly which clients bounced and why.
 */
export interface BulkResult {
  readonly succeeded: readonly string[];
  readonly failed: readonly { readonly id: string; readonly error: string }[];
}

interface BulkResultModalProps {
  readonly result: BulkResult | null;
  readonly action: 'suspend' | 'reactivate' | 'delete';
  readonly onClose: () => void;
}

export default function BulkResultModal({ result, action, onClose }: BulkResultModalProps) {
  if (!result) return null;

  const total = result.succeeded.length + result.failed.length;
  const allOk = result.failed.length === 0;

  return (
    <div
      className="fixed inset-0 z-70 flex items-center justify-center bg-black/50 p-4"
      data-testid="bulk-result-modal"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-lg rounded-xl bg-white dark:bg-gray-800 shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-700 px-5 py-3">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 capitalize">
            Bulk {action} result
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-3">
          <div className={`flex items-center gap-2 text-sm font-medium ${allOk ? 'text-green-700 dark:text-green-300' : 'text-amber-700 dark:text-amber-300'}`}>
            {allOk ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
            <span data-testid="bulk-summary">
              {result.succeeded.length}/{total} succeeded
              {result.failed.length > 0 && ` · ${result.failed.length} failed`}
            </span>
          </div>

          {result.failed.length > 0 && (
            <div className="rounded-md border border-red-200 dark:border-red-800 overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-200">
                  <tr>
                    <th className="px-3 py-2 text-left">Client ID</th>
                    <th className="px-3 py-2 text-left">Error</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-red-100 dark:divide-red-900/40">
                  {result.failed.map((f) => (
                    <tr key={f.id} className="bg-white dark:bg-gray-900">
                      <td className="px-3 py-2 font-mono truncate max-w-[180px]">{f.id}</td>
                      <td className="px-3 py-2 text-red-700 dark:text-red-300 whitespace-pre-wrap">{f.error}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-gray-100 dark:border-gray-700 px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
