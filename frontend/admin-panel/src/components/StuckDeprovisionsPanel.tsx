import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, RefreshCw, X, AlertOctagon } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';

/**
 * Stuck-Deprovisions admin panel.
 *
 * Lists tenant namespaces stuck in Terminating phase >1h. Each row
 * shows the namespace, how long it's been stuck, and a "Force-clear"
 * button that opens a destructive-action modal requiring the operator
 * to retype the namespace name. The backend POST
 * /admin/stuck-deprovisions/:namespace/force-clear runs:
 *   1. replaceNamespaceFinalize patches finalizers=[] via /finalize
 *   2. Force-deletes orphan PVs whose claimRef matches the ns
 *   3. Force-deletes Longhorn volumes for those PVs (skipped for
 *      non-Longhorn PVs)
 *   4. Sticky admin notification + audit_logs
 *
 * Refreshes every 60 s. Reload after force-clear so the row drops
 * out as soon as the namespace finishes Terminating.
 */

interface StuckRow {
  readonly name: string;
  readonly deletionTimestamp: string | null;
  readonly finalizers: ReadonlyArray<string>;
  readonly clientId: string | null;
  readonly stuckForMs: number;
}

function useStuckDeprovisions() {
  return useQuery({
    queryKey: ['stuck-deprovisions'],
    queryFn: () => apiFetch<{ data: StuckRow[] }>('/api/v1/admin/stuck-deprovisions'),
    refetchInterval: 60_000,
  });
}

function useForceClearNamespace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { namespace: string }) =>
      apiFetch<{ data: { namespace: string; ageMs: number; ops: string[] } }>(
        `/api/v1/admin/stuck-deprovisions/${input.namespace}/force-clear`,
        { method: 'POST', body: JSON.stringify({ confirmName: input.namespace }) },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['stuck-deprovisions'] }),
  });
}

