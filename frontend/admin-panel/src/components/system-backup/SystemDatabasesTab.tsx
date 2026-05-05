/**
 * System Databases tab — pg_dump runs + Run Now per CNPG cluster.
 *
 * Shows the two known system CNPG clusters (platform/postgres,
 * mail/mail-pg) with their recent dump history + a "Run Now" button.
 * Backup-config target is selected from the operator's existing
 * Tenant-Backup configurations (active=true required).
 */

import { useState } from 'react';
import { Database, Play, RefreshCw, AlertCircle, CheckCircle2, XCircle } from 'lucide-react';
import {
  usePgDumpRuns,
  useTriggerPgDump,
} from '@/hooks/use-system-pg-dump';
import { useBackupConfigs } from '@/hooks/use-backup-config';

const SYSTEM_CLUSTERS = [
  { namespace: 'platform', cluster: 'postgres', database: 'hosting_platform', label: 'Platform DB' },
  { namespace: 'mail', cluster: 'mail-pg', database: 'stalwart_app', label: 'Mail DB (Stalwart)' },
] as const;

export default function SystemDatabasesTab() {
  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-gray-100">
          <Database size={20} /> System Databases
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          pg_dump exports of the CNPG-managed system databases. Runs as a one-shot
          Kubernetes Job inside the platform; output streams to your configured
          off-site target (S3 or SSH/SFTP).
        </p>
      </header>

      {SYSTEM_CLUSTERS.map((c) => (
        <ClusterPanel key={`${c.namespace}/${c.cluster}`} {...c} />
      ))}
    </div>
  );
}

interface ClusterPanelProps {
  readonly namespace: string;
  readonly cluster: string;
  readonly database: string;
  readonly label: string;
}

function ClusterPanel({ namespace, cluster, database, label }: ClusterPanelProps) {
  const runsQ = usePgDumpRuns({ namespace, cluster });
  const trigger = useTriggerPgDump();
  const { data: configsResp } = useBackupConfigs();
  const configs = (configsResp as { data?: Array<{ id: string; name: string; active: boolean; storageType: 's3' | 'ssh' }> } | undefined)?.data ?? [];
  const activeConfigs = configs.filter((c) => c.active);
  const [targetId, setTargetId] = useState<string>('');

  const onRun = (): void => {
    if (!targetId) {
      window.alert('Pick a backup target first.');
      return;
    }
    void (async () => {
      try {
        await trigger.mutateAsync({
          sourceNamespace: namespace,
          sourceCluster: cluster,
          sourceDatabase: database,
          targetConfigId: targetId,
        });
      } catch {
        // useMutation surfaces the error; no rethrow.
      }
    })();
  };

  return (
    <section className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-mono text-sm font-medium text-gray-900 dark:text-gray-100">
            {label}
            <span className="ml-2 text-xs text-gray-500 dark:text-gray-400 font-normal">
              ({namespace}/{cluster}/{database})
            </span>
          </h3>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            className="text-sm rounded-lg border border-gray-300 dark:border-gray-600 px-2 py-1.5 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
            data-testid={`target-select-${cluster}`}
          >
            <option value="">— Pick target —</option>
            {activeConfigs.map((c) => (
              <option key={c.id} value={c.id}>{c.name} ({c.storageType})</option>
            ))}
          </select>
          <button
            onClick={onRun}
            disabled={trigger.isPending || !targetId}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-brand-600 text-white text-xs font-medium hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid={`run-pgdump-${cluster}`}
          >
            {trigger.isPending ? <RefreshCw size={12} className="animate-spin" /> : <Play size={12} />}
            Run Now
          </button>
        </div>
      </div>
      {trigger.isError && (
        <div className="text-xs text-red-700 dark:text-red-300 flex items-center gap-1">
          <AlertCircle size={12} /> {(trigger.error as Error).message}
        </div>
      )}

      {runsQ.isLoading && <div className="text-xs text-gray-500 dark:text-gray-400">Loading…</div>}
      {!runsQ.isLoading && (runsQ.data?.length ?? 0) === 0 && (
        <div className="text-xs text-gray-500 dark:text-gray-400">No dumps yet for this cluster.</div>
      )}
      {!runsQ.isLoading && (runsQ.data?.length ?? 0) > 0 && (
        <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
          <table className="min-w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-900/40">
              <tr>
                <th className="text-left px-3 py-2">Started</th>
                <th className="text-left px-3 py-2">Status</th>
                <th className="text-left px-3 py-2">Size</th>
                <th className="text-left px-3 py-2 hidden md:table-cell">SHA256</th>
                <th className="text-left px-3 py-2 hidden md:table-cell">Artifact</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {runsQ.data!.map((r) => (
                <tr key={r.id} data-testid={`pgdump-row-${r.id}`}>
                  <td className="px-3 py-2 text-gray-700 dark:text-gray-300">{new Date(r.startedAt).toLocaleString()}</td>
                  <td className="px-3 py-2">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-gray-700 dark:text-gray-300">
                    {r.sizeBytes !== null ? `${r.sizeBytes.toLocaleString()} B` : '—'}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-gray-500 dark:text-gray-400 hidden md:table-cell">
                    {r.sha256 ? `${r.sha256.slice(0, 12)}…` : '—'}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-gray-500 dark:text-gray-400 hidden md:table-cell">
                    {r.artifactName ?? '—'}
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
  const map: Record<string, { cls: string; icon: React.ReactNode }> = {
    succeeded: { cls: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300', icon: <CheckCircle2 size={12} /> },
    failed:    { cls: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300', icon: <XCircle size={12} /> },
    running:   { cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300', icon: <RefreshCw size={12} className="animate-spin" /> },
    pending:   { cls: 'bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-300', icon: null },
  };
  const m = map[status] ?? map.pending;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${m.cls}`}>
      {m.icon}{status}
    </span>
  );
}
