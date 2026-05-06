/**
 * Tenant Backup admin page (consolidated).
 *
 * Single-stop operator surface for the per-client (tenant) bundle
 * lifecycle. Replaces the friction of context-switching between
 * /settings/backups, /restores, /restore, and per-client tabs.
 *
 * Tabs (deep-linkable via ?tab=…):
 *   - bundles   (default) — cross-client searchable list + filters,
 *                           inline verify/delete/GDPR/restore.
 *   - schedules            — global cron list, inline run-now + edit.
 *   - carts                — recent restore-carts list (resume failed).
 *   - targets              — off-site config (S3 / SSH-SFTP).
 *
 * super_admin + admin gated (router enforces).
 */

import { useState, useMemo, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Package, Calendar, RotateCcw, Cloud, Search, X, Play, Pencil,
  Trash2, ShieldCheck, Download, Loader2, AlertCircle, CheckCircle2,
  Pause, FileText, Server,
} from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';
import SearchableClientSelect from '@/components/ui/SearchableClientSelect';
import { BackupScheduleEditor } from '@/components/BackupScheduleEditor';
import { useBundles, useDeleteBundle, useVerifyBundle, downloadDataExport } from '@/hooks/use-backup-bundles';
import { useAllBackupSchedules, useRunBackupScheduleNow } from '@/hooks/use-backup-schedule';
import { useRestoreCarts } from '@/hooks/use-restore-carts';
import { useBackupConfigs } from '@/hooks/use-backup-config';
import { useClients } from '@/hooks/use-clients';
import { formatBytes } from '@/hooks/use-platform-storage';
import type {
  BundleSummary,
  BackupScheduleSummary,
  RestoreJobSummary,
  BackupJobStatus,
} from '@k8s-hosting/api-contracts';

type Tab = 'bundles' | 'schedules' | 'carts' | 'targets';
const TABS: ReadonlyArray<{ id: Tab; label: string; icon: typeof Package }> = [
  { id: 'bundles', label: 'Bundles', icon: Package },
  { id: 'schedules', label: 'Schedules', icon: Calendar },
  { id: 'carts', label: 'Restore Carts', icon: RotateCcw },
  { id: 'targets', label: 'Off-site Targets', icon: Cloud },
];

function isTab(v: string | null): v is Tab {
  return v !== null && TABS.some((t) => t.id === v);
}

const BUNDLE_STATUSES: ReadonlyArray<BackupJobStatus | ''> = [
  '', 'completed', 'partial', 'failed', 'running', 'pending', 'expired',
];
const CART_STATUSES: ReadonlyArray<{ key: string; label: string }> = [
  { key: '', label: 'All' },
  { key: 'draft', label: 'Draft' },
  { key: 'executing', label: 'Executing' },
  { key: 'paused', label: 'Paused' },
  { key: 'failed', label: 'Failed' },
  { key: 'done', label: 'Done' },
];

export default function TenantBackup() {
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('tab');
  const [tab, setTab] = useState<Tab>(isTab(tabParam) ? tabParam : 'bundles');

  // Keep URL in sync with tab so links are shareable + back-button works.
  useEffect(() => {
    if (params.get('tab') !== tab) {
      const next = new URLSearchParams(params);
      next.set('tab', tab);
      setParams(next, { replace: true });
    }
  }, [tab, params, setParams]);

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Tenant Backup</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Per-client off-site bundles, schedules, restores, and targets.
          </p>
        </div>
      </header>

      <nav className="flex gap-1 border-b border-gray-200 dark:border-gray-700" aria-label="Tabs">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={
              tab === id
                ? 'flex items-center gap-2 border-b-2 border-brand-500 px-4 py-2 text-sm font-medium text-brand-600 dark:text-brand-300'
                : 'flex items-center gap-2 border-b-2 border-transparent px-4 py-2 text-sm font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
            }
            aria-current={tab === id ? 'page' : undefined}
            data-testid={`tenant-backup-tab-${id}`}
          >
            <Icon size={16} />
            {label}
          </button>
        ))}
      </nav>

      {tab === 'bundles' && <BundlesTab onSwitchToTargets={() => setTab('targets')} />}
      {tab === 'schedules' && <SchedulesTab />}
      {tab === 'carts' && <CartsTab />}
      {tab === 'targets' && <TargetsTab />}
    </div>
  );
}

// ─── Bundles Tab ────────────────────────────────────────────────────

