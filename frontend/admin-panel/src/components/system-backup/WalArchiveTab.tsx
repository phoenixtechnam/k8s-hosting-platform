/**
 * WAL Archive tab — Phase 4 of System Backup.
 *
 * Per-cluster on/off + target picker + retention. Surfaces CNPG's
 * archiver health (last archived WAL, errors) read from the Cluster
 * CR's .status. SFTP/SSH targets are filtered out of the picker — CNPG
 * barman-cloud is S3-only.
 */

import { useState } from 'react';
import { ArchiveRestore, Play, RefreshCw, AlertCircle, CheckCircle2, Power, PowerOff, Copy } from 'lucide-react';
import {
  useWalArchiveClusters,
  useEnableWalArchive,
  useDisableWalArchive,
} from '@/hooks/use-system-wal-archive';
import { useBackupConfigs } from '@/hooks/use-backup-config';
import type { WalArchiveCluster } from '@k8s-hosting/api-contracts';

export default function WalArchiveTab() {
  const clustersQ = useWalArchiveClusters();
  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-gray-100">
          <ArchiveRestore size={20} /> WAL Archive
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Continuous Postgres WAL streaming to your off-site S3 target. Tighter
          recovery point than scheduled pg_dump (RPO ≈ 5 min). Toggle per
          cluster — only S3 targets are usable; SFTP/SSH backup configs are
          filtered out (CNPG barman-cloud limitation).
        </p>
      </header>

      {clustersQ.isLoading && (
        <div className="text-sm text-gray-500 dark:text-gray-400">Loading…</div>
      )}
      {!clustersQ.isLoading && clustersQ.data?.map((c) => (
        <ClusterCard key={`${c.clusterNamespace}/${c.clusterName}`} cluster={c} />
      ))}
    </div>
  );
}

function ClusterCard({ cluster }: { cluster: WalArchiveCluster }) {
  const enable = useEnableWalArchive();
  const disable = useDisableWalArchive();
  const { data: cfgResp } = useBackupConfigs();
  const allConfigs = (cfgResp as { data?: Array<{ id: string; name: string; active: boolean; storageType: 's3' | 'ssh' }> } | undefined)?.data ?? [];
  const eligible = allConfigs.filter((c) => c.active && c.storageType === 's3');
  const [targetId, setTargetId] = useState<string>(cluster.state?.targetConfigId ?? '');
  const [retention, setRetention] = useState<number>(cluster.state?.retentionDays ?? 30);

  const onEnable = (): void => {
    if (!targetId) return;
    void (async () => {
      try {
        await enable.mutateAsync({
          clusterNamespace: cluster.clusterNamespace,
          clusterName: cluster.clusterName,
          targetConfigId: targetId,
          retentionDays: retention,
        });
      } catch { /* error surfaced via mutation state */ }
    })();
  };

  const onDisable = (): void => {
    if (!confirm(`Disable WAL archive for ${cluster.clusterNamespace}/${cluster.clusterName}? Existing WAL files at the target are kept (CNPG retention only deletes them at the configured retention).`)) return;
    void (async () => {
      try {
        await disable.mutateAsync({
          clusterNamespace: cluster.clusterNamespace,
          clusterName: cluster.clusterName,
        });
      } catch { /* error surfaced via mutation state */ }
    })();
  };

  return (
    <section className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-0.5">
          <h3 className="font-mono text-sm font-medium text-gray-900 dark:text-gray-100">
            {cluster.clusterNamespace}/{cluster.clusterName}
          </h3>
          <EnabledBadge enabled={cluster.enabled} />
        </div>
        {cluster.enabled ? (
          <button
            onClick={onDisable}
            disabled={disable.isPending}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-red-600 text-white text-xs font-medium hover:bg-red-700 disabled:opacity-50"
            data-testid={`wal-disable-${cluster.clusterName}`}
          >
            {disable.isPending ? <RefreshCw size={12} className="animate-spin" /> : <PowerOff size={12} />}
            Disable
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <select
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              className="text-sm rounded-lg border border-gray-300 dark:border-gray-600 px-2 py-1.5 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
              data-testid={`wal-target-${cluster.clusterName}`}
            >
              <option value="">— Pick S3 target —</option>
              {eligible.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            <input
              type="number"
              min={1}
              max={3650}
              value={retention}
              onChange={(e) => setRetention(parseInt(e.target.value, 10) || 30)}
              className="w-20 text-sm rounded-lg border border-gray-300 dark:border-gray-600 px-2 py-1.5 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
              data-testid={`wal-retention-${cluster.clusterName}`}
              title="Retention days"
            />
            <button
              onClick={onEnable}
              disabled={enable.isPending || !targetId}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-brand-600 text-white text-xs font-medium hover:bg-brand-700 disabled:opacity-50"
              data-testid={`wal-enable-${cluster.clusterName}`}
            >
              {enable.isPending ? <RefreshCw size={12} className="animate-spin" /> : <Power size={12} />}
              Enable
            </button>
          </div>
        )}
      </div>
      {(enable.isError || disable.isError) && (
        <div className="text-xs text-red-700 dark:text-red-300 flex items-center gap-1">
          <AlertCircle size={12} />
          {((enable.error || disable.error) as Error).message}
        </div>
      )}
      {cluster.enabled && cluster.state && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1 text-xs">
          <Field label="Target">{cluster.state.targetName ?? cluster.state.targetConfigId.slice(0, 8) + '…'}</Field>
          <Field label="Retention">{cluster.state.retentionDays} days</Field>
          <FieldCopy label="Destination" value={cluster.state.destinationPath} />
          <Field label="Enabled">{new Date(cluster.state.enabledAt).toLocaleString()}</Field>
        </div>
      )}
      {cluster.status && cluster.enabled && (
        <ArchiverStatus status={cluster.status} />
      )}
    </section>
  );
}

