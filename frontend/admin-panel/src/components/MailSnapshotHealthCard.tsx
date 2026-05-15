import { useState } from 'react';
import {
  Archive,
  AlertTriangle,
  Loader2,
  Check,
  X,
  Play,
  Pencil,
  Save,
  Database,
} from 'lucide-react';
import {
  useMailSnapshotStatus,
  useTriggerMailSnapshot,
  useMailSnapshotJobStatus,
} from '@/hooks/use-mail-snapshot';
import {
  useMailSnapshotSchedule,
  useUpdateMailSnapshotSchedule,
} from '@/hooks/use-mail-snapshot-schedule';
import {
  useMailSnapshotBackupTarget,
  useBackupConfigs,
  useUpdateMailSnapshotBackupTarget,
} from '@/hooks/use-mail-snapshot-backup-target';
import type { MailSnapshotJobStatusResponse } from '@k8s-hosting/api-contracts';

/**
 * Email Management → Mail Backup Health card.
 *
 * Surfaces visibility into the restic backup of the Stalwart RocksDB data dir
 * so operators notice when the periodic CronJob has stalled WITHOUT having to
 * run kubectl.
 *
 * Vocabulary note (intentional): the UI says "backup" everywhere to avoid
 * confusion with K8s `VolumeSnapshot` CRDs. The mail PVC is on `local-path`
 * which has no CSI snapshot capability — these are file-level restic backups,
 * not block-level volume snapshots. Internal symbol names (hooks, types,
 * function names) keep the "snapshot" word because they pre-date the rename
 * and DB columns / route paths aren't changing.
 *
 * States:
 *   - healthy        — green: last backup < 5 min ago (or within schedule window)
 *   - stale          — amber: last backup is old — likely CronJob issue
 *   - no backups yet — neutral: CronJob is configured but has never fired
 *   - disabled       — neutral: no CronJob found in cluster
 *
 * A "Run Backup Now" button fires a one-shot Job and shows a live log panel
 * (same pattern as StalwartBlobStoreCard) until the Job is done.
 */
