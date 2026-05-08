/**
 * System Databases tab — pg_dump runs + Run Now per CNPG cluster.
 *
 * Shows the two known system CNPG clusters (platform/postgres,
 * mail/mail-pg) with their recent dump history + a "Run Now" button.
 * Backup-config target is selected from the operator's existing
 * Tenant-Backup configurations (active=true required).
 */

import { Fragment, useState } from 'react';
import { Database, Play, RefreshCw, AlertCircle, CheckCircle2, XCircle, Copy, ChevronDown, ChevronRight, Clock, Trash2 } from 'lucide-react';
import {
  usePgDumpRuns,
  useTriggerPgDump,
} from '@/hooks/use-system-pg-dump';
import {
  usePgDumpSchedules,
  useUpsertPgDumpSchedule,
  useDeletePgDumpSchedule,
} from '@/hooks/use-pg-dump-schedules';
import { useBackupConfigs } from '@/hooks/use-backup-config';
import ErrorPanel from '@/components/ErrorPanel';
import type { OperatorError } from '@k8s-hosting/api-contracts';

const SYSTEM_CLUSTERS = [
  // Cluster names renamed 2026-05-07 (postgres → system-db, mail-pg → mail-db)
  // to drop PG-version baggage from CNPG resource names. The backend's
  // KNOWN_CLUSTERS list (system-backup/wal-archive-routes.ts) and
  // CNPG_CLUSTERS (platform-storage-policy/service.ts) must stay in sync
  // with these names — drift will silently no-op at the API boundary.
  { namespace: 'platform', cluster: 'system-db', database: 'hosting_platform', label: 'Platform DB' },
  { namespace: 'mail', cluster: 'mail-db', database: 'stalwart_app', label: 'Mail DB (Stalwart)' },
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

const PG_DUMP_CRON_PRESETS: Array<{ value: string; label: string }> = [
  { value: '0 */6 * * *',  label: 'Every 6 hours' },
  { value: '0 3 * * *',    label: 'Daily at 03:00' },
  { value: '0 3 * * 0',    label: 'Weekly Sun 03:00' },
  { value: '0 3 1 * *',    label: 'Monthly 1st 03:00' },
];

function ClusterPanel({ namespace, cluster, database, label }: ClusterPanelProps) {
  const runsQ = usePgDumpRuns({ namespace, cluster });
  const trigger = useTriggerPgDump();
  const schedulesQ = usePgDumpSchedules();
  const upsertSched = useUpsertPgDumpSchedule();
  const deleteSched = useDeletePgDumpSchedule();
  const { data: configsResp } = useBackupConfigs();
  const configs = (configsResp as { data?: Array<{ id: string; name: string; active: boolean; storageType: 's3' | 'ssh' }> } | undefined)?.data ?? [];
  const activeConfigs = configs.filter((c) => c.active);
  const [targetId, setTargetId] = useState<string>('');
  const existingSched = (schedulesQ.data ?? []).find(
    (s) => s.sourceNamespace === namespace && s.sourceCluster === cluster && s.sourceDatabase === database,
  );
  const [showSched, setShowSched] = useState(false);
  const [schedTarget, setSchedTarget] = useState<string>(existingSched?.targetConfigId ?? '');
  const [schedCron, setSchedCron] = useState<string>(existingSched?.cronSchedule ?? '0 3 * * *');
  const [schedRetention, setSchedRetention] = useState<number>(existingSched?.retentionDays ?? 30);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const targetById = (id: string | null): string => {
    if (!id) return '—';
    const c = configs.find((x) => x.id === id);
    return c ? `${c.name} (${c.storageType})` : id.slice(0, 8) + '…';
  };

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

      <div className="flex items-center gap-3 text-xs">
        <button
          type="button"
          onClick={() => setShowSched((v) => !v)}
          className="inline-flex items-center gap-1 text-gray-700 dark:text-gray-300 hover:text-brand-600"
          data-testid={`pg-dump-sched-toggle-${cluster}`}
        >
          <Clock size={12} />
          {existingSched
            ? `Scheduled: ${existingSched.cronSchedule} → ${existingSched.targetName ?? '?'} (${existingSched.retentionDays}d)`
            : 'No schedule — click to set'}
          {showSched ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        {existingSched && (
          <button
            type="button"
            onClick={() => {
              if (!confirm('Delete this schedule?')) return;
              void deleteSched.mutateAsync(existingSched.id);
            }}
            className="inline-flex items-center gap-1 text-red-600 dark:text-red-300 hover:text-red-700"
            data-testid={`pg-dump-sched-delete-${cluster}`}
          >
            <Trash2 size={12} /> Remove
          </button>
        )}
      </div>
      {showSched && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs p-3 rounded-lg bg-gray-50 dark:bg-gray-900/40 border border-gray-200 dark:border-gray-700">
          <label className="flex flex-col gap-1">
            <span className="text-gray-600 dark:text-gray-400">Target</span>
            <select
              value={schedTarget}
              onChange={(e) => setSchedTarget(e.target.value)}
              className="text-sm rounded-lg border border-gray-300 dark:border-gray-600 px-2 py-1.5 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
              data-testid={`pg-dump-sched-target-${cluster}`}
            >
              <option value="">— Pick target —</option>
              {activeConfigs.map((c) => (
                <option key={c.id} value={c.id}>{c.name} ({c.storageType})</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-gray-600 dark:text-gray-400">Cadence</span>
            <select
              value={PG_DUMP_CRON_PRESETS.find((p) => p.value === schedCron) ? schedCron : 'CUSTOM'}
              onChange={(e) => {
                if (e.target.value !== 'CUSTOM') setSchedCron(e.target.value);
              }}
              className="text-sm rounded-lg border border-gray-300 dark:border-gray-600 px-2 py-1.5 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
              data-testid={`pg-dump-sched-cron-${cluster}`}
            >
              {PG_DUMP_CRON_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
              <option value="CUSTOM">Custom 5-field cron…</option>
            </select>
            {!PG_DUMP_CRON_PRESETS.find((p) => p.value === schedCron) && (
              <input
                type="text"
                value={schedCron}
                onChange={(e) => setSchedCron(e.target.value)}
                placeholder="0 3 * * *"
                className="font-mono text-xs rounded-lg border border-gray-300 dark:border-gray-600 px-2 py-1.5 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
              />
            )}
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-gray-600 dark:text-gray-400">Retention (days)</span>
            <input
              type="number"
              min={1}
              max={3650}
              value={schedRetention}
              onChange={(e) => setSchedRetention(parseInt(e.target.value, 10) || 30)}
              className="text-sm rounded-lg border border-gray-300 dark:border-gray-600 px-2 py-1.5 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
              data-testid={`pg-dump-sched-retention-${cluster}`}
            />
          </label>
          <div className="md:col-span-3 flex justify-end">
            <button
              type="button"
              onClick={() => {
                if (!schedTarget) return;
                void upsertSched.mutateAsync({
                  sourceNamespace: namespace,
                  sourceCluster: cluster,
                  sourceDatabase: database,
                  targetConfigId: schedTarget,
                  cronSchedule: schedCron,
                  retentionDays: schedRetention,
                  enabled: true,
                }).then(() => setShowSched(false)).catch(() => undefined);
              }}
              disabled={upsertSched.isPending || !schedTarget}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-brand-600 text-white text-xs font-medium hover:bg-brand-700 disabled:opacity-50"
              data-testid={`pg-dump-sched-save-${cluster}`}
            >
              {upsertSched.isPending ? <RefreshCw size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
              {existingSched ? 'Update schedule' : 'Save schedule'}
            </button>
          </div>
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
                <th className="w-6 px-2"></th>
                <th className="text-left px-3 py-2">Started</th>
                <th className="text-left px-3 py-2">Status</th>
                <th className="text-left px-3 py-2">Size</th>
                <th className="text-left px-3 py-2 hidden md:table-cell">Target</th>
                <th className="text-left px-3 py-2 hidden md:table-cell">SHA256</th>
                <th className="text-left px-3 py-2 hidden lg:table-cell">Bundle</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {runsQ.data!.map((r) => {
                const isExpanded = expandedRunId === r.id;
                const isFailed = r.status === 'failed';
                return (
                  <Fragment key={r.id}>
                    <tr data-testid={`pgdump-row-${r.id}`}
                        className={isFailed ? 'cursor-pointer hover:bg-red-50/50 dark:hover:bg-red-900/10' : ''}
                        onClick={isFailed ? () => setExpandedRunId(isExpanded ? null : r.id) : undefined}>
                      <td className="px-2 py-2 text-gray-400">
                        {isFailed ? (isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : null}
                      </td>
                      <td className="px-3 py-2 text-gray-700 dark:text-gray-300">{new Date(r.startedAt).toLocaleString()}</td>
                      <td className="px-3 py-2">
                        <StatusBadge status={r.status} />
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-gray-700 dark:text-gray-300">
                        {r.sizeBytes !== null ? formatBytes(r.sizeBytes) : '—'}
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-600 dark:text-gray-400 hidden md:table-cell">
                        {targetById(r.targetConfigId)}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-gray-500 dark:text-gray-400 hidden md:table-cell">
                        {r.sha256 ? <CopyableHex value={r.sha256} /> : '—'}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-gray-500 dark:text-gray-400 hidden lg:table-cell">
                        {r.bundleId ? <CopyableHex value={r.bundleId} /> : '—'}
                      </td>
                    </tr>
                    {isFailed && isExpanded && (
                      <tr className="bg-red-50/40 dark:bg-red-900/10">
                        <td colSpan={7} className="px-4 py-3">
                          <ErrorPanel
                            error={toOperatorError(r.errorEnvelope, namespace, cluster)}
                            severity="error"
                            compact
                            testId={`pgdump-error-${r.id}`}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

/**
 * Map the orchestrator's compact `{code, message, stderr?}` envelope
 * into the OperatorError shape ErrorPanel expects. We can't change the
 * shape stored in the DB without a migration; this synth lets the
 * standard ErrorPanel render today's runs cleanly while keeping the
 * door open for a richer envelope later.
 */
function toOperatorError(envelope: unknown, namespace: string, cluster: string): OperatorError {
  const e = (envelope ?? {}) as { code?: string; message?: string; stderr?: string | null };
  const code = e.code ?? 'SYSTEM_BACKUP_PG_DUMP_FAILED';
  const detail = e.message ?? 'pg_dump failed without a captured message.';
  const remediation: string[] = [];
  if (code === 'SYSTEM_BACKUP_JOB_ORPHANED') {
    remediation.push('Re-run the dump — the previous Job pod was killed before it could finish.');
  } else if (/database\s*".+"\s*does not exist/i.test(detail)) {
    remediation.push('Pick the correct database name in the request body.');
  } else if (/connection.*failed|connection refused|timeout/i.test(detail)) {
    remediation.push(`Verify the CNPG read service ${cluster}-r.${namespace}.svc:5432 is reachable.`);
    remediation.push(`Check NetworkPolicy in the ${namespace} namespace allows ingress from app=platform-api in platform ns.`);
  } else {
    remediation.push('Inspect the Job pod logs: `kubectl -n platform logs job/<jobName>`.');
    remediation.push('Re-run after fixing the underlying cause; the run row stays as audit history.');
  }
  return {
    code,
    title: 'pg_dump failed',
    detail,
    remediation,
    retryable: true,
    diagnostics: e.stderr ? { stderr: e.stderr } : undefined,
  };
}

function CopyableHex({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className="inline-flex items-center gap-1 hover:text-gray-700 dark:hover:text-gray-200"
      title={value}
    >
      <span>{value.slice(0, 12)}…</span>
      <Copy size={10} className={copied ? 'text-green-500' : ''} />
    </button>
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
