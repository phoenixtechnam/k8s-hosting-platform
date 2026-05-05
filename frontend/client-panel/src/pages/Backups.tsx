import { useEffect, useState } from 'react';
import { Archive, Calendar, Download, Lock, Loader2, AlertCircle, CheckCircle2, Trash2 } from 'lucide-react';
import {
  useTenantBundles,
  useTenantSchedule,
  useUpdateTenantSchedule,
  downloadTenantDataExport,
} from '@/hooks/use-tenant-backups';

function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes === 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function StatusBadge({ status }: { readonly status: string }) {
  const colorMap: Record<string, string> = {
    completed: 'bg-green-50 text-green-700 border-green-200 dark:bg-green-900/40 dark:text-green-300 dark:border-green-700',
    running: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/40 dark:text-blue-300 dark:border-blue-700',
    pending: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-700',
    partial: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-700',
    failed: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-900/40 dark:text-red-300 dark:border-red-700',
    expired: 'bg-gray-50 text-gray-600 border-gray-200 dark:bg-gray-700 dark:text-gray-400 dark:border-gray-600',
  };
  const colors = colorMap[status.toLowerCase()] ?? 'bg-gray-50 text-gray-600 border-gray-200 dark:bg-gray-700 dark:text-gray-400 dark:border-gray-600';
  return <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${colors}`}>{status}</span>;
}

export default function Backups() {
  const bundlesQ = useTenantBundles();
  const bundles = bundlesQ.data?.data ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-50 text-blue-600 dark:bg-blue-900/40 dark:text-blue-400">
          <Archive size={20} />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100" data-testid="backups-heading">
            Backups
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">Your tenant bundles, schedule, and GDPR data exports.</p>
        </div>
      </div>

      <ScheduleEditor />

      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm">
        {bundlesQ.isLoading && (
          <div className="flex items-center justify-center py-16" data-testid="backups-loading">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-200 border-t-blue-600" />
            <span className="ml-3 text-sm text-gray-500 dark:text-gray-400">Loading bundles…</span>
          </div>
        )}
        {bundlesQ.isError && (
          <div className="px-6 py-16 text-center" data-testid="backups-error">
            <p className="text-sm text-red-600">Failed to load bundles: {(bundlesQ.error as Error)?.message ?? 'Unknown error'}</p>
          </div>
        )}
        {!bundlesQ.isLoading && !bundlesQ.isError && bundles.length === 0 && (
          <div className="px-6 py-16 text-center" data-testid="backups-empty">
            <Archive size={40} className="mx-auto text-gray-300 dark:text-gray-600" />
            <p className="mt-3 text-sm font-medium text-gray-900 dark:text-gray-100">No bundles yet</p>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Your scheduled and manually-triggered tenant bundles will appear here.
            </p>
          </div>
        )}
        {!bundlesQ.isLoading && !bundlesQ.isError && bundles.length > 0 && (
          <div className="overflow-x-auto" data-testid="backups-table">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/50">
                  <th className="px-6 py-3 font-medium text-gray-500 dark:text-gray-400">Bundle</th>
                  <th className="px-6 py-3 font-medium text-gray-500 dark:text-gray-400">Initiator</th>
                  <th className="px-6 py-3 font-medium text-gray-500 dark:text-gray-400">Status</th>
                  <th className="hidden px-6 py-3 font-medium text-gray-500 dark:text-gray-400 sm:table-cell">Size</th>
                  <th className="hidden px-6 py-3 font-medium text-gray-500 dark:text-gray-400 lg:table-cell">Created</th>
                  <th className="hidden px-6 py-3 font-medium text-gray-500 dark:text-gray-400 lg:table-cell">Expires</th>
                  <th className="px-6 py-3 font-medium text-gray-500 dark:text-gray-400">Export</th>
                </tr>
              </thead>
              <tbody>
                {bundles.map((b) => (
                  <tr key={b.id} className="border-b border-gray-100 dark:border-gray-700 last:border-0">
                    <td className="px-6 py-3 font-mono text-xs text-gray-900 dark:text-gray-100">
                      {b.label ?? b.id.slice(0, 12)}
                    </td>
                    <td className="px-6 py-3 text-gray-600 dark:text-gray-400">{b.initiator}</td>
                    <td className="px-6 py-3"><StatusBadge status={b.status} /></td>
                    <td className="hidden px-6 py-3 text-gray-600 dark:text-gray-400 sm:table-cell">{formatBytes(b.sizeBytes)}</td>
                    <td className="hidden px-6 py-3 text-gray-500 dark:text-gray-400 lg:table-cell">{new Date(b.createdAt).toLocaleString()}</td>
                    <td className="hidden px-6 py-3 text-gray-500 dark:text-gray-400 lg:table-cell">
                      {b.expiresAt ? new Date(b.expiresAt).toLocaleDateString() : '-'}
                    </td>
                    <td className="px-6 py-3">
                      {b.exportArtifact && b.status === 'completed' ? (
                        <button
                          type="button"
                          onClick={async () => {
                            try { await downloadTenantDataExport(b.id); }
                            catch (e) { window.alert(`Download failed: ${(e as Error).message}`); }
                          }}
                          className="inline-flex items-center gap-1 rounded-md border border-purple-300 px-2 py-1 text-xs font-medium text-purple-700 hover:bg-purple-50 dark:border-purple-700 dark:text-purple-300 dark:hover:bg-purple-950"
                          title="Download the encrypted GDPR data-export. Decrypt locally with the passphrase you set at create time."
                        >
                          <Download size={12} /> Download <Lock size={10} />
                        </button>
                      ) : (
                        <span className="text-xs text-gray-400">-</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function ScheduleEditor() {
  const q = useTenantSchedule();
  const upd = useUpdateTenantSchedule();
  const [enabled, setEnabled] = useState(false);
  const [frequency, setFrequency] = useState<'daily' | 'weekly' | 'monthly'>('weekly');
  const [hourOfDayUtc, setHourOfDayUtc] = useState(3);
  const [retentionDays, setRetentionDays] = useState(14);

  useEffect(() => {
    const s = q.data?.data;
    if (s) {
      setEnabled(s.enabled);
      setFrequency(s.frequency);
      setHourOfDayUtc(s.hourOfDayUtc);
      setRetentionDays(s.retentionDays);
    }
  }, [q.data?.data]);

  const onSave = () => upd.mutate({ enabled, frequency, hourOfDayUtc, retentionDays });

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <header className="mb-3 flex items-center gap-2">
        <Calendar className="h-5 w-5 text-blue-600" />
        <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Backup schedule</h2>
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
            Capped by your hosting plan&apos;s retention max. The platform ticks every 5 minutes; the chosen hour is advisory.
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
              className="flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {upd.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Save schedule
            </button>
          </div>
        </div>
      )}
      <div className="hidden">{/* keep Trash2 import live for future delete-schedule UI */}<Trash2 /></div>
    </section>
  );
}
