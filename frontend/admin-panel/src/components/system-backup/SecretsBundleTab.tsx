/**
 * Secrets Bundle tab inside System Backup.
 *
 * UX:
 *   1. Manifest panel — read-only inventory of which Secrets/ConfigMaps
 *      will be included; surfaces operator-recipient (age public key)
 *      so the operator can pre-confirm against their stored key.
 *   2. Export panel — single button. On success, opens a download
 *      modal with the one-shot URL (15-min TTL). The URL is
 *      single-use; once clicked, it cannot be reused.
 *   3. History panel — recent runs with status, sha256, size, who.
 */

import { useEffect, useState } from 'react';
import { Download, RefreshCw, KeyRound, Lock, AlertCircle, FileLock2, Clock } from 'lucide-react';
import {
  useSecretsBundleManifest,
  useSecretsBundleRuns,
  useSecretsBundleRun,
  useTriggerSecretsBundleExport,
} from '@/hooks/use-system-backup';

export default function SecretsBundleTab() {
  const manifestQ = useSecretsBundleManifest();
  const runsQ = useSecretsBundleRuns();
  const trigger = useTriggerSecretsBundleExport();
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const runQ = useSecretsBundleRun(activeRunId);

  // Auto-clear the active run id once the modal closes or the run
  // becomes terminal AND the URL has been surfaced. We don't auto-clear
  // the moment the run hits succeeded — the operator needs the URL.
  useEffect(() => {
    if (!activeRunId) return;
    const status = runQ.data?.status;
    if (status === 'failed') {
      // Failure: leave the modal open so the operator sees the error.
    }
  }, [activeRunId, runQ.data?.status]);

  const onExport = (): void => {
    const reason = window.prompt(
      'Optional reason for the audit log (e.g. "Pre-upgrade snapshot", "DR drill"):',
      '',
    );
    // null = operator cancelled the prompt; abort the export.
    if (reason === null) return;
    // Wrap mutateAsync so the rejection lands on `trigger.error`
    // (rendered by ExportPanel) instead of surfacing as an
    // UnhandledPromiseRejection.
    void (async () => {
      try {
        const result = await trigger.mutateAsync({ reason: reason || undefined });
        setActiveRunId(result.runId);
      } catch {
        // useMutation owns trigger.error — nothing more to do here.
      }
    })();
  };

  return (
    <div className="space-y-6">
      <SecurityCallout />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <ManifestPanel
          loading={manifestQ.isLoading}
          error={manifestQ.error as Error | undefined}
          items={manifestQ.data?.items ?? []}
          recipient={manifestQ.data?.operatorRecipient ?? null}
        />
        <ExportPanel
          onExport={onExport}
          isExporting={trigger.isPending || runQ.data?.status === 'running' || runQ.data?.status === 'pending'}
          lastError={trigger.error as Error | undefined}
          recipient={manifestQ.data?.operatorRecipient ?? null}
        />
      </div>

      <RunsHistoryPanel runs={runsQ.data ?? []} loading={runsQ.isLoading} onSelectRun={setActiveRunId} />

      {activeRunId && runQ.data && (
        <DownloadModal
          run={runQ.data}
          onClose={() => setActiveRunId(null)}
        />
      )}
    </div>
  );
}

function SecurityCallout() {
  return (
    <div className="rounded-xl border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/10 p-4">
      <div className="flex items-start gap-3">
        <Lock size={20} className="text-amber-700 dark:text-amber-400 flex-shrink-0 mt-0.5" />
        <div className="text-sm text-gray-800 dark:text-gray-200 space-y-1">
          <p className="font-semibold">This bundle decrypts to every Tier-1 platform secret.</p>
          <p>
            The download URL is single-use, age-encrypted to the operator recipient, and expires in
            15 minutes. Without the operator's age private key (held off-cluster), the bundle is
            useless. Store decrypted bundles only on encrypted media. Every export is audit-logged.
          </p>
        </div>
      </div>
    </div>
  );
}

interface ManifestPanelProps {
  loading: boolean;
  error: Error | undefined;
  items: ReadonlyArray<{ namespace: string; name: string; kind: 'Secret' | 'ConfigMap' | 'OperatorKey'; present: boolean }>;
  recipient: string | null;
}

