import { useState } from 'react';
import {
  AlertTriangle,
  Archive,
  CheckCircle,
  Clock,
  Loader2,
  Play,
  RotateCcw,
  X,
} from 'lucide-react';
import {
  useMailArchiveStatus,
  useMailArchiveList,
  useMailArchiveRun,
  useMailArchiveSchedule,
  useTriggerMailArchive,
  useUpdateMailArchiveSchedule,
  useRestoreMailArchive,
} from '@/hooks/use-mail-archive';
import type {
  MailArchiveMode,
  MailArchiveRun,
  MailArchiveScheduleInterval,
} from '@k8s-hosting/api-contracts';

/**
 * Email Management → Mail Archive card.
 *
 * Operator-triggered Stalwart-native (`stalwart -e`) archives.
 *
 * Two modes (operator picks at trigger time, default is no_downtime):
 *
 *   no_downtime  — Job opens the live RocksDB as a SECONDARY instance,
 *                  takes a hard-linked Checkpoint, then runs `stalwart -e`
 *                  against the checkpoint. Live Stalwart keeps serving
 *                  SMTP/IMAP. Wall time: seconds.
 *
 *   downtime     — Scales stalwart-mail to 0 to release the RocksDB
 *                  LOCK, runs `stalwart -e` directly, scales back.
 *                  ~60-120s mail downtime. Use only if the no_downtime
 *                  path is unavailable.
 *
 * Both modes ship the LZ4 via restic to the configured backup target.
 *
 * Restore always uses the downtime dance: `stalwart -i` writes into an
 * empty primary, which would conflict with a live Stalwart's LOCK.
 *
 * Vocabulary: we use "archive" / "backup" in operator-facing copy. The
 * word "snapshot" is reserved for K8s VolumeSnapshot CRDs which don't
 * apply to the mail PVC (local-path has no CSI snapshot capability).
 */