function fmtAge(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m`;
  return `${Math.floor(hr / 24)}d ${hr % 24}h`;
}

export default function StuckDeprovisionsPanel() {
  const { data, isLoading, error, refetch } = useStuckDeprovisions();
  const [confirming, setConfirming] = useState<StuckRow | null>(null);

  if (isLoading) {
    return (
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm">
        <div className="text-gray-500 dark:text-gray-400 flex items-center gap-2">
          <RefreshCw size={14} className="animate-spin" />
          Loading stuck deprovisions…
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-xl border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 p-5">
        <div className="text-sm text-red-800 dark:text-red-200 flex items-center gap-2">
          <AlertTriangle size={14} />
          Failed to load stuck deprovisions —{' '}
          <button onClick={() => refetch()} className="underline">retry</button>
        </div>
      </div>
    );
  }

  const rows = data?.data ?? [];

  if (rows.length === 0) {
    // Hide the panel entirely when nothing is stuck — operators don't
    // need a "0 stuck" indicator cluttering the page.
    return null;
  }

  return (
    <div
      className="rounded-xl border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/10 p-5 space-y-3"
      data-testid="stuck-deprovisions-panel"
    >
      <div className="flex items-center gap-3">
        <AlertOctagon size={20} className="text-amber-700 dark:text-amber-400" />
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          Stuck Deprovisions ({rows.length})
        </h2>
      </div>
      <p className="text-sm text-gray-700 dark:text-gray-300">
        These tenant namespaces have been Terminating for over 1 hour. Most likely a finalizer is
        blocking termination — usually an orphan Longhorn volume or PV that didn't reclaim cleanly.
        Force-clear runs the destructive cleanup path: finalizers=[] via /finalize subresource,
        then force-deletes orphan PVs + Longhorn volumes. <strong>super_admin only</strong>;
        confirmation required.
      </p>

      <div className="overflow-x-auto rounded-lg border border-amber-200 dark:border-amber-800 bg-white dark:bg-gray-800">
        <table className="min-w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-900/50">
            <tr>
              <th className="text-left px-3 py-2">Namespace</th>
              <th className="text-left px-3 py-2">Stuck for</th>
              <th className="text-left px-3 py-2">Finalizers</th>
              <th className="text-right px-3 py-2">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-amber-100 dark:divide-amber-900/50">
            {rows.map((r) => (
              <tr key={r.name}>
                <td className="px-3 py-2 font-mono text-gray-900 dark:text-gray-100">{r.name}</td>
                <td className="px-3 py-2 text-gray-700 dark:text-gray-300">{fmtAge(r.stuckForMs)}</td>
                <td className="px-3 py-2 font-mono text-xs text-gray-500 dark:text-gray-400">
                  {r.finalizers.length === 0 ? '(none)' : r.finalizers.join(', ')}
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    onClick={() => setConfirming(r)}
                    className="px-3 py-1.5 rounded-lg bg-red-600 text-white text-xs font-medium hover:bg-red-700"
                  >
                    Force-clear
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {confirming && (
        <ConfirmForceClearModal row={confirming} onClose={() => setConfirming(null)} />
      )}
    </div>
  );
}

function ConfirmForceClearModal({ row, onClose }: { row: StuckRow; onClose: () => void }) {
  const [typed, setTyped] = useState('');
  const [result, setResult] = useState<{ ops: string[]; ageMs: number } | null>(null);
  const force = useForceClearNamespace();
  const canConfirm = typed === row.name && !force.isPending && !result;

  const onSubmit = async () => {
    if (!canConfirm) return;
    try {
      const resp = await force.mutateAsync({ namespace: row.name });
      setResult({ ops: resp.data.ops, ageMs: resp.data.ageMs });
    } catch {
      // useMutation surfaces the error; just leave the modal open.
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        data-testid="confirm-force-clear-modal"
      >
        <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 px-5 py-3">
          <h3 className="text-lg font-semibold text-red-700 dark:text-red-400 flex items-center gap-2">
            <AlertOctagon size={18} /> Force-clear namespace
          </h3>
          <button onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>

        {!result && (
          <div className="px-5 py-4 space-y-3">
            <div className="rounded-lg border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-900 dark:text-red-200">
              <strong>This is destructive.</strong> Proceeds in three steps:
              <ol className="list-decimal pl-5 mt-1 text-xs">
                <li>Patch <code>metadata.finalizers</code> to <code>[]</code> via /finalize</li>
                <li>Force-delete every PV with <code>claimRef.namespace == {row.name}</code></li>
                <li>Force-delete the matching Longhorn volume CRs (Longhorn-provisioned only)</li>
              </ol>
            </div>
            <div className="text-sm text-gray-700 dark:text-gray-300">
              Type <strong className="font-mono">{row.name}</strong> to confirm:
            </div>
            <input
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoFocus
              autoComplete="off"
              className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 font-mono text-sm"
              placeholder={row.name}
            />
            {force.isError && (
              <div className="text-xs text-red-700 dark:text-red-400">
                {(force.error as Error).message}
              </div>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={onClose}
                className="px-3 py-1.5 rounded-lg text-sm bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-gray-100"
              >
                Cancel
              </button>
              <button
                onClick={onSubmit}
                disabled={!canConfirm}
                className="px-3 py-1.5 rounded-lg text-sm bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {force.isPending ? 'Clearing…' : 'Force-clear'}
              </button>
            </div>
          </div>
        )}

        {result && (
          <div className="px-5 py-4 space-y-3">
            <div className="text-sm text-gray-700 dark:text-gray-300">
              Force-clear complete after {fmtAge(result.ageMs)} stuck. Steps:
            </div>
            <ul className="list-disc pl-5 text-xs space-y-1 text-gray-600 dark:text-gray-400">
              {result.ops.map((op, i) => (
                <li key={i} className="font-mono">{op}</li>
              ))}
            </ul>
            <div className="flex justify-end pt-2">
              <button
                onClick={onClose}
                className="px-3 py-1.5 rounded-lg text-sm bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-gray-100"
              >
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