export default function MailSnapshotHealthCard() {
  const status = useMailSnapshotStatus();
  const trigger = useTriggerMailSnapshot();
  const [pendingJobName, setPendingJobName] = useState<string | null>(null);
  const job = useMailSnapshotJobStatus(pendingJobName);

  const scheduleQuery = useMailSnapshotSchedule();
  const scheduleUpdate = useUpdateMailSnapshotSchedule();
  const [editingSchedule, setEditingSchedule] = useState(false);
  const [scheduleDraft, setScheduleDraft] = useState('');

  const backupTargetQuery = useMailSnapshotBackupTarget();
  const backupTargetUpdate = useUpdateMailSnapshotBackupTarget();
  const backupConfigsQuery = useBackupConfigs();

  if (status.isLoading) {
    return (
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm p-5">
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <Loader2 size={14} className="animate-spin" /> Loading backup health…
        </div>
      </div>
    );
  }

  if (status.isError || !status.data) {
    return (
      <div className="rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-5">
        <div className="flex items-start gap-2.5">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-red-600" />
          <div className="text-sm text-red-700 dark:text-red-300">
            Could not read backup status.{' '}
            {status.error instanceof Error ? status.error.message : 'See server logs.'}
          </div>
        </div>
      </div>
    );
  }

  const data = status.data.data;
  const palette = paletteForSnapshot(data.enabled, data.healthy, data.lastSnapshotAt);

  const handleTrigger = async () => {
    try {
      const result = await trigger.mutateAsync();
      setPendingJobName(result.data.jobName);
      trigger.reset();
    } catch {
      // surfaced via trigger.error below
    }
  };

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm p-5 space-y-4">
      {/* ── header ── */}
      <div className="flex items-center gap-3">
        <Archive size={20} className="text-gray-700 dark:text-gray-300" />
        <h2
          className="text-lg font-semibold text-gray-900 dark:text-gray-100"
          data-testid="mail-snapshot-health-heading"
        >
          Mail Backup Health
        </h2>
        <span className={`ml-auto rounded px-2 py-0.5 text-xs font-medium ${palette.badge}`} data-testid="mail-snapshot-badge">
          {palette.label}
        </span>
      </div>

      <p className="text-sm text-gray-600 dark:text-gray-400">
        File-level restic backup of <code className="rounded bg-gray-100 dark:bg-gray-800 px-1">/var/lib/stalwart/data</code>
        (the RocksDB data directory). Used as the HA DR recovery path: if the mail pod
        reschedules to a node without DataStore state, the restore-state initContainer
        downloads the latest backup and writes it into the empty PVC, then RocksDB's WAL
        replay handles partial-write state on next start.
        <br />
        <span className="text-xs">Not a K8s <code className="rounded bg-gray-100 dark:bg-gray-800 px-1">VolumeSnapshot</code> — the mail PVC uses
        the <code className="rounded bg-gray-100 dark:bg-gray-800 px-1">local-path</code> storage class which has no CSI snapshot capability.</span>
      </p>

      {/* ── status banner ── */}
      <div className={`rounded-lg border ${palette.border} ${palette.bg} px-4 py-3 flex items-start gap-2.5`} data-testid="mail-snapshot-status-banner">
        {palette.icon}
        <p className="text-sm text-gray-800 dark:text-gray-200">{palette.message(data)}</p>
      </div>

      {/* ── detail grid ── */}
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-4 space-y-3 text-sm">
        <div className="grid grid-cols-2 gap-3">
          {/* Schedule — inline editor */}
          <div className="space-y-0.5">
            <div className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400 flex items-center gap-1">
              Schedule
              {!editingSchedule && (
                <button
                  type="button"
                  onClick={() => {
                    setScheduleDraft(scheduleQuery.data?.data.scheduleExpression ?? data.scheduleExpression ?? '*/2 * * * *');
                    setEditingSchedule(true);
                  }}
                  aria-label="Edit schedule"
                  className="rounded p-0.5 text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
                  data-testid="mail-snapshot-schedule-edit"
                >
                  <Pencil size={11} />
                </button>
              )}
            </div>
            {editingSchedule ? (
              <div className="flex gap-1 items-center">
                <input
                  type="text"
                  value={scheduleDraft}
                  onChange={(e) => setScheduleDraft(e.target.value)}
                  data-testid="mail-snapshot-schedule-input"
                  className="flex-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-xs font-mono text-gray-900 dark:text-gray-100"
                />
                <button
                  type="button"
                  disabled={scheduleUpdate.isPending}
                  onClick={async () => {
                    await scheduleUpdate.mutateAsync({ scheduleExpression: scheduleDraft });
                    setEditingSchedule(false);
                  }}
                  data-testid="mail-snapshot-schedule-save"
                  className="rounded border border-brand-500 bg-brand-500 p-1 text-white disabled:opacity-50"
                >
                  {scheduleUpdate.isPending ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                </button>
                <button
                  type="button"
                  onClick={() => setEditingSchedule(false)}
                  className="rounded border border-gray-300 dark:border-gray-600 p-1 text-gray-500"
                >
                  <X size={12} />
                </button>
              </div>
            ) : (
              <div data-testid="mail-snapshot-schedule" className="font-mono text-sm text-gray-900 dark:text-gray-100">
                {data.enabled ? (scheduleQuery.data?.data.scheduleExpression ?? data.scheduleExpression ?? '(unknown)') : 'Disabled'}
              </div>
            )}
          </div>

          <KvRow
            label="Stored backups"
            value={String(data.snapshotCount)}
            testId="mail-snapshot-count"
          />
          <KvRow
            label="Last backup"
            value={
              data.lastSnapshotAt
                ? new Date(data.lastSnapshotAt).toLocaleString()
                : 'Never'
            }
            testId="mail-snapshot-last-at"
          />
          <KvRow
            label="Age"
            value={
              data.secondsSinceLastSnapshot != null
                ? `${formatAge(data.secondsSinceLastSnapshot)} ago`
                : '—'
            }
            testId="mail-snapshot-age"
          />
          <KvRow
            label="Total repo size"
            value={
              data.totalSnapshotSizeBytes != null
                ? formatBytes(data.totalSnapshotSizeBytes)
                : '—'
            }
            testId="mail-snapshot-total-size"
          />
          <KvRow
            label="Last backup size"
            value={
              data.lastSnapshotSizeBytes != null
                ? formatBytes(data.lastSnapshotSizeBytes)
                : '—'
            }
            testId="mail-snapshot-last-size"
          />
        </div>

        {/* Backup target — dropdown selector + setup CTA */}
        <div className="pt-1 border-t border-gray-200 dark:border-gray-700 space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
            <Database size={11} /> Backup target (restic repo)
          </div>
          {/* Phase 10 CTA: when no BackupStores are configured at all,
              the mail-snapshot CronJob effectively no-ops — data leaves
              the cluster only via the local-path PV's host disk, which
              is destroyed with the node. Surface that prominently as a
              call-to-action with a deep-link to Settings → Backups.
              This is the operator-facing fix for the silent-snapshot
              no-op on fresh installs (Phase 10 streamline). */}
          {!backupConfigsQuery.isLoading && (backupConfigsQuery.data?.data ?? []).length === 0 ? (
            <a
              href="/settings/backups"
              data-testid="mail-snapshot-backup-target-setup-cta"
              className="block rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 px-3 py-2.5 text-sm text-amber-800 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/30"
            >
              <div className="flex items-start gap-2">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <div className="flex-1">
                  <div className="font-medium">No backup target configured</div>
                  <div className="text-xs opacity-90 mt-0.5">
                    The 2-minute snapshot CronJob is silently no-op'ing. Go to
                    Settings → Backups to add a CIFS / S3 / Hetzner-Storage-Box
                    BackupStore, then return here to select it.
                  </div>
                </div>
              </div>
            </a>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <select
                  value={backupTargetQuery.data?.data.backupStoreId ?? ''}
                  onChange={async (e) => {
                    const val = e.target.value;
                    await backupTargetUpdate.mutateAsync({ backupStoreId: val || null });
                  }}
                  disabled={backupTargetUpdate.isPending || backupConfigsQuery.isLoading}
                  data-testid="mail-snapshot-backup-target-select"
                  className="flex-1 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1.5 text-sm text-gray-900 dark:text-gray-100"
                >
                  <option value="">(none — local CronJob only)</option>
                  {(backupConfigsQuery.data?.data ?? []).map((cfg) => (
                    <option key={cfg.id} value={cfg.id}>
                      {cfg.name} ({cfg.storageType})
                    </option>
                  ))}
                </select>
                {backupTargetUpdate.isPending && <Loader2 size={14} className="animate-spin text-gray-400" />}
              </div>
              {backupTargetQuery.data?.data.backupStoreId ? (
                <p className="text-xs text-green-700 dark:text-green-400">
                  Uploads to <strong>{backupTargetQuery.data.data.backupStoreName ?? backupTargetQuery.data.data.backupStoreId}</strong> via restic — deduplication enabled.
                </p>
              ) : (
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  No backup target selected. {(backupConfigsQuery.data?.data ?? []).length} BackupStore{(backupConfigsQuery.data?.data ?? []).length === 1 ? '' : 's'} available — pick one above or <a href="/settings/backups" className="underline">add another</a>.
                </p>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── job status panel (while/after trigger) ── */}
      {pendingJobName !== null && job.data ? (
        <SnapshotJobStatusPanel
          status={job.data.data}
          onClose={() => {
            if (
              job.data?.data.status === 'succeeded' ||
              job.data?.data.status === 'failed'
            ) {
              setPendingJobName(null);
            }
          }}
        />
      ) : null}

      {/* ── trigger error ── */}
      {trigger.isError ? (
        <div
          role="alert"
          data-testid="mail-snapshot-trigger-error"
          className="flex items-start gap-2.5 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2.5 text-sm text-red-700 dark:text-red-300"
        >
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>
            {trigger.error instanceof Error
              ? trigger.error.message
              : 'Trigger failed — see server logs.'}
          </span>
        </div>
      ) : null}

      {/* ── footer: trigger button ── */}
      <div className="flex items-center gap-3 pt-1">
        <button
          type="button"
          onClick={handleTrigger}
          disabled={trigger.isPending || pendingJobName !== null}
          data-testid="mail-snapshot-trigger-button"
          className="inline-flex items-center gap-2 rounded-lg border border-brand-500 bg-brand-500 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {trigger.isPending ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Play size={14} />
          )}
          {trigger.isPending ? 'Triggering…' : 'Run Backup Now'}
        </button>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Runs an immediate one-shot Job — does not affect the schedule.
        </p>
      </div>
    </div>
  );
}

// ── helpers ───────────────────────────────────────────────────────────────────

interface Palette {
  border: string;
  bg: string;
  badge: string;
  label: string;
  icon: React.ReactNode;
  message: (data: import('@k8s-hosting/api-contracts').MailSnapshotStatusResponse) => string;
}

function paletteForSnapshot(
  enabled: boolean,
  healthy: boolean,
  lastSnapshotAt: string | null,
): Palette {
  if (!enabled) {
    return {
      border: 'border-gray-200 dark:border-gray-700',
      bg: 'bg-gray-50 dark:bg-gray-900/20',
      badge: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300',
      label: 'Disabled',
      icon: <Archive size={14} className="mt-0.5 shrink-0 text-gray-500" />,
      message: () => 'Backups are not enabled (no CronJob found).',
    };
  }
  if (!lastSnapshotAt) {
    return {
      border: 'border-gray-200 dark:border-gray-700',
      bg: 'bg-gray-50 dark:bg-gray-900/20',
      badge: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300',
      label: 'No backups yet',
      icon: <Archive size={14} className="mt-0.5 shrink-0 text-gray-500" />,
      message: (d) =>
        `No backups recorded yet. The CronJob runs on schedule: ${d.scheduleExpression || '*/2 * * * *'}.`,
    };
  }
  if (healthy) {
    return {
      border: 'border-green-200 dark:border-green-800',
      bg: 'bg-green-50 dark:bg-green-900/20',
      badge: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200',
      label: 'Healthy',
      icon: <Check size={14} className="mt-0.5 shrink-0 text-green-600 dark:text-green-400" />,
      message: (d) => {
        const age = d.secondsSinceLastSnapshot != null
          ? ` Last backup: ${formatAge(d.secondsSinceLastSnapshot)} ago`
          : '';
        const size = d.lastSnapshotSizeBytes != null
          ? ` (${formatBytes(d.lastSnapshotSizeBytes)})`
          : '';
        return `Mail backups are running.${age}${size}.`;
      },
    };
  }
  // Stale: enabled, has a backup, but not healthy
  return {
    border: 'border-amber-300 dark:border-amber-700',
    bg: 'bg-amber-50 dark:bg-amber-900/20',
    badge: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
    label: 'Stale',
    icon: <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />,
    message: (d) => {
      const age = d.secondsSinceLastSnapshot != null
        ? `${formatAge(d.secondsSinceLastSnapshot)} ago`
        : 'unknown';
      return `Last backup was ${age} — check the backup CronJob.`;
    },
  };
}

interface KvRowProps {
  readonly label: string;
  readonly value: string;
  readonly testId: string;
}
function KvRow({ label, value, testId }: KvRowProps) {
  return (
    <div className="space-y-0.5">
      <div className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
        {label}
      </div>
      <div data-testid={testId} className="font-mono text-sm text-gray-900 dark:text-gray-100">
        {value}
      </div>
    </div>
  );
}

interface SnapshotJobStatusPanelProps {
  readonly status: MailSnapshotJobStatusResponse;
  readonly onClose: () => void;
}
function SnapshotJobStatusPanel({ status, onClose }: SnapshotJobStatusPanelProps) {
  const isTerminal = status.status === 'succeeded' || status.status === 'failed';
  return (
    <div
      role="status"
      data-testid="mail-snapshot-job-panel"
      className={`rounded-lg border-2 p-4 space-y-2 ${
        status.status === 'succeeded'
          ? 'border-green-300 bg-green-50 dark:bg-green-900/20'
          : status.status === 'failed'
          ? 'border-red-300 bg-red-50 dark:bg-red-900/20'
          : 'border-blue-300 bg-blue-50 dark:bg-blue-900/20'
      }`}
    >
      <div className="flex items-center gap-2">
        {status.status === 'succeeded' ? (
          <Check size={16} className="text-green-600" />
        ) : null}
        {status.status === 'failed' ? (
          <AlertTriangle size={16} className="text-red-600" />
        ) : null}
        {status.status === 'queued' || status.status === 'running' ? (
          <Loader2 size={14} className="animate-spin" />
        ) : null}
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          Backup Job: <code>{status.jobName}</code>
        </h3>
        <span
          data-testid="mail-snapshot-job-status"
          className="ml-2 rounded bg-gray-200 dark:bg-gray-800 px-2 py-0.5 text-xs"
        >
          {status.status}
        </span>
        {isTerminal ? (
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded p-1 text-gray-500 hover:bg-white/50 dark:hover:bg-gray-800"
            aria-label="Dismiss"
          >
            <X size={14} />
          </button>
        ) : null}
      </div>
      {status.failureReason ? (
        <div className="text-sm text-red-700 dark:text-red-300 font-mono">
          {status.failureReason}
        </div>
      ) : null}
      {status.podLogTail ? (
        <pre
          data-testid="mail-snapshot-job-log"
          className="rounded bg-gray-900 text-gray-100 p-3 text-xs overflow-auto max-h-48 font-mono"
        >
          {status.podLogTail}
        </pre>
      ) : null}
    </div>
  );
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function formatBytes(b: number): string {
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GiB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(2)} MiB`;
  if (b >= 1024) return `${(b / 1024).toFixed(2)} KiB`;
  return `${b} B`;
}
