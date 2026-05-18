/**
 * Mail object-backup card on /backups/system → Object Backups tab.
 *
 * Renders the resolved restic target, last-run stats, and a
 * "Trigger snapshot now" button. Schedule lives in the sibling
 * ScheduleCard component. Backup target binding lives in
 * /settings/backup-infrastructure → Classes → system_mail.
 */

import { Link } from 'react-router-dom';
import { Check, AlertTriangle, Mail, Play, Loader2 } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { SystemBackupsOverview, MailSnapshotTriggerResponse } from '@k8s-hosting/api-contracts';

function formatBytes(b: number): string {
  if (b === 0) return '0 B';
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GiB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(2)} MiB`;
  if (b >= 1024) return `${(b / 1024).toFixed(2)} KiB`;
  return `${b} B`;
}

function formatAge(seconds: number | null): string {
  if (seconds === null) return 'never';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export default function MailObjectBackupCard({ ov, loading }: { ov: SystemBackupsOverview | undefined; loading: boolean }) {
  const qc = useQueryClient();
  const trigger = useMutation({
    mutationFn: () => apiFetch<{ data: MailSnapshotTriggerResponse }>('/api/v1/admin/mail/snapshot/trigger', {
      method: 'POST',
      body: JSON.stringify({}),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'backups', 'system', 'overview'] });
    },
  });

  const m = ov?.objectBackups.mail;

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm space-y-3" data-testid="mail-object-backup-card">
      <div className="flex items-center gap-2">
        <Mail size={18} className="text-gray-600 dark:text-gray-300" />
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Stalwart RocksDB (restic)</h3>
        {m?.targetName ? (
          <span className="ml-auto inline-flex items-center gap-1 rounded bg-green-100 dark:bg-green-900/40 px-2 py-0.5 text-xs font-medium text-green-800 dark:text-green-200">
            <Check size={11} /> {m.targetName}
          </span>
        ) : (
          <span className="ml-auto inline-flex items-center gap-1 rounded bg-amber-100 dark:bg-amber-900/40 px-2 py-0.5 text-xs font-medium text-amber-800 dark:text-amber-200">
            <AlertTriangle size={11} /> No target
          </span>
        )}
      </div>

      <p className="text-sm text-gray-500 dark:text-gray-400">
        File-level restic backup of the mail data directory. Dedup-friendly — incrementals are KB-scale
        even when the database mutates between runs.{' '}
        <Link to="/settings/backup-infrastructure?tab=classes" className="font-medium text-brand-600 dark:text-brand-400 hover:underline">
          Manage in Backup Classes →
        </Link>
      </p>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3" data-testid="mail-object-backup-stats">
        <Kv label="Stored snapshots" value={loading ? '…' : String(m?.snapshotCount ?? 0)} />
        <Kv label="Total repo size" value={loading ? '…' : formatBytes(m?.totalSnapshotSizeBytes ?? 0)} />
        <Kv label="Last run" value={loading
          ? '…'
          : m?.lastRunAt
          ? `${formatAge(m.secondsSinceLastRun)} ago`
          : 'Never'} />
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={trigger.isPending || !m?.targetName}
          onClick={() => trigger.mutate()}
          data-testid="mail-object-backup-trigger"
          className="inline-flex items-center gap-2 rounded-lg border border-brand-500 bg-brand-500 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-brand-600 disabled:opacity-50"
        >
          {trigger.isPending ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
          Trigger snapshot now
        </button>
        {trigger.isError && (
          <span className="text-xs text-rose-600 dark:text-rose-400">
            {trigger.error instanceof Error ? trigger.error.message : 'Trigger failed'}
          </span>
        )}
      </div>
    </div>
  );
}

function Kv({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">{label}</div>
      <div className="mt-1 font-mono text-sm text-gray-900 dark:text-gray-100">{value}</div>
    </div>
  );
}
