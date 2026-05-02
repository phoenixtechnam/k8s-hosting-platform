import { useState } from 'react';
import { Package, Plus, Trash2, ShieldCheck, Loader2, AlertCircle, CheckCircle, X, Database, KeyRound, FolderOpen } from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';
import {
  useBundles,
  useCreateBundle,
  useDeleteBundle,
  useVerifyBundle,
} from '@/hooks/use-backup-bundles';
import { useClients } from '@/hooks/use-clients';
import type {
  BundleSummary,
  BackupConfigResponse,
  VerifyBundleResponse,
} from '@k8s-hosting/api-contracts';
import { formatBytes } from '@/hooks/use-platform-storage';

const INPUT_CLASS =
  'w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-700';

interface Props {
  /** Backup configurations passed in from the parent BackupSettings page. */
  readonly configs: readonly BackupConfigResponse[];
}

/**
 * Tenant Bundles (backups-v2 / ADR-032).
 *
 * Operator-facing surface for the new component-oriented backup format.
 * Bundles live OFF-CLUSTER on the configured S3 / SSH target. This
 * panel lists recent bundles, lets the operator create one, verify
 * the round-trip integrity (read every component back + decrypt
 * secrets + decompress config), and delete.
 */
export default function BackupBundlesSection({ configs }: Props) {
  const { data: bundlesResp, isLoading } = useBundles();
  const [showCreate, setShowCreate] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{
    bundleId: string;
    result: VerifyBundleResponse | null;
    error: string | null;
    loading: boolean;
  } | null>(null);

  const verify = useVerifyBundle();
  const del = useDeleteBundle();

  // Wire shape is { data: { data: BundleSummary[], pagination: {...} } }
  // (success-envelope around the paginated payload).
  const bundles = bundlesResp?.data?.data ?? [];
  const activeTargets = configs.filter((c) => c.active);

  const onVerify = async (bundleId: string) => {
    setVerifyResult({ bundleId, result: null, error: null, loading: true });
    try {
      const res = await verify.mutateAsync(bundleId);
      setVerifyResult({ bundleId, result: res.data, error: null, loading: false });
    } catch (err) {
      setVerifyResult({
        bundleId,
        result: null,
        error: err instanceof Error ? err.message : 'Verify failed',
        loading: false,
      });
    }
  };

  const onDelete = async (bundleId: string) => {
    if (!confirm(`Delete bundle ${bundleId}? This removes the bundle from the off-site target AND the platform DB row. Cannot be undone.`)) {
      return;
    }
    try {
      await del.mutateAsync(bundleId);
    } catch (err) {
      alert(`Delete failed: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  };

  return (
    <section
      data-testid="backup-bundles-section"
      className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm"
    >
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Package size={20} className="text-gray-700 dark:text-gray-300" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            Tenant Bundles (v2)
          </h2>
          <span className="text-xs text-gray-500 dark:text-gray-400 ml-2">
            Component-oriented · off-site only · ADR-032
          </span>
        </div>
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          disabled={activeTargets.length === 0}
          className="flex items-center gap-2 rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed"
          title={activeTargets.length === 0 ? 'No active backup target configured' : 'Create a new tenant bundle'}
        >
          <Plus size={16} /> New Bundle
        </button>
      </div>

      {activeTargets.length === 0 && (
        <div className="rounded-lg border border-amber-200 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 p-3 mb-3 flex items-start gap-2">
          <AlertCircle size={18} className="text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
          <div className="text-sm text-amber-900 dark:text-amber-200">
            No active backup target. Configure + activate an S3 or SSH target above before creating bundles.
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center gap-2 text-gray-600 dark:text-gray-400 text-sm">
          <Loader2 size={16} className="animate-spin" /> Loading bundles…
        </div>
      ) : bundles.length === 0 ? (
        <div className="text-sm text-gray-500 dark:text-gray-400 italic">No bundles yet.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                <th className="px-3 py-2">Bundle ID</th>
                <th className="px-3 py-2">Client</th>
                <th className="px-3 py-2">Target</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Size</th>
                <th className="px-3 py-2">Created</th>
                <th className="px-3 py-2">Initiator</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {bundles.map((b) => (
                <BundleRow key={b.id} bundle={b} configs={configs} onVerify={onVerify} onDelete={onDelete} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <CreateBundleModal
          targets={activeTargets}
          onClose={() => setShowCreate(false)}
        />
      )}

      {verifyResult && (
        <VerifyResultModal
          result={verifyResult}
          onClose={() => setVerifyResult(null)}
        />
      )}
    </section>
  );
}

function BundleRow({
  bundle,
  configs,
  onVerify,
  onDelete,
}: {
  bundle: BundleSummary;
  configs: readonly BackupConfigResponse[];
  onVerify: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const target = configs.find((c) => c.id === bundle.targetConfigId);
  const targetLabel = target ? target.name : `${bundle.targetKind}://${bundle.targetConfigId ?? '?'}`;
  return (
    <tr className="border-b border-gray-100 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-700/30">
      <td className="px-3 py-2 font-mono text-xs text-gray-600 dark:text-gray-400" title={bundle.id}>
        {bundle.id.slice(0, 16)}…
      </td>
      <td className="px-3 py-2 font-mono text-xs text-gray-600 dark:text-gray-400" title={bundle.clientId}>
        {bundle.clientId.slice(0, 8)}
      </td>
      <td className="px-3 py-2 text-gray-900 dark:text-gray-100">
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300">
          {bundle.targetKind}
        </span>
        <span className="ml-2 text-xs">{targetLabel}</span>
      </td>
      <td className="px-3 py-2">
        <StatusBadge status={bundle.status === 'completed' ? 'healthy' : bundle.status === 'failed' || bundle.status === 'partial' ? 'error' : 'pending'} label={bundle.status} />
      </td>
      <td className="px-3 py-2 text-gray-600 dark:text-gray-400">{formatBytes(bundle.sizeBytes)}</td>
      <td className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400" title={bundle.createdAt}>
        {new Date(bundle.createdAt).toLocaleString()}
      </td>
      <td className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">{bundle.initiator}</td>
      <td className="px-3 py-2">
        <div className="flex items-center justify-end gap-1">
          <button
            type="button"
            onClick={() => onVerify(bundle.id)}
            disabled={bundle.status !== 'completed'}
            className="cursor-pointer flex items-center gap-1 px-2 py-1 rounded text-xs font-medium text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950/30 disabled:opacity-40 disabled:cursor-not-allowed"
            title={bundle.status !== 'completed' ? 'Only completed bundles can be verified' : 'Read every component back + decrypt secrets + decompress config'}
          >
            <ShieldCheck size={14} /> Verify
          </button>
          <button
            type="button"
            onClick={() => onDelete(bundle.id)}
            className="cursor-pointer flex items-center gap-1 px-2 py-1 rounded text-xs font-medium text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/30"
            title="Delete bundle from off-site target + DB"
          >
            <Trash2 size={14} /> Delete
          </button>
        </div>
        {bundle.lastError && (
          <div className="text-xs text-red-600 dark:text-red-400 mt-1 max-w-xs truncate" title={bundle.lastError}>
            {bundle.lastError}
          </div>
        )}
      </td>
    </tr>
  );
}

function CreateBundleModal({
  targets,
  onClose,
}: {
  targets: BackupConfigResponse[];
  onClose: () => void;
}) {
  const { data: clientsResp } = useClients({ limit: 100 });
  const create = useCreateBundle();
  const [clientId, setClientId] = useState('');
  const [targetId, setTargetId] = useState(targets[0]?.id ?? '');
  const [label, setLabel] = useState('');
  const [retentionDays, setRetentionDays] = useState(30);
  const [includeConfig, setIncludeConfig] = useState(true);
  const [includeSecrets, setIncludeSecrets] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ bundleId: string; status: string } | null>(null);

  const clients = clientsResp?.data ?? [];

  const onSubmit = async () => {
    setError(null);
    if (!clientId || !targetId) {
      setError('Pick a client and a backup target.');
      return;
    }
    setSubmitting(true);
    try {
      const r = await create.mutateAsync({
        clientId,
        targetConfigId: targetId,
        initiator: 'admin',
        label: label || undefined,
        retentionDays,
        components: {
          files: false, // Phase 3
          mailboxes: false, // Phase 3
          config: includeConfig,
          secrets: includeSecrets,
        },
      });
      setResult(r.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-lg rounded-xl bg-white dark:bg-gray-800 p-6 shadow-xl">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Create Tenant Bundle</h3>
          <button type="button" onClick={onClose} className="cursor-pointer text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
            <X size={20} />
          </button>
        </div>

        {result ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-green-700 dark:text-green-400">
              <CheckCircle size={20} />
              <span className="font-medium">Bundle created</span>
            </div>
            <div className="text-sm text-gray-600 dark:text-gray-400">
              <div><span className="font-mono">{result.bundleId}</span></div>
              <div className="mt-1">Status: <span className="font-medium">{result.status}</span></div>
            </div>
            <button type="button" onClick={onClose} className="w-full rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700">
              Close
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <label className="block text-sm">
              <span className="text-gray-700 dark:text-gray-300 font-medium">Client</span>
              <select className={`${INPUT_CLASS} mt-1`} value={clientId} onChange={(e) => setClientId(e.target.value)}>
                <option value="">Pick a client…</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>{c.companyName} ({c.id.slice(0, 8)})</option>
                ))}
              </select>
            </label>

            <label className="block text-sm">
              <span className="text-gray-700 dark:text-gray-300 font-medium">Target</span>
              <select className={`${INPUT_CLASS} mt-1`} value={targetId} onChange={(e) => setTargetId(e.target.value)}>
                {targets.map((t) => (
                  <option key={t.id} value={t.id}>{t.name} ({t.storageType})</option>
                ))}
              </select>
            </label>

            <label className="block text-sm">
              <span className="text-gray-700 dark:text-gray-300 font-medium">Label (optional)</span>
              <input className={`${INPUT_CLASS} mt-1`} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. pre-migration 2026-Q2" />
            </label>

            <label className="block text-sm">
              <span className="text-gray-700 dark:text-gray-300 font-medium">Retention (days)</span>
              <input type="number" min={1} max={3650} className={`${INPUT_CLASS} mt-1`} value={retentionDays} onChange={(e) => setRetentionDays(Number(e.target.value))} />
            </label>

            <fieldset className="space-y-1.5">
              <legend className="text-sm text-gray-700 dark:text-gray-300 font-medium mb-1">Components</legend>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked={includeConfig} onChange={(e) => setIncludeConfig(e.target.checked)} />
                <Database size={14} className="text-gray-500" />
                <span>Config (client DB rows)</span>
              </label>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked={includeSecrets} onChange={(e) => setIncludeSecrets(e.target.checked)} />
                <KeyRound size={14} className="text-gray-500" />
                <span>Secrets (TLS certs, AES-256-GCM encrypted)</span>
              </label>
              <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-500 pt-1">
                <FolderOpen size={12} />
                <span>Files + mailboxes deferred to Phase 3</span>
              </div>
            </fieldset>

            {error && (
              <div className="rounded-lg border border-red-200 dark:border-red-700 bg-red-50 dark:bg-red-950/30 p-2 text-sm text-red-700 dark:text-red-300">
                {error}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={onClose} className="rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700">
                Cancel
              </button>
              <button type="button" onClick={onSubmit} disabled={submitting} className="flex items-center gap-2 rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50 cursor-pointer">
                {submitting && <Loader2 size={14} className="animate-spin" />}
                Create
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function VerifyResultModal({
  result,
  onClose,
}: {
  result: { bundleId: string; result: VerifyBundleResponse | null; error: string | null; loading: boolean };
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-2xl rounded-xl bg-white dark:bg-gray-800 p-6 shadow-xl">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Verify: <span className="font-mono text-sm">{result.bundleId}</span></h3>
          <button type="button" onClick={onClose} className="cursor-pointer text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
            <X size={20} />
          </button>
        </div>
        {result.loading ? (
          <div className="flex items-center gap-2 text-gray-700 dark:text-gray-300"><Loader2 size={16} className="animate-spin" /> Verifying…</div>
        ) : result.error ? (
          <div className="rounded-lg border border-red-200 dark:border-red-700 bg-red-50 dark:bg-red-950/30 p-3 text-sm text-red-700 dark:text-red-300">{result.error}</div>
        ) : result.result ? (
          <div className="space-y-4 text-sm">
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div><span className="text-gray-500">Schema:</span> v{result.result.meta.schemaVersion}</div>
              <div><span className="text-gray-500">Captured:</span> {new Date(result.result.meta.capturedAt).toLocaleString()}</div>
              <div><span className="text-gray-500">Platform:</span> {result.result.meta.platformVersion}</div>
              <div><span className="text-gray-500">Initiator:</span> {result.result.meta.initiator}</div>
              <div><span className="text-gray-500">Retention:</span> {result.result.meta.retentionDays}d</div>
              <div><span className="text-gray-500">Expires:</span> {result.result.meta.expiresAt ? new Date(result.result.meta.expiresAt).toLocaleString() : 'never'}</div>
            </div>

            {result.result.components.config && (
              <ComponentCard title="Config" icon={<Database size={16} />}>
                <div>Size: {formatBytes(result.result.components.config.sizeBytes)}</div>
                <div className="font-mono text-xs break-all">SHA-256: {result.result.components.config.sha256}</div>
                {result.result.components.config.parseError ? (
                  <div className="text-red-600 dark:text-red-400">Parse error: {result.result.components.config.parseError}</div>
                ) : (
                  <div className="mt-1">
                    <div className="text-xs text-gray-500 mb-1">Rows per table:</div>
                    <div className="grid grid-cols-3 gap-x-3 gap-y-0.5 text-xs">
                      {Object.entries(result.result.components.config.rowCounts).map(([t, n]) => (
                        <div key={t} className="flex justify-between">
                          <span className="font-mono text-gray-600 dark:text-gray-400">{t}</span>
                          <span className="text-gray-900 dark:text-gray-100 font-medium">{n}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </ComponentCard>
            )}

            {result.result.components.secrets && (
              <ComponentCard title="Secrets" icon={<KeyRound size={16} />}>
                <div>Size: {formatBytes(result.result.components.secrets.sizeBytes)}</div>
                <div className="font-mono text-xs break-all">SHA-256: {result.result.components.secrets.sha256}</div>
                <div>KID: <span className="font-mono">{result.result.components.secrets.encryptionKeyId}</span></div>
                {result.result.components.secrets.decryptError ? (
                  <div className="text-red-600 dark:text-red-400">Decrypt error: {result.result.components.secrets.decryptError}</div>
                ) : (
                  <div className="text-green-700 dark:text-green-400 flex items-center gap-1">
                    <CheckCircle size={14} /> Decrypt OK · {result.result.components.secrets.secretCount} TLS Secret(s)
                  </div>
                )}
              </ComponentCard>
            )}
          </div>
        ) : null}
        <div className="flex justify-end mt-4">
          <button type="button" onClick={onClose} className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 cursor-pointer">Close</button>
        </div>
      </div>
    </div>
  );
}

function ComponentCard({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-3 bg-gray-50 dark:bg-gray-900/30">
      <div className="flex items-center gap-2 font-medium text-gray-900 dark:text-gray-100 mb-2">
        {icon}
        {title}
      </div>
      <div className="text-xs text-gray-700 dark:text-gray-300 space-y-1">
        {children}
      </div>
    </div>
  );
}
