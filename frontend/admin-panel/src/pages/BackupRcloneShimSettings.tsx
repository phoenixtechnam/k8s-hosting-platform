// R-X10: admin page for the universal backup-rclone-shim.
//
// Renders three class cards (SYSTEM / TENANT / MAIL), each showing:
//   - current binding (target name + storage type) or "unbound"
//   - "Bind to target..." / "Unbind" actions
//   - drain timeout (configurable per-target, defaulted server-side)
//
// Plus a status tile that polls the on-cluster shim status ConfigMap
// (state + assignedClasses + inflight consumer count) and a
// "Drain in-flight backups" escape-hatch button.

import React, { useState } from 'react';
import { AlertCircle, CheckCircle, Loader2, RefreshCcw, ShieldAlert, ShieldCheck } from 'lucide-react';
import clsx from 'clsx';

import {
  useShimAssignments,
  useShimStatus,
  usePutShimAssignment,
  useShimDrainNow,
} from '@/hooks/use-backup-rclone-shim';
import { useBackupConfigs } from '@/hooks/use-backup-config';
import type {
  BackupShimClass,
  ShimAssignmentRow,
  ShimState,
} from '@k8s-hosting/api-contracts';

const CLASS_META: Record<BackupShimClass, { title: string; subtitle: string }> = {
  system: {
    title: 'SYSTEM',
    subtitle: 'Postgres WAL + base backup, etcd snapshots, secrets bundle, monitoring + restic-backed components',
  },
  tenant: {
    title: 'TENANT',
    subtitle: 'Tenant bundles (files, mailboxes, config), on-demand PVC snapshots',
  },
  mail: {
    title: 'MAIL',
    subtitle: 'Stalwart RocksDB restic snapshots (uses raw bucket — restic encrypts)',
  },
};