export default function MailArchiveCard() {
  const status = useMailArchiveStatus();
  const list = useMailArchiveList(20, 0);
  const trigger = useTriggerMailArchive();
  const restore = useRestoreMailArchive();

  const [pendingRunId, setPendingRunId] = useState<string | null>(null);
  const [showTriggerConfirm, setShowTriggerConfirm] = useState(false);
  const [triggerMode, setTriggerMode] = useState<MailArchiveMode>('no_downtime');
  const [restoreSource, setRestoreSource] = useState<MailArchiveRun | null>(null);

  // Auto-track the in-flight run from the status payload so a page reload
  // re-opens the progress modal mid-flight.
  const inFlight = status.data?.data.current;
  const activeRunId = pendingRunId ?? inFlight?.id ?? null;
  const runPoll = useMailArchiveRun(activeRunId);

  if (status.isLoading) {
    return (
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm p-5">
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <Loader2 size={14} className="animate-spin" /> Loading archive status…
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
            Could not read archive status.{' '}
            {status.error instanceof Error ? status.error.message : 'See server logs.'}
          </div>
        </div>
      </div>
    );
  }

  const data = status.data.data;
  const noTarget = !data.backupTarget.backupStoreId;

  const handleTriggerConfirm = async () => {
    try {
      const r = await trigger.mutateAsync({ mode: triggerMode });
      setPendingRunId(r.data.runId);
      setShowTriggerConfirm(false);
    } catch {
      // surfaced via trigger.error
    }
  };

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm p-5 space-y-4">
      {/* ── header ── */}
      <div className="flex items-center gap-3">
        <Archive size={20} className="text-gray-700 dark:text-gray-300" />
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          Mail Archive (app-level, point-in-time)
        </h2>
      </div>

      <p className="text-sm text-gray-600 dark:text-gray-400">
        Store-agnostic LZ4 export via Stalwart&apos;s own{' '}
        <code className="rounded bg-gray-100 dark:bg-gray-800 px-1">stalwart -e</code>. The default{' '}
        <strong>no-downtime</strong> path opens RocksDB as a secondary, takes a hard-linked checkpoint,
        and exports from there — live Stalwart keeps serving SMTP/IMAP throughout. Use for weekly
        archival, pre-upgrade safety points, or long-term retention. A fallback{' '}
        <strong>downtime</strong> mode (scale to 0, export, scale back, ~60–120s mail downtime) is
        available if the no-downtime path is unavailable.
      </p>

      {/* Scheduled-archiving callout */}
      {!data.scheduledArchivingAvailable && data.scheduledArchivingBlockedBy ? (
        <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 px-3 py-2.5 text-xs text-blue-700 dark:text-blue-300 flex items-start gap-2">
          <Clock size={12} className="mt-0.5 shrink-0" />
          <span>
            <strong>Scheduled archives not yet available.</strong>{' '}
            {data.scheduledArchivingBlockedBy}
          </span>
        </div>
      ) : null}

      {/* Backup-target warning */}
      {noTarget ? (
        <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-3 py-2.5 text-xs text-amber-700 dark:text-amber-300 flex items-start gap-2">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span>
            No backup target configured. Pick one in the Mail Backup card above before triggering an
            archive — without it, the export has nowhere to go.
          </span>
        </div>
      ) : (
        <div className="text-xs text-gray-500 dark:text-gray-400">
          Target: <strong>{data.backupTarget.backupStoreName}</strong> ({data.backupTarget.storageType})
        </div>
      )}

      {/* ── stats grid ── */}
      <div className="grid grid-cols-2 gap-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-4">
        <Stat label="Last archive">
          {data.last ? (
            <>
              <div className="text-sm text-gray-900 dark:text-gray-100">
                {new Date(data.last.startedAt).toLocaleString()}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                state: <StateBadge state={data.last.state} />
              </div>
            </>
          ) : (
            <span className="text-sm text-gray-400">Never</span>
          )}
        </Stat>
        <Stat label="Last archive size">
          <span className="text-sm text-gray-900 dark:text-gray-100 font-mono">
            {formatBytes(data.last?.exportSizeBytes)}
          </span>
        </Stat>
        <Stat label="restic snapshot id">
          <code className="text-xs text-gray-700 dark:text-gray-300">
            {data.last?.resticSnapshotId ?? '—'}
          </code>
        </Stat>
        <Stat label="Bytes added (last run)">
          <span className="text-sm text-gray-900 dark:text-gray-100 font-mono">
            {formatBytes(data.last?.resticAddedBytes)}
          </span>
        </Stat>
      </div>

      {/* ── trigger controls: mode picker + button ── */}
      <div className="space-y-3">
        <fieldset className="space-y-1.5">
          <legend className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
            Mode
          </legend>
          <div className="flex flex-wrap gap-2">
            <label
              className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm cursor-pointer flex-1 min-w-[260px] ${
                triggerMode === 'no_downtime'
                  ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/20'
                  : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900'
              }`}
            >
              <input
                type="radio"
                name="archive-mode"
                value="no_downtime"
                checked={triggerMode === 'no_downtime'}
                onChange={() => setTriggerMode('no_downtime')}
                disabled={Boolean(activeRunId)}
                data-testid="mail-archive-mode-no-downtime"
                className="mt-0.5"
              />
              <span>
                <strong className="text-gray-900 dark:text-gray-100">No downtime</strong>{' '}
                <span className="text-xs text-gray-500 dark:text-gray-400">(default, recommended)</span>
                <div className="text-xs text-gray-600 dark:text-gray-400 mt-0.5">
                  RocksDB secondary + Checkpoint. Live mail keeps serving.
                </div>
              </span>
            </label>
            <label
              className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm cursor-pointer flex-1 min-w-[260px] ${
                triggerMode === 'downtime'
                  ? 'border-amber-500 bg-amber-50 dark:bg-amber-900/20'
                  : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900'
              }`}
            >
              <input
                type="radio"
                name="archive-mode"
                value="downtime"
                checked={triggerMode === 'downtime'}
                onChange={() => setTriggerMode('downtime')}
                disabled={Boolean(activeRunId)}
                data-testid="mail-archive-mode-downtime"
                className="mt-0.5"
              />
              <span>
                <strong className="text-gray-900 dark:text-gray-100">With downtime</strong>{' '}
                <span className="text-xs text-amber-700 dark:text-amber-400">(fallback)</span>
                <div className="text-xs text-gray-600 dark:text-gray-400 mt-0.5">
                  Scale Stalwart to 0, export, scale back. ~60–120s downtime.
                </div>
              </span>
            </label>
          </div>
        </fieldset>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setShowTriggerConfirm(true)}
            disabled={Boolean(activeRunId) || noTarget || trigger.isPending}
            data-testid="mail-archive-trigger"
            className="inline-flex items-center gap-2 rounded-lg border border-brand-500 bg-brand-500 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {trigger.isPending ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            Create Archive Now
          </button>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {activeRunId
              ? 'A run is in progress — see modal below.'
              : noTarget
                ? 'Configure a backup target before triggering.'
                : triggerMode === 'downtime'
                  ? 'Will incur ~60–120s mail downtime.'
                  : 'Live mail keeps serving throughout.'}
          </p>
        </div>
      </div>

      {trigger.isError ? (
        <div role="alert" className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {trigger.error instanceof Error ? trigger.error.message : 'Trigger failed'}
        </div>
      ) : null}

      {/* ── archive schedule ── */}
      <ScheduleEditor disabled={Boolean(activeRunId)} />

      {/* ── archive list ── */}
      <ArchiveList
        runs={list.data?.data.data ?? []}
        loading={list.isLoading}
        onRestore={(run) => setRestoreSource(run)}
      />

      {/* ── live run modal ── */}
      {activeRunId && runPoll.data ? (
        <RunProgressModal
          run={runPoll.data.data}
          onClose={() => {
            const s = runPoll.data?.data.state;
            if (s === 'succeeded' || s === 'failed') {
              setPendingRunId(null);
            }
          }}
        />
      ) : null}

      {/* ── trigger confirm modal ── */}
      {showTriggerConfirm ? (
        <ConfirmModal
          title={
            triggerMode === 'no_downtime'
              ? 'Create no-downtime archive?'
              : 'Create archive (will incur mail downtime)?'
          }
          body={
            triggerMode === 'no_downtime' ? (
              <>
                This will, with <strong>no mail downtime</strong>:
                <ol className="list-decimal ml-5 mt-2 space-y-1">
                  <li>Open the live RocksDB data dir as a <strong>secondary</strong> instance (no LOCK conflict).</li>
                  <li>Take a hard-linked <strong>Checkpoint</strong> into a Job-local emptyDir.</li>
                  <li>Run <code className="rounded bg-gray-100 dark:bg-gray-800 px-1">stalwart -e</code> against the checkpoint dir.</li>
                  <li>Upload the LZ4 to <strong>{data.backupTarget.backupStoreName ?? data.backupTarget.backupStoreId}</strong>.</li>
                </ol>
                <p className="mt-2 text-gray-600 dark:text-gray-400 text-xs">
                  Live Stalwart keeps serving SMTP/IMAP throughout. Wall time is a few seconds plus the
                  restic upload.
                </p>
              </>
            ) : (
              <>
                This will:
                <ol className="list-decimal ml-5 mt-2 space-y-1">
                  <li>Scale the Stalwart Deployment to <strong>0 replicas</strong>.</li>
                  <li>Wait for the running pod to terminate (releases RocksDB LOCK).</li>
                  <li>Run <code className="rounded bg-gray-100 dark:bg-gray-800 px-1">stalwart -e</code> in a one-shot Job.</li>
                  <li>Upload the LZ4 to <strong>{data.backupTarget.backupStoreName ?? data.backupTarget.backupStoreId}</strong>.</li>
                  <li>Scale Stalwart back up to {data.last?.originalReplicas ?? 1} replica(s).</li>
                </ol>
                <p className="mt-2 text-amber-600 dark:text-amber-400 text-xs">
                  <strong>~60–120s of mail downtime is expected.</strong> SMTP retries from senders will
                  resume delivery; IMAP/JMAP clients will reconnect automatically.
                </p>
              </>
            )
          }
          confirmLabel="Yes, create archive"
          danger={triggerMode === 'downtime'}
          busy={trigger.isPending}
          onConfirm={handleTriggerConfirm}
          onCancel={() => setShowTriggerConfirm(false)}
        />
      ) : null}

      {/* ── restore confirm modal ── */}
      {restoreSource ? (
        <RestoreConfirmModal
          source={restoreSource}
          targetName={data.backupTarget.backupStoreName ?? '(target)'}
          busy={restore.isPending}
          error={restore.error}
          onConfirm={async () => {
            try {
              const r = await restore.mutateAsync({
                runId: restoreSource.id,
                confirm: 'yes-replace-live-mail',
              });
              setPendingRunId(r.data.runId);
              setRestoreSource(null);
            } catch {
              /* surfaced via restore.error */
            }
          }}
          onCancel={() => {
            restore.reset();
            setRestoreSource(null);
          }}
        />
      ) : null}
    </div>
  );
}

