/**
 * Per-client backup schedule editor. Surfaced on the ClientDetail
 * page so an operator can flip a switch + pick frequency without
 * touching the DB.
 *
 * The Tier-1 scheduler tick (backups-v2/schedule.ts) reads this
 * row every 5 min; saves take effect on the next tick.
 */

import { useEffect, useState } from 'react';
import { Calendar, Loader2, AlertCircle, CheckCircle2, Trash2 } from 'lucide-react';
import {
  useClientBackupSchedule,
  useUpdateClientBackupSchedule,
  useDeleteClientBackupSchedule,
} from '@/hooks/use-backup-schedule';

interface Props { clientId: string }

export function BackupScheduleEditor({ clientId }: Props) {
  const q = useClientBackupSchedule(clientId);
  const upd = useUpdateClientBackupSchedule(clientId);
  const del = useDeleteClientBackupSchedule(clientId);

  const [enabled, setEnabled] = useState(false);
  const [frequency, setFrequency] = useState<'daily' | 'weekly' | 'monthly'>('weekly');
  const [hourOfDayUtc, setHourOfDayUtc] = useState(3);
  const [retentionDays, setRetentionDays] = useState(14);

  // Hydrate from server data once it lands.
  useEffect(() => {
    const s = q.data?.data;
    if (s) {
      setEnabled(s.enabled);
      setFrequency(s.frequency);
      setHourOfDayUtc(s.hourOfDayUtc);
      setRetentionDays(s.retentionDays);
    }
  }, [q.data?.data]);

  const onSave = () => {
    upd.mutate({ enabled, frequency, hourOfDayUtc, retentionDays });
  };

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <header className="mb-3 flex items-center gap-2">
        <Calendar className="h-5 w-5 text-brand-600" />
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Backup schedule</h3>
        {q.data?.data?.lastRunStatus && (
          <span className={`ml-auto text-xs ${q.data.data.lastRunStatus === 'completed' ? 'text-green-700' : q.data.data.lastRunStatus === 'failed' ? 'text-red-700' : 'text-gray-500'}`}>
            Last: {q.data.data.lastRunStatus}{q.data.data.lastRunAt ? ` · ${new Date(q.data.data.lastRunAt).toLocaleString()}` : ''}
          </span>
        )}
      </header>
      {q.isLoading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : (
        <div className="space-y-3 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <span>Enable scheduled bundles</span>
          </label>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <label className="flex flex-col">
              <span className="mb-1 text-xs text-gray-500 dark:text-gray-400">Frequency</span>
              <select
                value={frequency}
                onChange={(e) => setFrequency(e.target.value as 'daily' | 'weekly' | 'monthly')}
                disabled={!enabled}
                className="rounded-md border border-gray-300 bg-white px-2 py-1 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 disabled:opacity-50"
              >
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </label>
            <label className="flex flex-col">
              <span className="mb-1 text-xs text-gray-500 dark:text-gray-400">Hour (UTC)</span>
              <input
                type="number"
                min={0}
                max={23}
                value={hourOfDayUtc}
                onChange={(e) => setHourOfDayUtc(Number(e.target.value))}
                disabled={!enabled}
                className="rounded-md border border-gray-300 bg-white px-2 py-1 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 disabled:opacity-50"
              />
            </label>
            <label className="flex flex-col">
              <span className="mb-1 text-xs text-gray-500 dark:text-gray-400">Retention (days)</span>
              <input
                type="number"
                min={1}
                max={3650}
                value={retentionDays}
                onChange={(e) => setRetentionDays(Number(e.target.value))}
                className="rounded-md border border-gray-300 bg-white px-2 py-1 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
              />
            </label>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            The scheduler ticks every 5 min. With weekly + 03:00 UTC, the next bundle fires on the first tick after 7 days from <code className="rounded bg-gray-100 px-1 dark:bg-gray-700">last_run_at</code>; the hour is advisory.
          </p>
          {upd.error && (
            <div className="flex items-start gap-1 rounded-md bg-red-50 p-2 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
              <AlertCircle className="h-4 w-4 flex-shrink-0" />
              <span>{(upd.error as Error).message}</span>
            </div>
          )}
          {upd.isSuccess && !upd.isPending && (
            <div className="flex items-center gap-1 text-xs text-green-700 dark:text-green-300">
              <CheckCircle2 className="h-4 w-4" /> Saved
            </div>
          )}
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={onSave}
              disabled={upd.isPending}
              className="flex items-center gap-1 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {upd.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Save schedule
            </button>
            {q.data?.data && (
              <button
                type="button"
                onClick={() => { if (window.confirm('Remove this client\'s backup schedule? Existing bundles are not affected.')) del.mutate(); }}
                className="flex items-center gap-1 rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 dark:border-red-700 dark:text-red-300 dark:hover:bg-red-950"
              >
                <Trash2 className="h-4 w-4" /> Remove
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