function ManifestPanel({ loading, error, items, recipient }: ManifestPanelProps) {
  return (
    <section className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 space-y-4">
      <h2 className="flex items-center gap-2 text-base font-semibold text-gray-900 dark:text-gray-100">
        <FileLock2 size={18} className="text-gray-500" />
        Bundle Inventory
      </h2>

      {loading && <div className="text-sm text-gray-500 dark:text-gray-400 flex items-center gap-2"><RefreshCw size={14} className="animate-spin" /> Loading…</div>}
      {error && (
        <div className="text-sm text-red-700 dark:text-red-300 flex items-center gap-2">
          <AlertCircle size={14} /> {error.message}
        </div>
      )}

      {!loading && !error && (
        <>
          <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 p-3 text-xs">
            <div className="text-gray-500 dark:text-gray-400 mb-1 flex items-center gap-1">
              <KeyRound size={12} /> Operator recipient (age public key)
            </div>
            <code className="font-mono text-gray-900 dark:text-gray-100 break-all">
              {recipient ?? <span className="text-amber-600 dark:text-amber-400">(missing — bootstrap has not run)</span>}
            </code>
          </div>

          <ul className="space-y-1 text-sm" data-testid="bundle-manifest-list">
            {items.map((it) => (
              <li
                key={`${it.namespace}/${it.name}`}
                className="flex items-center justify-between font-mono text-xs px-2 py-1 rounded hover:bg-gray-50 dark:hover:bg-gray-900/30"
              >
                <span className={it.present ? 'text-gray-900 dark:text-gray-100' : 'text-gray-400 dark:text-gray-600 line-through'}>
                  {it.namespace}/{it.name}
                </span>
                <span className="text-xs text-gray-500 dark:text-gray-400 ml-2">
                  {it.kind}{it.present ? '' : ' (absent)'}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Absent items are skipped; the bundle stays small. Re-running bootstrap or applying the
            secret manifest creates them.
          </p>
        </>
      )}
    </section>
  );
}

interface ExportPanelProps {
  onExport: () => void;
  isExporting: boolean;
  lastError: Error | undefined;
  recipient: string | null;
}

function ExportPanel({ onExport, isExporting, lastError, recipient }: ExportPanelProps) {
  const blocked = !recipient;
  return (
    <section className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 space-y-4">
      <h2 className="flex items-center gap-2 text-base font-semibold text-gray-900 dark:text-gray-100">
        <Download size={18} className="text-gray-500" />
        Export Now
      </h2>

      <p className="text-sm text-gray-600 dark:text-gray-400">
        Triggers an in-cluster build of an age-encrypted Tier-1 secrets bundle. The download URL is
        returned immediately (≤30s typically) and is valid for 15 minutes, single-use.
      </p>

      <button
        onClick={onExport}
        disabled={isExporting || blocked}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-brand-600 text-white text-sm font-medium hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed"
        data-testid="export-secrets-bundle-button"
      >
        {isExporting ? <RefreshCw size={14} className="animate-spin" /> : <Download size={14} />}
        {isExporting ? 'Exporting…' : 'Export Bundle'}
      </button>

      {blocked && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          Operator recipient is missing — re-run bootstrap or kubectl-create the
          platform-operator-recipient ConfigMap.
        </p>
      )}
      {lastError && (
        <div className="text-sm text-red-700 dark:text-red-300 flex items-center gap-2">
          <AlertCircle size={14} /> {lastError.message}
        </div>
      )}
    </section>
  );
}

interface RunsHistoryPanelProps {
  runs: ReadonlyArray<{
    id: string;
    status: string;
    startedAt: string;
    finishedAt: string | null;
    sizeBytes: number | null;
    sha256: string | null;
    operatorUserId: string | null;
    downloadedAt: string | null;
  }>;
  loading: boolean;
  onSelectRun: (id: string) => void;
}

function RunsHistoryPanel({ runs, loading, onSelectRun }: RunsHistoryPanelProps) {
  return (
    <section className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-base font-semibold text-gray-900 dark:text-gray-100">
          <Clock size={18} className="text-gray-500" />
          Recent Exports
        </h2>
        <span className="text-xs text-gray-500 dark:text-gray-400">{runs.length} total</span>
      </div>

      {loading && <div className="text-sm text-gray-500 dark:text-gray-400">Loading…</div>}
      {!loading && runs.length === 0 && (
        <div className="text-sm text-gray-500 dark:text-gray-400">No exports yet.</div>
      )}

      {!loading && runs.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
          <table className="min-w-full text-sm" data-testid="runs-history-table">
            <thead className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-900/40">
              <tr>
                <th className="text-left px-3 py-2">Started</th>
                <th className="text-left px-3 py-2">Status</th>
                <th className="text-left px-3 py-2">Size</th>
                <th className="text-left px-3 py-2 hidden md:table-cell">SHA256</th>
                <th className="text-left px-3 py-2">Downloaded</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {runs.map((r) => (
                <tr key={r.id}>
                  <td className="px-3 py-2 text-gray-700 dark:text-gray-300">
                    {new Date(r.startedAt).toLocaleString()}
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-gray-700 dark:text-gray-300">
                    {r.sizeBytes !== null ? `${r.sizeBytes} B` : '—'}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-gray-500 dark:text-gray-400 hidden md:table-cell">
                    {r.sha256 ? `${r.sha256.slice(0, 12)}…` : '—'}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">
                    {r.downloadedAt ? new Date(r.downloadedAt).toLocaleString() : '(not yet)'}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {r.status === 'succeeded' && !r.downloadedAt && (
                      <button
                        onClick={() => onSelectRun(r.id)}
                        className="text-xs text-brand-600 dark:text-brand-400 hover:underline"
                      >
                        Open
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    succeeded: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
    failed: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
    running: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
    pending: 'bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-300',
  };
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${map[status] ?? map.pending}`}>
      {status}
    </span>
  );
}

interface DownloadModalProps {
  run: {
    id: string;
    status: string;
    sizeBytes: number | null;
    sha256: string | null;
    downloadUrl: string | null;
    downloadUrlExpiresAt: string | null;
    downloadedAt: string | null;
    errorEnvelope: unknown;
  };
  onClose: () => void;
}

function DownloadModal({ run, onClose }: DownloadModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-full max-w-lg"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        data-testid="download-modal"
      >
        <div className="border-b border-gray-200 dark:border-gray-700 px-5 py-3 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
            <Download size={18} /> Secrets Bundle Export
          </h3>
          <button onClick={onClose} aria-label="Close" className="text-gray-500 hover:text-gray-700">×</button>
        </div>

        <div className="px-5 py-4 space-y-3">
          {run.status === 'pending' && <p className="text-sm text-gray-600 dark:text-gray-400">Queued…</p>}
          {run.status === 'running' && (
            <p className="text-sm text-gray-600 dark:text-gray-400 flex items-center gap-2">
              <RefreshCw size={14} className="animate-spin" /> Building bundle in-cluster…
            </p>
          )}
          {run.status === 'succeeded' && run.downloadUrl && (
            <>
              <div className="text-sm text-gray-700 dark:text-gray-300">
                <strong>Bundle ready.</strong> {run.sizeBytes} bytes · sha256{' '}
                <code className="font-mono text-xs">{run.sha256?.slice(0, 16)}…</code>
              </div>
              <a
                href={run.downloadUrl}
                download
                onClick={() => {
                  // The server marks downloaded_at on first GET; close
                  // the modal to avoid the operator clicking again
                  // (which would 410 since the token is consumed).
                  setTimeout(onClose, 500);
                }}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-brand-600 text-white text-sm font-medium hover:bg-brand-700"
                data-testid="download-bundle-link"
              >
                <Download size={14} /> Download .tar.age (single use)
              </a>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Expires: {run.downloadUrlExpiresAt ? new Date(run.downloadUrlExpiresAt).toLocaleString() : '?'}.
                Decrypt with <code className="font-mono">age -d -i operator-private.key &lt; bundle.tar.age | tar xv</code>.
                Restore with <code className="font-mono">make secrets-restore BUNDLE=… KEY=…</code> or
                <code className="font-mono"> bootstrap.sh --secrets-bundle …</code> (Phase 1.4).
              </p>
            </>
          )}
          {run.status === 'succeeded' && !run.downloadUrl && (
            <p className="text-sm text-amber-700 dark:text-amber-400">
              This bundle has already been downloaded or its URL has expired. Trigger a new export
              if you need a fresh copy.
            </p>
          )}
          {run.status === 'failed' && (
            <div className="rounded-lg border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-900 dark:text-red-200">
              <strong>Export failed.</strong> {String((run.errorEnvelope as { message?: string } | null)?.message ?? '(no detail)')}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