const STATE_BADGE: Record<ShimState, { label: string; color: string; Icon: typeof CheckCircle }> = {
  STATE_OK: { label: 'OK', color: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-200', Icon: CheckCircle },
  STATE_NO_ASSIGNMENTS: { label: 'No targets', color: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300', Icon: ShieldAlert },
  STATE_MISSING_KEY: { label: 'Missing BACKUP_TARGET_KEY', color: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-200', Icon: AlertCircle },
  STATE_ERROR: { label: 'Reconciler error', color: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-200', Icon: AlertCircle },
};

export default function BackupRcloneShimSettings(): React.ReactElement {
  const assignmentsQuery = useShimAssignments();
  const statusQuery = useShimStatus();
  const configsQuery = useBackupConfigs();
  const put = usePutShimAssignment();
  const drainNow = useShimDrainNow();

  const [bindModal, setBindModal] = useState<{ className: BackupShimClass } | null>(null);

  const assignments = assignmentsQuery.data?.data?.assignments ?? [];
  const status = statusQuery.data?.data;
  const configs = (configsQuery.data?.data ?? []) as ReadonlyArray<{
    id: string;
    name: string;
    storageType: string;
    enabled: number;
  }>;

  return (
    <div className="space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
          Backup Rclone Shim
        </h1>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Universal backup mediator. Every backup pipeline (postgres,
          etcd, tenant bundles, mail) routes through a per-node
          DaemonSet that translates S3 → the operator-selected
          upstream backend per class. See{' '}
          <code className="rounded bg-slate-100 px-1 py-0.5 text-xs dark:bg-slate-800">
            docs/02-operations/BACKUP_RCLONE_SHIM.md
          </code>
          .
        </p>
      </header>

      {/* Status tile */}
      <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Reconciler status
            </div>
            {status ? (
              <div className="flex items-center gap-2">
                {(() => {
                  const meta = STATE_BADGE[status.state];
                  const Icon = meta.Icon;
                  return (
                    <span
                      className={clsx(
                        'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium',
                        meta.color,
                      )}
                    >
                      <Icon className="h-3 w-3" />
                      {meta.label}
                    </span>
                  );
                })()}
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  Last reconciled: {status.reconciledAt || 'never'}
                </span>
              </div>
            ) : (
              <Loader2 className="h-4 w-4 animate-spin text-slate-500" />
            )}
            {status?.errorMessage && (
              <p className="mt-1 text-xs text-red-700 dark:text-red-300">
                {status.errorMessage}
              </p>
            )}
            <p className="text-xs text-slate-600 dark:text-slate-400">
              In-flight shim-consumer tasks: {status?.inflightConsumerCount ?? '—'}
            </p>
          </div>
          <button
            onClick={() => drainNow.mutate({ classes: [] })}
            disabled={drainNow.isPending}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
          >
            {drainNow.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCcw className="h-3.5 w-3.5" />
            )}
            Drain in-flight backups
          </button>
        </div>
      </div>

      {/* Class cards */}
      <div className="grid gap-4 lg:grid-cols-3">
        {(['system', 'tenant', 'mail'] as BackupShimClass[]).map((cls) => {
          const row = assignments.find((a) => a.className === cls);
          const meta = CLASS_META[cls];
          const bound = row?.targetId != null;
          return (
            <div
              key={cls}
              className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900"
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="font-mono text-sm font-bold text-slate-900 dark:text-slate-100">
                  {meta.title}
                </span>
                {bound ? (
                  <ShieldCheck className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <ShieldAlert className="h-5 w-5 text-amber-500" />
                )}
              </div>
              <p className="mb-3 text-xs text-slate-600 dark:text-slate-400">
                {meta.subtitle}
              </p>
              {bound ? (
                <div className="space-y-1.5 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-500 dark:text-slate-400">Target</span>
                    <span className="font-mono text-slate-900 dark:text-slate-100">
                      {row?.targetName}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-slate-500 dark:text-slate-400">Storage type</span>
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs uppercase text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                      {row?.targetStorageType}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-slate-500 dark:text-slate-400">Drain timeout</span>
                    <span className="font-mono text-xs text-slate-700 dark:text-slate-300">
                      {row?.drainTimeoutSeconds}s
                    </span>
                  </div>
                </div>
              ) : (
                <p className="rounded border border-dashed border-amber-300 bg-amber-50 p-2 text-xs text-amber-700 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200">
                  ⚠ No target — fast-rollback (snapshots) covers
                  in-cluster errors, but no protection against
                  volume destruction or cluster loss.
                </p>
              )}
              <div className="mt-3 flex gap-2">
                <button
                  onClick={() => setBindModal({ className: cls })}
                  className="flex-1 rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
                >
                  {bound ? 'Change target…' : 'Bind to target…'}
                </button>
                {bound && (
                  <button
                    onClick={() => {
                      if (window.confirm(`Unbind ${meta.title}? In-flight backups will be drained (up to ${row?.drainTimeoutSeconds}s) before the shim reconciles.`)) {
                        put.mutate({ className: cls, input: { targetId: null, force: false } });
                      }
                    }}
                    disabled={put.isPending}
                    className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
                  >
                    Unbind
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Bind modal */}
      {bindModal && (
        <BindTargetModal
          className={bindModal.className}
          row={assignments.find((a) => a.className === bindModal.className) ?? null}
          configs={configs}
          onClose={() => setBindModal(null)}
          onSubmit={(targetId, force) => {
            put.mutate(
              { className: bindModal.className, input: { targetId, force } },
              {
                onSuccess: () => setBindModal(null),
              },
            );
          }}
          isPending={put.isPending}
        />
      )}
    </div>
  );
}

interface BindTargetModalProps {
  className: BackupShimClass;
  row: ShimAssignmentRow | null;
  configs: ReadonlyArray<{ id: string; name: string; storageType: string; enabled: number }>;
  onClose: () => void;
  onSubmit: (targetId: string | null, force: boolean) => void;
  isPending: boolean;
}

function BindTargetModal(props: BindTargetModalProps): React.ReactElement {
  const [targetId, setTargetId] = useState(props.row?.targetId ?? '');
  const [force, setForce] = useState(false);
  const enabledConfigs = props.configs.filter((c) => c.enabled === 1);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900">
        <header className="border-b border-slate-200 p-4 dark:border-slate-700">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            Bind {props.className.toUpperCase()} backup class
          </h2>
        </header>
        <div className="space-y-4 p-4">
          <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">
            Target
            <select
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
            >
              <option value="">— Select a backup target —</option>
              {enabledConfigs.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.storageType.toUpperCase()})
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              checked={force}
              onChange={(e) => setForce(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              <span className="font-medium">Force apply</span> — skip
              the in-flight backup drain wait. In-flight backups using
              the old config may be cut off mid-stream.
            </span>
          </label>
        </div>
        <footer className="flex justify-end gap-2 border-t border-slate-200 p-4 dark:border-slate-700">
          <button
            onClick={props.onClose}
            disabled={props.isPending}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-600 dark:text-slate-300"
          >
            Cancel
          </button>
          <button
            onClick={() => props.onSubmit(targetId || null, force)}
            disabled={props.isPending}
            className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {props.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Apply
          </button>
        </footer>
      </div>
    </div>
  );
}
