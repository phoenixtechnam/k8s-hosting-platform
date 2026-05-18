/**
 * Per-subsystem schedule card — surfaces the new
 * /admin/backups/schedules/:subsystem endpoint with an Enable/Disable
 * toggle, cron expression input, and retention controls.
 *
 * Strict-gate UX: when the API says `gateSatisfied=false`, the Enable
 * toggle is disabled and an info banner explains the next step.
 *
 * Used on /backups/system (Object Backups tab) for mail + pitr +
 * longhorn_recurring; on /backups/tenants (Schedule tab) for
 * tenant_bundle.
 */

import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, AlertTriangle, Save, Power, PowerOff } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import type { BackupScheduleRow } from '@k8s-hosting/api-contracts';

interface Props {
  readonly subsystem: 'mail' | 'tenant_bundle' | 'system_pitr' | 'longhorn_recurring';
  readonly title: string;
  readonly description: string;
}

export default function ScheduleCard({ subsystem, title, description }: Props) {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin', 'backups', 'schedules', subsystem],
    queryFn: () => apiFetch<{ data: BackupScheduleRow }>(`/api/v1/admin/backups/schedules/${subsystem}`),
    staleTime: 10_000,
  });
  const row = data?.data;

  const mutation = useMutation({
    mutationFn: (patch: Partial<Pick<BackupScheduleRow, 'enabled' | 'cronExpression' | 'retentionDays' | 'retentionCount'>>) =>
      apiFetch<{ data: BackupScheduleRow }>(`/api/v1/admin/backups/schedules/${subsystem}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'backups', 'schedules'] });
      qc.invalidateQueries({ queryKey: ['admin', 'backups', 'system', 'overview'] });
    },
  });

  const [cronDraft, setCronDraft] = useState('');
  const [retentionDaysDraft, setRetentionDaysDraft] = useState('');
  const [retentionCountDraft, setRetentionCountDraft] = useState('');

  useEffect(() => {
    if (row) {
      setCronDraft(row.cronExpression ?? '');
      setRetentionDaysDraft(row.retentionDays?.toString() ?? '');
      setRetentionCountDraft(row.retentionCount?.toString() ?? '');
    }
  }, [row]);

  const cronDirty = !!row && cronDraft !== (row.cronExpression ?? '');
  const retentionDaysDirty = !!row && retentionDaysDraft !== (row.retentionDays?.toString() ?? '');
  const retentionCountDirty = !!row && retentionCountDraft !== (row.retentionCount?.toString() ?? '');
  const dirty = cronDirty || retentionDaysDirty || retentionCountDirty;

  if (isLoading) {
    return (
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm">
        <div className="flex items-center gap-2 text-sm text-gray-500"><Loader2 size={14} className="animate-spin" /> Loading schedule…</div>
      </div>
    );
  }
  if (error || !row) {
    return (
      <div className="rounded-xl border border-rose-200 dark:border-rose-700 bg-rose-50 dark:bg-rose-900/20 p-4 text-sm text-rose-700 dark:text-rose-300">
        Failed to load schedule: {error instanceof Error ? error.message : 'unknown error'}
      </div>
    );
  }

  const blockedReason = !row.gateSatisfied
    ? `Configure a backup target and assign it to the '${row.gatedByClass}' class before enabling.`
    : null;

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm space-y-3" data-testid={`schedule-card-${subsystem}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{description}</p>
        </div>
        <button
          type="button"
          onClick={() => mutation.mutate({ enabled: !row.enabled })}
          disabled={mutation.isPending || (!row.enabled && !row.gateSatisfied)}
          data-testid={`schedule-toggle-${subsystem}`}
          className={[
            'inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors',
            row.enabled
              ? 'border-green-300 dark:border-green-700 bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300 hover:bg-green-100'
              : 'border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50',
            mutation.isPending ? 'opacity-50' : '',
          ].join(' ')}
        >
          {mutation.isPending ? <Loader2 size={14} className="animate-spin" /> : row.enabled ? <Power size={14} /> : <PowerOff size={14} />}
          {row.enabled ? 'Enabled' : 'Disabled'}
        </button>
      </div>

      {blockedReason && (
        <div className="rounded-lg border border-amber-200 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-sm text-amber-800 dark:text-amber-200" data-testid={`schedule-gate-${subsystem}`}>
          <div className="flex items-start gap-2">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <div>
              <div>Cannot enable yet: {blockedReason}</div>
              <Link to="/settings/backup-infrastructure?tab=classes" className="mt-1 inline-block font-medium underline">
                Configure in Backup Infrastructure → Classes →
              </Link>
            </div>
          </div>
        </div>
      )}

      {mutation.isError && (
        <div className="rounded-lg border border-rose-200 dark:border-rose-700 bg-rose-50 dark:bg-rose-900/20 px-3 py-2 text-sm text-rose-700 dark:text-rose-300">
          {mutation.error instanceof Error ? mutation.error.message : 'Schedule update failed'}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div>
          <label className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400" htmlFor={`cron-${subsystem}`}>Cron expression</label>
          <input
            id={`cron-${subsystem}`}
            type="text"
            value={cronDraft}
            onChange={(e) => setCronDraft(e.target.value)}
            placeholder="0 2 * * *"
            data-testid={`schedule-cron-${subsystem}`}
            className="mt-1 w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1.5 font-mono text-sm text-gray-900 dark:text-gray-100"
          />
        </div>
        <div>
          <label className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400" htmlFor={`retdays-${subsystem}`}>Retention (days)</label>
          <input
            id={`retdays-${subsystem}`}
            type="number"
            min={0}
            value={retentionDaysDraft}
            onChange={(e) => setRetentionDaysDraft(e.target.value)}
            data-testid={`schedule-retention-days-${subsystem}`}
            className="mt-1 w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1.5 text-sm text-gray-900 dark:text-gray-100"
          />
        </div>
        <div>
          <label className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400" htmlFor={`retcount-${subsystem}`}>Retention (keep last N)</label>
          <input
            id={`retcount-${subsystem}`}
            type="number"
            min={0}
            value={retentionCountDraft}
            onChange={(e) => setRetentionCountDraft(e.target.value)}
            data-testid={`schedule-retention-count-${subsystem}`}
            className="mt-1 w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1.5 text-sm text-gray-900 dark:text-gray-100"
          />
        </div>
      </div>

      {dirty && (
        <div className="flex justify-end">
          <button
            type="button"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate({
              cronExpression: cronDirty ? (cronDraft || null) : undefined,
              retentionDays: retentionDaysDirty ? (retentionDaysDraft ? parseInt(retentionDaysDraft, 10) : null) : undefined,
              retentionCount: retentionCountDirty ? (retentionCountDraft ? parseInt(retentionCountDraft, 10) : null) : undefined,
            })}
            data-testid={`schedule-save-${subsystem}`}
            className="inline-flex items-center gap-2 rounded-lg border border-brand-500 bg-brand-500 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-brand-600 disabled:opacity-50"
          >
            <Save size={14} />
            Save schedule
          </button>
        </div>
      )}
    </div>
  );
}
