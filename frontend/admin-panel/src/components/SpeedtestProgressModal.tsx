// Speedtest progress modal (Phase 10 of snapshot-storage overhaul).
//
// Opens when the operator clicks the "backup.speedtest" task in the
// task-center chip. Shows the 4-stage pipeline + final results.
//
// The task itself updates its progress_pct + progress_text from the
// backend speedtest service — this modal renders that, plus does its
// own polling of the parent task row for the most up-to-date state.

import { useEffect, useState } from 'react';
import { Gauge, Loader2, CheckCircle, AlertCircle, X, Upload, Download, Trash2, Database } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';

interface SpeedtestProgressModalProps {
  readonly operationId: string;
  readonly targetId: string;
  readonly targetName: string;
  readonly payloadBytes: number;
  readonly onClose: () => void;
}

interface TaskRow {
  readonly id: string;
  readonly kind: string;
  readonly refId: string | null;
  readonly status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  readonly progressPct: number | null;
  readonly progressText: string | null;
  readonly errorMessage: string | null;
  readonly details: Record<string, unknown> | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

interface BackupConfigRow {
  readonly id: string;
  readonly name: string;
  readonly lastSpeedtestAt: string | null;
  readonly lastSpeedtestUploadMbps: number | null;
  readonly lastSpeedtestDownloadMbps: number | null;
  readonly lastSpeedtestLatencyMs: number | null;
  readonly lastSpeedtestPayloadBytes: number | null;
  readonly lastSpeedtestError: string | null;
}

const STAGES = [
  { key: 'provision', label: 'Provision Job', icon: Database, pct: 10 },
  { key: 'upload', label: 'Upload payload', icon: Upload, pct: 40 },
  { key: 'download', label: 'Download payload', icon: Download, pct: 80 },
  { key: 'cleanup', label: 'Cleanup remote', icon: Trash2, pct: 100 },
] as const;

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / (1024 ** 3)).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / (1024 ** 2)).toFixed(0)} MiB`;
  return `${(bytes / 1024).toFixed(0)} KiB`;
}

export default function SpeedtestProgressModal({
  operationId,
  targetId,
  targetName,
  payloadBytes,
  onClose,
}: SpeedtestProgressModalProps) {
  const [task, setTask] = useState<TaskRow | null>(null);
  const [config, setConfig] = useState<BackupConfigRow | null>(null);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        // The /me/tasks endpoint filters to the current user's tasks.
        // When operationId is set, lock on by refId. Otherwise (the
        // proactive-open case before POST returns), fall back to the
        // most-recently-started backup.speedtest task — usually the
        // one we just kicked off; the modal re-locks via operationId
        // once the parent passes it in.
        const resp = await apiFetch<{ data: { tasks: TaskRow[] } }>('/api/v1/me/tasks');
        const tasks = resp?.data?.tasks ?? [];
        let row: TaskRow | null;
        if (operationId) {
          row = tasks.find((t) => t.refId === operationId) ?? null;
        } else {
          // Sort newest-first; pick the latest backup.speedtest task.
          const speedtests = tasks.filter((t) => t.kind === 'backup.speedtest');
          speedtests.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
          row = speedtests[0] ?? null;
        }
        if (!stopped) setTask(row);

        // Also refresh the backup-config row to surface persisted results.
        const cfgs = await apiFetch<{ data: BackupConfigRow[] }>('/api/v1/admin/backup-configs');
        const cfg = cfgs?.data?.find((c) => c.id === targetId) ?? null;
        if (!stopped) setConfig(cfg);
      } catch {
        // Best-effort polling — silently retry.
      }
      if (!stopped) {
        const intervalMs = task?.status === 'running' || !task ? 1500 : 5000;
        timer = setTimeout(poll, intervalMs);
      }
    };
    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [operationId, targetId]);

  const status = task?.status ?? 'running';
  const pct = task?.progressPct ?? 0;
  const isTerminal = status === 'succeeded' || status === 'failed' || status === 'cancelled';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-2xl rounded-xl bg-white dark:bg-gray-800 shadow-2xl">
        <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 px-5 py-3">
          <div className="flex items-center gap-2">
            <Gauge size={18} className="text-purple-600 dark:text-purple-400" />
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
              Speedtest — {targetName}
            </h2>
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {formatBytes(payloadBytes)} payload
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Progress bar */}
          <div>
            <div className="flex items-center justify-between text-xs text-gray-600 dark:text-gray-400">
              <span>{task?.progressText ?? 'Initialising…'}</span>
              <span className="font-medium">{pct}%</span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
              <div
                className={`h-full transition-all duration-500 ${status === 'failed' ? 'bg-rose-500' : status === 'succeeded' ? 'bg-green-500' : 'bg-purple-500'}`}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>

          {/* Stage checklist */}
          <ul className="space-y-1 text-sm">
            {STAGES.map((stage) => {
              const reached = pct >= stage.pct;
              const current = !reached && (stage.pct - pct < 30);
              const StageIcon = stage.icon;
              return (
                <li key={stage.key} className="flex items-center gap-2 text-gray-700 dark:text-gray-300">
                  {reached
                    ? <CheckCircle size={14} className="text-green-500 flex-none" />
                    : current
                      ? <Loader2 size={14} className="animate-spin text-purple-500 flex-none" />
                      : <StageIcon size={14} className="text-gray-300 dark:text-gray-600 flex-none" />}
                  <span className={reached ? 'text-gray-900 dark:text-gray-100' : current ? 'font-medium' : 'text-gray-400 dark:text-gray-500'}>
                    {stage.label}
                  </span>
                </li>
              );
            })}
          </ul>

          {/* Result block — appears when persisted to backup_configurations */}
          {isTerminal && config?.lastSpeedtestAt && (
            <div className={`rounded-lg border px-3 py-3 ${config.lastSpeedtestError
              ? 'border-rose-200 dark:border-rose-700 bg-rose-50/50 dark:bg-rose-900/10'
              : 'border-green-200 dark:border-green-700 bg-green-50/50 dark:bg-green-900/10'}`}
            >
              {config.lastSpeedtestError ? (
                <div className="flex items-start gap-2 text-sm text-rose-700 dark:text-rose-300">
                  <AlertCircle size={16} className="mt-0.5 flex-none" />
                  <div>
                    <div className="font-medium">Speedtest failed</div>
                    <div className="text-rose-600 dark:text-rose-400">{config.lastSpeedtestError}</div>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-3 gap-3 text-sm">
                  <div>
                    <div className="text-xs text-green-700 dark:text-green-400">Upload</div>
                    <div className="text-lg font-semibold text-green-900 dark:text-green-100">
                      {config.lastSpeedtestUploadMbps?.toFixed(1) ?? '—'}
                      <span className="ml-1 text-xs font-normal text-green-700 dark:text-green-400">Mbps</span>
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-green-700 dark:text-green-400">Download</div>
                    <div className="text-lg font-semibold text-green-900 dark:text-green-100">
                      {config.lastSpeedtestDownloadMbps?.toFixed(1) ?? '—'}
                      <span className="ml-1 text-xs font-normal text-green-700 dark:text-green-400">Mbps</span>
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-green-700 dark:text-green-400">Latency</div>
                    <div className="text-lg font-semibold text-green-900 dark:text-green-100">
                      {config.lastSpeedtestLatencyMs ?? '—'}
                      <span className="ml-1 text-xs font-normal text-green-700 dark:text-green-400">ms</span>
                    </div>
                  </div>
                </div>
              )}
              <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                Completed {new Date(config.lastSpeedtestAt).toLocaleString()}
              </div>
            </div>
          )}

          {task?.errorMessage && status === 'failed' && (
            <div className="rounded-lg border border-rose-200 dark:border-rose-700 bg-rose-50/50 dark:bg-rose-900/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
              <span className="font-medium">Task error: </span>
              {task.errorMessage}
            </div>
          )}
        </div>

        <div className="flex justify-end border-t border-gray-200 dark:border-gray-700 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