// ── sub-components ─────────────────────────────────────────────────────────

function ScheduleEditor({ disabled }: { readonly disabled: boolean }) {
  const schedule = useMailArchiveSchedule();
  const updater = useUpdateMailArchiveSchedule();

  const data = schedule.data?.data;
  const [draftInterval, setDraftInterval] = useState<MailArchiveScheduleInterval | null>(null);
  const [draftHour, setDraftHour] = useState<number | null>(null);
  const [draftWeekday, setDraftWeekday] = useState<number | null>(null);

  if (schedule.isLoading || !data) {
    return (
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-4">
        <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
          <Loader2 size={12} className="animate-spin" /> Loading schedule…
        </div>
      </div>
    );
  }

  const interval = draftInterval ?? data.interval;
  const hourUtc = draftHour ?? data.hourUtc;
  const weekdayUtc = draftWeekday ?? data.weekdayUtc;
  const dirty =
    interval !== data.interval || hourUtc !== data.hourUtc || weekdayUtc !== data.weekdayUtc;

  const save = async () => {
    try {
      await updater.mutateAsync({
        interval,
        hourUtc: interval === 'hourly' ? undefined : hourUtc,
        weekdayUtc: interval === 'weekly' ? weekdayUtc : undefined,
      });
      setDraftInterval(null);
      setDraftHour(null);
      setDraftWeekday(null);
    } catch {
      // surfaced via updater.error
    }
  };

  const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-gray-100">
          <Clock size={14} /> Schedule
        </h3>
        {data.nextFireAt ? (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            next: {new Date(data.nextFireAt).toLocaleString()} (UTC: {data.nextFireAt.slice(11, 16)})
          </span>
        ) : (
          <span className="text-xs text-gray-400">disabled</span>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <label className="space-y-1">
          <span className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
            Interval
          </span>
          <select
            value={interval}
            onChange={(e) => setDraftInterval(e.target.value as MailArchiveScheduleInterval)}
            disabled={disabled}
            data-testid="mail-archive-schedule-interval"
            className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1.5 text-sm text-gray-900 dark:text-gray-100"
          >
            <option value="off">Off (manual only)</option>
            <option value="hourly">Hourly (top of hour)</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </select>
        </label>

        {(interval === 'daily' || interval === 'weekly') ? (
          <label className="space-y-1">
            <span className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
              Hour (UTC)
            </span>
            <select
              value={hourUtc}
              onChange={(e) => setDraftHour(Number(e.target.value))}
              disabled={disabled}
              data-testid="mail-archive-schedule-hour"
              className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1.5 text-sm text-gray-900 dark:text-gray-100"
            >
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>{String(h).padStart(2, '0')}:00 UTC</option>
              ))}
            </select>
          </label>
        ) : null}

        {interval === 'weekly' ? (
          <label className="space-y-1">
            <span className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
              Weekday
            </span>
            <select
              value={weekdayUtc}
              onChange={(e) => setDraftWeekday(Number(e.target.value))}
              disabled={disabled}
              data-testid="mail-archive-schedule-weekday"
              className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1.5 text-sm text-gray-900 dark:text-gray-100"
            >
              {weekdays.map((day, idx) => (
                <option key={day} value={idx}>{day}</option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={!dirty || disabled || updater.isPending}
          data-testid="mail-archive-schedule-save"
          className="inline-flex items-center gap-1.5 rounded-md border border-brand-500 bg-brand-500 px-3 py-1 text-xs font-medium text-white shadow-sm hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {updater.isPending ? <Loader2 size={10} className="animate-spin" /> : null}
          Save schedule
        </button>
        {data.lastScheduledRunAt ? (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            last scheduled run: {new Date(data.lastScheduledRunAt).toLocaleString()}
          </span>
        ) : (
          <span className="text-xs text-gray-400">never fired by scheduler</span>
        )}
      </div>

      {updater.isError ? (
        <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-700 dark:text-red-300">
          {updater.error instanceof Error ? updater.error.message : 'Schedule update failed'}
        </div>
      ) : null}
    </div>
  );
}

function Stat({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <div className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
        {label}
      </div>
      <div>{children}</div>
    </div>
  );
}

function ModeBadge({ mode }: { readonly mode: MailArchiveMode }) {
  if (mode === 'no_downtime') {
    return (
      <span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
        no-downtime
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
      downtime
    </span>
  );
}

function StateBadge({ state }: { readonly state: MailArchiveRun['state'] }) {
  const map: Record<MailArchiveRun['state'], { cls: string; label: string }> = {
    queued: { cls: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300', label: 'queued' },
    scaling_down: { cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300', label: 'scaling down' },
    exporting: { cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300', label: 'exporting' },
    scaling_up: { cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300', label: 'scaling up' },
    succeeded: { cls: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300', label: 'succeeded' },
    failed: { cls: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300', label: 'failed' },
  };
  const m = map[state];
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${m.cls}`}>
      {m.label}
    </span>
  );
}

function ArchiveList({
  runs,
  loading,
  onRestore,
}: {
  readonly runs: readonly MailArchiveRun[];
  readonly loading: boolean;
  readonly onRestore: (run: MailArchiveRun) => void;
}) {
  if (loading) {
    return (
      <div className="text-xs text-gray-500 dark:text-gray-400">
        <Loader2 size={12} className="inline animate-spin mr-1" /> Loading archive history…
      </div>
    );
  }
  if (runs.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-gray-200 dark:border-gray-700 px-3 py-4 text-center text-xs text-gray-500 dark:text-gray-400">
        No archive runs yet.
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
        Recent archive runs
      </div>
      <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
        <table className="w-full text-xs">
          <thead className="bg-gray-50 dark:bg-gray-900">
            <tr className="text-left text-gray-500 dark:text-gray-400">
              <th className="px-2 py-1.5">Started</th>
              <th className="px-2 py-1.5">State</th>
              <th className="px-2 py-1.5">Mode</th>
              <th className="px-2 py-1.5">Step</th>
              <th className="px-2 py-1.5">Size</th>
              <th className="px-2 py-1.5">restic id</th>
              <th className="px-2 py-1.5">By</th>
              <th className="px-2 py-1.5"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {runs.map((r) => (
              <tr key={r.id} className="hover:bg-gray-50 dark:hover:bg-gray-900">
                <td className="px-2 py-1.5 text-gray-700 dark:text-gray-300">
                  {new Date(r.startedAt).toLocaleString()}
                </td>
                <td className="px-2 py-1.5"><StateBadge state={r.state} /></td>
                <td className="px-2 py-1.5"><ModeBadge mode={r.mode} /></td>
                <td className="px-2 py-1.5 text-gray-500 dark:text-gray-400">{r.currentStep ?? '—'}</td>
                <td className="px-2 py-1.5 text-gray-700 dark:text-gray-300 font-mono">
                  {formatBytes(r.exportSizeBytes)}
                </td>
                <td className="px-2 py-1.5 font-mono text-gray-500 dark:text-gray-400">
                  {r.resticSnapshotId ?? '—'}
                </td>
                <td className="px-2 py-1.5 text-gray-500 dark:text-gray-400">{r.triggeredBy}</td>
                <td className="px-2 py-1.5">
                  {r.state === 'succeeded' && r.resticSnapshotId ? (
                    <button
                      type="button"
                      onClick={() => onRestore(r)}
                      className="inline-flex items-center gap-1 rounded border border-red-300 dark:border-red-700 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/20"
                    >
                      <RotateCcw size={9} /> Restore
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RunProgressModal({
  run,
  onClose,
}: {
  readonly run: MailArchiveRun;
  readonly onClose: () => void;
}) {
  const terminal = run.state === 'succeeded' || run.state === 'failed';
  return (
    <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-xl rounded-xl bg-white dark:bg-gray-800 shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-700 px-5 py-3">
          <h3 className="flex items-center gap-2 text-base font-semibold text-gray-900 dark:text-gray-100">
            <Archive size={16} /> {run.triggeredBy === 'restore' ? 'Restore run' : 'Archive run'}
          </h3>
          <button
            onClick={onClose}
            disabled={!terminal}
            className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-30"
            data-testid="mail-archive-modal-close"
          >
            <X size={16} />
          </button>
        </div>
        <div className="p-5 space-y-3">
          <div className="text-sm text-gray-700 dark:text-gray-300">
            <code className="text-xs">{run.id}</code>
            <span className="ml-2"><StateBadge state={run.state} /></span>
          </div>
          {run.currentStep ? (
            <div className="text-xs text-gray-500 dark:text-gray-400">
              <Loader2 size={12} className="inline animate-spin mr-1" /> {run.currentStep}
            </div>
          ) : null}
          {run.state === 'succeeded' ? (
            <div className="flex items-start gap-2 text-sm text-green-700 dark:text-green-400">
              <CheckCircle size={14} className="mt-0.5 shrink-0" />
              <div>
                {run.triggeredBy === 'restore' ? (
                  <>
                    Restore complete — Stalwart now serving from the data
                    in restic snapshot{' '}
                    <code className="text-xs">{run.resticSnapshotId ?? '?'}</code>.
                    Original archive size:{' '}
                    {formatBytes(run.exportSizeBytes)}.
                    {run.finishedAt && run.startedAt ? (
                      <>
                        {' '}Elapsed:{' '}
                        {formatElapsedMs(
                          new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime(),
                        )}.
                      </>
                    ) : null}
                  </>
                ) : (
                  <>
                    Archive complete — restic snapshot{' '}
                    <code className="text-xs">{run.resticSnapshotId ?? '?'}</code>, export size{' '}
                    {formatBytes(run.exportSizeBytes)}.
                    {run.resticAddedBytes != null && run.resticAddedBytes > 0 ? (
                      <> {formatBytes(run.resticAddedBytes)} new (deduped against prior snapshots).</>
                    ) : null}
                  </>
                )}
              </div>
            </div>
          ) : null}
          {run.state === 'failed' && run.errorMessage ? (
            <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-700 dark:text-red-300">
              <AlertTriangle size={12} className="inline mr-1" /> {run.errorMessage}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ConfirmModal({
  title,
  body,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  onCancel,
}: {
  readonly title: string;
  readonly body: React.ReactNode;
  readonly confirmLabel: string;
  readonly danger: boolean;
  readonly busy: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-lg rounded-xl bg-white dark:bg-gray-800 shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-700 px-5 py-3">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
          <button onClick={onCancel} className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700">
            <X size={16} />
          </button>
        </div>
        <div className="p-5 text-sm text-gray-700 dark:text-gray-300">{body}</div>
        <div className="flex justify-end gap-2 border-t border-gray-100 dark:border-gray-700 px-5 py-3">
          <button type="button" onClick={onCancel} className="rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300">
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            data-testid="mail-archive-trigger-confirm"
            className={`inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 ${
              danger ? 'bg-red-600 hover:bg-red-700' : 'bg-brand-500 hover:bg-brand-600'
            }`}
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : null}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function RestoreConfirmModal({
  source,
  targetName,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  readonly source: MailArchiveRun;
  readonly targetName: string;
  readonly busy: boolean;
  readonly error: unknown;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  const [typed, setTyped] = useState('');
  const ok = typed === 'REPLACE';
  return (
    <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-lg rounded-xl bg-white dark:bg-gray-800 shadow-xl">
        <div className="flex items-center justify-between border-b border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-5 py-3">
          <h3 className="flex items-center gap-2 text-base font-semibold text-red-700 dark:text-red-300">
            <AlertTriangle size={16} /> DESTRUCTIVE: Restore from archive
          </h3>
          <button onClick={onCancel} className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700">
            <X size={16} />
          </button>
        </div>
        <div className="p-5 text-sm text-gray-700 dark:text-gray-300 space-y-3">
          <div>
            About to restore Stalwart from archive run{' '}
            <code className="text-xs">{source.id}</code>:
          </div>
          <ul className="list-disc ml-5 text-xs text-gray-600 dark:text-gray-400 space-y-1">
            <li>Source: restic snapshot <code>{source.resticSnapshotId}</code> in {targetName}</li>
            <li>Original size: {formatBytes(source.exportSizeBytes)}</li>
            <li>Captured at: {new Date(source.startedAt).toLocaleString()}</li>
          </ul>
          <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-700 dark:text-red-300">
            <strong>Live mail data will be PERMANENTLY REPLACED</strong> by the archive contents. Any
            mail received since the archive was captured will be lost. Mail will be unavailable for
            ~60–120s while the restore runs.
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-gray-700 dark:text-gray-300">
              Type <code className="rounded bg-gray-100 dark:bg-gray-800 px-1">REPLACE</code> to confirm:
            </label>
            <input
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              data-testid="mail-archive-restore-typed"
              className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-1.5 text-sm font-mono text-gray-900 dark:text-gray-100"
            />
          </div>
          {error ? (
            <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-700 dark:text-red-300">
              {error instanceof Error ? error.message : 'Restore trigger failed'}
            </div>
          ) : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-gray-100 dark:border-gray-700 px-5 py-3">
          <button type="button" onClick={onCancel} className="rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300">
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!ok || busy}
            data-testid="mail-archive-restore-confirm"
            className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
            Restore — replace live mail
          </button>
        </div>
      </div>
    </div>
  );
}

// ── tiny helpers ─────────────────────────────────────────────────────────────

function formatElapsedMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  return sec === 0 ? `${min}m` : `${min}m ${sec}s`;
}

function formatBytes(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}