function BundlesTab({ onSwitchToTargets }: { onSwitchToTargets: () => void }) {
  const { data: bundlesResp, isLoading } = useBundles();
  const { data: clientsResp } = useClients();
  const { data: configsResp } = useBackupConfigs();
  const verifyBundle = useVerifyBundle();
  const deleteBundle = useDeleteBundle();

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [clientFilter, setClientFilter] = useState<string | null>(null);
  const [verifyResult, setVerifyResult] = useState<{ id: string; ok: boolean; msg: string } | null>(null);
  const [deletePromptId, setDeletePromptId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);

  // useBundles wraps as { data: { data: [...], pagination } } —
  // see hooks/use-backup-bundles.ts ListResponse type.
  const bundles: ReadonlyArray<BundleSummary> = bundlesResp?.data?.data ?? [];
  const clients = clientsResp?.data ?? [];
  const configs = configsResp?.data ?? [];

  const clientName = useMemo(() => {
    const m = new Map(clients.map((c) => [c.id, c.companyName]));
    return (id: string) => m.get(id) ?? '(unknown)';
  }, [clients]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return bundles.filter((b) => {
      if (statusFilter && b.status !== statusFilter) return false;
      if (clientFilter && b.clientId !== clientFilter) return false;
      if (!q) return true;
      const haystack = [
        b.id,
        b.label ?? '',
        b.description ?? '',
        clientName(b.clientId).toLowerCase(),
      ].join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }, [bundles, search, statusFilter, clientFilter, clientName]);

  const handleVerify = async (bundleId: string) => {
    setVerifyResult(null);
    setVerifyingId(bundleId);
    try {
      const r = await verifyBundle.mutateAsync(bundleId);
      // components is a record { files?, config?, secrets? }. Each
      // component is "ok" when present and lacks an error field.
      const components = r.data.components;
      const checked: string[] = [];
      const failed: string[] = [];
      if (components.files) {
        checked.push('files');
        if (!components.files.reachable) failed.push('files');
      }
      if (components.config) {
        checked.push('config');
        if (components.config.parseError) failed.push('config');
      }
      if (components.secrets) {
        checked.push('secrets');
        if (components.secrets.decryptError) failed.push('secrets');
      }
      setVerifyResult({
        id: bundleId,
        ok: failed.length === 0,
        msg: failed.length === 0
          ? `All ${checked.length} component(s) verified clean: ${checked.join(', ')}.`
          : `${failed.length} of ${checked.length} component(s) failed: ${failed.join(', ')}.`,
      });
    } catch (err) {
      setVerifyResult({ id: bundleId, ok: false, msg: err instanceof Error ? err.message : 'Verify failed' });
    } finally {
      setVerifyingId(null);
    }
  };

  const handleDelete = async (bundleId: string) => {
    setDeleteError(null);
    try {
      await deleteBundle.mutateAsync(bundleId);
      setDeletePromptId(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  // No targets configured? Surface a friendly nudge — bundles can't be
  // captured without an off-site target.
  if (configs.length === 0) {
    return (
      <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/40">
        <p className="text-sm text-amber-900 dark:text-amber-200">
          No off-site backup target configured. Configure one in the
          <button type="button" className="mx-1 underline" onClick={onSwitchToTargets}>
            Off-site Targets
          </button>
          tab to start capturing tenant bundles.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative grow sm:max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by bundle id, label, or client name…"
            className="w-full rounded-lg border border-gray-300 bg-white py-2 pl-9 pr-3 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
            data-testid="bundle-search"
          />
          {search && (
            <button type="button" onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-600" aria-label="Clear search">
              <X size={14} />
            </button>
          )}
        </div>

        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
          data-testid="bundle-status-filter"
        >
          {BUNDLE_STATUSES.map((s) => (
            <option key={s || 'all'} value={s}>{s ? s : 'All statuses'}</option>
          ))}
        </select>

        <div className="min-w-[12rem]">
          <SearchableClientSelect
            selectedClientId={clientFilter}
            onSelect={setClientFilter}
            placeholder="All clients"
          />
        </div>

        <span className="ml-auto text-sm text-gray-500 dark:text-gray-400">
          {filtered.length} of {bundles.length}
        </span>
      </div>

      {verifyResult && (
        <div className={
          verifyResult.ok
            ? 'rounded-lg border border-green-300 bg-green-50 p-3 text-sm text-green-900 dark:border-green-800 dark:bg-green-950/40 dark:text-green-200'
            : 'rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200'
        }>
          Bundle <code className="font-mono text-xs">{verifyResult.id}</code>: {verifyResult.msg}
          <button type="button" className="ml-2 underline" onClick={() => setVerifyResult(null)}>dismiss</button>
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-12 text-gray-500 dark:text-gray-400">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading bundles…
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-8 text-center text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
          No bundles match the current filter.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead className="bg-gray-50 dark:bg-gray-800">
              <tr>
                {['Bundle', 'Client', 'Status', 'Target', 'Size', 'Captured', 'Actions'].map((h) => (
                  <th key={h} className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-300">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white dark:divide-gray-700 dark:bg-gray-900">
              {filtered.map((b) => (
                <BundleRow
                  key={b.id}
                  bundle={b}
                  clientName={clientName(b.clientId)}
                  onVerify={() => handleVerify(b.id)}
                  onDelete={() => { setDeleteError(null); setDeletePromptId(b.id); }}
                  onDataExport={() => downloadDataExport(b.id)}
                  verifying={verifyingId === b.id}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {deletePromptId && (
        <DeleteConfirmModal
          bundleId={deletePromptId}
          onCancel={() => { setDeletePromptId(null); setDeleteError(null); }}
          onConfirm={() => handleDelete(deletePromptId)}
          isDeleting={deleteBundle.isPending}
          error={deleteError}
        />
      )}
    </div>
  );
}

interface BundleRowProps {
  readonly bundle: BundleSummary;
  readonly clientName: string;
  readonly onVerify: () => void;
  readonly onDelete: () => void;
  readonly onDataExport: () => void;
  readonly verifying: boolean;
}

function BundleRow({ bundle: b, clientName, onVerify, onDelete, onDataExport, verifying }: BundleRowProps) {
  return (
    <tr className="text-sm">
      <td className="px-4 py-2 font-mono text-xs text-gray-600 dark:text-gray-300">
        <div className="truncate" title={b.id}>{b.id.slice(0, 24)}…</div>
        {b.label && <div className="text-[11px] text-gray-500">{b.label}</div>}
      </td>
      <td className="px-4 py-2 text-gray-700 dark:text-gray-200">
        <Link to={`/clients/${b.clientId}`} className="hover:text-brand-600 hover:underline">{clientName}</Link>
      </td>
      <td className="px-4 py-2"><StatusBadge status={b.status} /></td>
      <td className="px-4 py-2 text-gray-600 dark:text-gray-300">
        <span className="font-mono text-xs">{b.targetKind}</span>
      </td>
      <td className="px-4 py-2 text-gray-700 dark:text-gray-200">{formatBytes(b.sizeBytes)}</td>
      <td className="px-4 py-2 text-xs text-gray-500 dark:text-gray-400">
        {b.finishedAt ? new Date(b.finishedAt).toLocaleString() : (b.startedAt ? '(running)' : '—')}
      </td>
      <td className="px-4 py-2">
        <div className="flex items-center gap-1">
          <Link
            to={`/restore?bundleId=${b.id}&clientId=${b.clientId}`}
            className="rounded p-1.5 text-brand-600 hover:bg-brand-50 dark:hover:bg-brand-900/30"
            title="Restore from this bundle"
          >
            <RotateCcw size={14} />
          </Link>
          <button
            type="button"
            onClick={onVerify}
            disabled={verifying}
            className="rounded p-1.5 text-amber-600 hover:bg-amber-50 disabled:opacity-50 dark:hover:bg-amber-900/30"
            title="Verify integrity"
          >
            {verifying ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
          </button>
          {b.exportMode === 'data_export' && (
            <button
              type="button"
              onClick={onDataExport}
              className="rounded p-1.5 text-purple-600 hover:bg-purple-50 dark:hover:bg-purple-900/30"
              title="Download GDPR data export"
            >
              <Download size={14} />
            </button>
          )}
          <button
            type="button"
            onClick={onDelete}
            className="rounded p-1.5 text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30"
            title="Delete bundle"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </td>
    </tr>
  );
}

function DeleteConfirmModal({ bundleId, onCancel, onConfirm, isDeleting, error }: {
  bundleId: string; onCancel: () => void; onConfirm: () => void; isDeleting: boolean; error: string | null;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-bundle-title"
    >
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl dark:bg-gray-800">
        <h3 id="delete-bundle-title" className="text-lg font-semibold text-gray-900 dark:text-gray-100">Delete bundle?</h3>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
          This permanently removes the bundle from the off-site target and the database. This cannot be undone.
        </p>
        <p className="mt-2 font-mono text-xs text-gray-500">{bundleId}</p>
        {error && (
          <div className="mt-3 rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200">
            <AlertCircle className="mr-1 inline h-4 w-4" />
            {error}
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:text-gray-100">
            Cancel
          </button>
          <button type="button" onClick={onConfirm} disabled={isDeleting} className="rounded-md bg-red-600 px-3 py-2 text-sm text-white hover:bg-red-700 disabled:opacity-50">
            {isDeleting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Schedules Tab ──────────────────────────────────────────────────

function SchedulesTab() {
  const { data, isLoading } = useAllBackupSchedules();
  const [search, setSearch] = useState('');
  const [editClientId, setEditClientId] = useState<string | null>(null);

  const schedules = data?.data ?? [];
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return schedules;
    return schedules.filter((s) =>
      (s.businessName ?? '').toLowerCase().includes(q) || s.clientId.toLowerCase().includes(q),
    );
  }, [schedules, search]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative grow sm:max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search schedules by client name…"
            className="w-full rounded-lg border border-gray-300 bg-white py-2 pl-9 pr-3 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
            data-testid="schedule-search"
          />
        </div>
        <span className="ml-auto text-sm text-gray-500 dark:text-gray-400">
          {filtered.length} of {schedules.length}
        </span>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12 text-gray-500 dark:text-gray-400">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading schedules…
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-8 text-center text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
          No schedules configured yet. Open a client and toggle "Enable scheduled bundles" to create one.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead className="bg-gray-50 dark:bg-gray-800">
              <tr>
                {['Client', 'Enabled', 'Frequency', 'Hour (UTC)', 'Retention', 'Last Run', 'Actions'].map((h) => (
                  <th key={h} className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-300">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white dark:divide-gray-700 dark:bg-gray-900">
              {filtered.map((s) => (
                <ScheduleRow key={s.clientId} schedule={s} onEdit={() => setEditClientId(s.clientId)} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editClientId && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="edit-schedule-title"
        >
          <div className="w-full max-w-2xl rounded-lg bg-white p-1 shadow-xl dark:bg-gray-800">
            <div className="flex items-center justify-between px-4 py-2">
              <span id="edit-schedule-title" className="text-sm text-gray-500 dark:text-gray-400">
                Editing schedule for client <code className="font-mono text-xs">{editClientId.slice(0, 8)}…</code>
              </span>
              <button type="button" onClick={() => setEditClientId(null)} className="rounded p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-600" aria-label="Close">
                <X size={16} />
              </button>
            </div>
            <BackupScheduleEditor clientId={editClientId} />
          </div>
        </div>
      )}
    </div>
  );
}

function ScheduleRow({ schedule: s, onEdit }: { schedule: BackupScheduleSummary; onEdit: () => void }) {
  const runNow = useRunBackupScheduleNow(s.clientId);
  const handleRunNow = () => { runNow.mutate(); };

  return (
    <tr className="text-sm">
      <td className="px-4 py-2">
        <Link to={`/clients/${s.clientId}`} className="text-gray-700 hover:text-brand-600 hover:underline dark:text-gray-200">
          {s.businessName ?? <span className="italic text-red-500">(deleted)</span>}
        </Link>
        <div className="font-mono text-[11px] text-gray-500">{s.clientId.slice(0, 8)}…</div>
      </td>
      <td className="px-4 py-2">
        {s.enabled ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900/40 dark:text-green-300">
            <CheckCircle2 size={12} /> Enabled
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-300">
            <Pause size={12} /> Paused
          </span>
        )}
      </td>
      <td className="px-4 py-2 capitalize text-gray-700 dark:text-gray-200">{s.frequency}</td>
      <td className="px-4 py-2 text-gray-700 dark:text-gray-200">{String(s.hourOfDayUtc).padStart(2, '0')}:00</td>
      <td className="px-4 py-2 text-gray-700 dark:text-gray-200">{s.retentionDays}d</td>
      <td className="px-4 py-2 text-xs">
        {s.lastRunAt ? (
          <>
            <div className="text-gray-700 dark:text-gray-200">{new Date(s.lastRunAt).toLocaleString()}</div>
            {s.lastRunStatus && <div><StatusBadge status={s.lastRunStatus} /></div>}
          </>
        ) : (
          <span className="text-gray-400">never</span>
        )}
      </td>
      <td className="px-4 py-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleRunNow}
            disabled={!s.enabled || runNow.isPending}
            className="inline-flex items-center gap-1 rounded p-1.5 text-brand-600 hover:bg-brand-50 disabled:opacity-50 dark:hover:bg-brand-900/30"
            title={s.enabled ? 'Trigger next tick to run now' : 'Enable schedule first'}
          >
            {runNow.isPending ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
          </button>
          <button
            type="button"
            onClick={onEdit}
            className="rounded p-1.5 text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
            title="Edit schedule"
          >
            <Pencil size={14} />
          </button>
        </div>
      </td>
    </tr>
  );
}

// ─── Restore Carts Tab ──────────────────────────────────────────────

function CartsTab() {
  const [statusFilter, setStatusFilter] = useState<string>('');
  const { data, isLoading, error } = useRestoreCarts(statusFilter ? { status: statusFilter } : {});
  const carts: ReadonlyArray<RestoreJobSummary> = data?.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {CART_STATUSES.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => setStatusFilter(key)}
            className={
              statusFilter === key
                ? 'rounded-full bg-brand-600 px-3 py-1 text-xs font-medium text-white'
                : 'rounded-full border border-gray-300 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700'
            }
          >
            {label}
          </button>
        ))}
        <Link
          to="/restore"
          className="ml-auto inline-flex items-center gap-1 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
        >
          <RotateCcw size={14} /> New restore
        </Link>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12 text-gray-500 dark:text-gray-400">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading carts…
        </div>
      ) : error ? (
        <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200">
          <AlertCircle className="mr-2 inline h-4 w-4" />
          Failed to load carts: {error instanceof Error ? error.message : String(error)}
        </div>
      ) : carts.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-8 text-center text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
          No restore carts {statusFilter ? `with status "${statusFilter}"` : 'yet'}.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead className="bg-gray-50 dark:bg-gray-800">
              <tr>
                {['Cart', 'Status', 'Created', 'Description', 'Actions'].map((h) => (
                  <th key={h} className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-300">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white dark:divide-gray-700 dark:bg-gray-900">
              {carts.map((c) => (
                <tr key={c.id} className="text-sm">
                  <td className="px-4 py-2 font-mono text-xs text-gray-600 dark:text-gray-300">{c.id}</td>
                  <td className="px-4 py-2"><StatusBadge status={c.status} /></td>
                  <td className="px-4 py-2 text-xs text-gray-500 dark:text-gray-400">{new Date(c.createdAt).toLocaleString()}</td>
                  <td className="px-4 py-2 text-gray-700 dark:text-gray-200">{c.description ?? '—'}</td>
                  <td className="px-4 py-2">
                    {c.status === 'failed' || c.status === 'paused' ? (
                      <Link
                        to={`/restore?cartId=${c.id}`}
                        className="inline-flex items-center gap-1 rounded-md bg-amber-100 px-2 py-1 text-xs font-medium text-amber-800 hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-300"
                      >
                        <Play size={12} /> Resume
                      </Link>
                    ) : (
                      <Link
                        to={`/restore?cartId=${c.id}`}
                        className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                      >
                        <FileText size={12} /> Open
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Targets Tab ────────────────────────────────────────────────────
//
// Off-site config (S3 / SSH-SFTP) — surfaces a quick summary +
// deep-link to the existing /settings/backups for the form-based
// CRUD. Keeping the heavy form on its own page avoids duplicating
// the `useBackupConfigs` mutation set + secret-handling here.

function TargetsTab() {
  const { data, isLoading } = useBackupConfigs();
  const configs = data?.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Off-site storage destinations for tenant bundles. At least one active target is required to capture bundles.
        </p>
        <Link
          to="/settings/backups"
          className="inline-flex items-center gap-1 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
        >
          <Server size={14} /> Manage targets
        </Link>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12 text-gray-500 dark:text-gray-400">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading targets…
        </div>
      ) : configs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-8 text-center text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
          No off-site targets yet.{' '}
          <Link to="/settings/backups" className="text-brand-600 underline">Add one</Link> to start capturing bundles.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead className="bg-gray-50 dark:bg-gray-800">
              <tr>
                {['Name', 'Kind', 'Endpoint', 'Active', 'Retention'].map((h) => (
                  <th key={h} className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-300">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white dark:divide-gray-700 dark:bg-gray-900">
              {configs.map((c) => (
                <tr key={c.id} className="text-sm">
                  <td className="px-4 py-2 font-medium text-gray-700 dark:text-gray-200">{c.name}</td>
                  <td className="px-4 py-2"><span className="font-mono text-xs">{c.storageType}</span></td>
                  <td className="px-4 py-2 font-mono text-xs text-gray-600 dark:text-gray-300">
                    {c.storageType === 's3'
                      ? `${c.s3Endpoint ?? ''}/${c.s3Bucket ?? ''}`
                      : `${c.sshUser ?? ''}@${c.sshHost ?? ''}:${c.sshPath ?? ''}`}
                  </td>
                  <td className="px-4 py-2">
                    {c.active ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900/40 dark:text-green-300">
                        <CheckCircle2 size={12} /> Active
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                        Inactive
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-gray-700 dark:text-gray-200">{c.retentionDays}d</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

    </div>
  );
}