function EnabledBadge({ enabled }: { enabled: boolean }) {
  return enabled ? (
    <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300">
      <CheckCircle2 size={12} /> archiving
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-300">
      <Play size={12} /> off
    </span>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-gray-500 dark:text-gray-400">{label}:</span>
      <span className="text-gray-900 dark:text-gray-100 font-mono text-right truncate">{children}</span>
    </div>
  );
}

function FieldCopy({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex justify-between gap-2">
      <span className="text-gray-500 dark:text-gray-400">{label}:</span>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          });
        }}
        className="inline-flex items-center gap-1 text-gray-900 dark:text-gray-100 font-mono truncate hover:text-brand-600"
        title={value}
      >
        <span className="truncate">{value}</span>
        <Copy size={10} className={copied ? 'text-green-500' : ''} />
      </button>
    </div>
  );
}

function ArchiverStatus({ status }: { status: NonNullable<WalArchiveCluster['status']> }) {
  const failing = !!status.lastFailedArchiveError;
  return (
    <div className={`mt-3 rounded-lg border p-3 text-xs space-y-1 ${
      failing
        ? 'border-red-300 dark:border-red-700 bg-red-50/50 dark:bg-red-900/20'
        : 'border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/20'
    }`}>
      <div className="font-medium text-gray-700 dark:text-gray-300">CNPG archiver status</div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-0.5">
        <Field label="Last archived WAL">{status.lastArchivedWal ?? 'none yet'}</Field>
        <Field label="Last archived at">{status.lastArchivedWalTime ? new Date(status.lastArchivedWalTime).toLocaleString() : '—'}</Field>
        <Field label="First recoverability">{status.firstRecoverabilityPoint ?? '—'}</Field>
        <Field label="Last failure at">{status.lastFailedArchiveTime ? new Date(status.lastFailedArchiveTime).toLocaleString() : '—'}</Field>
      </div>
      {failing && status.lastFailedArchiveError && (
        <div className="mt-2 text-red-700 dark:text-red-300 font-mono break-all">
          {status.lastFailedArchiveError}
        </div>
      )}
    </div>
  );
}
