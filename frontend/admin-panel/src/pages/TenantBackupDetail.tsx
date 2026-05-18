/**
 * /backups/tenants/:tenantId — single-tenant deep view.
 *
 * Sub-tabs:
 *   Filesystem Snapshots — PVC tarballs (class=tenant_snapshot).
 *                          On-demand only; no per-tenant cron.
 *   Object Backups — Plesk-style bundles (class=tenant_bundle).
 *                    System-wide nightly cron governs auto-create.
 *   Activity — per-tenant audit.
 *
 * The Schedule "tab" on the parent /backups/tenants owns the
 * system-wide tenant-bundle cron; per-tenant override pill lives
 * in the header here.
 */

import { useMemo, useState } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { HardDrive, Package, Activity as ActivityIcon, ArrowLeft, Loader2, Trash2, Play, RotateCw } from 'lucide-react';
import clsx from 'clsx';
import { apiFetch } from '@/lib/api-client';
import type { TenantBackupDetail } from '@k8s-hosting/api-contracts';

type Tab = 'filesystem' | 'object' | 'activity';

const TABS: Array<{ id: Tab; label: string; icon: typeof HardDrive }> = [
  { id: 'filesystem', label: 'Filesystem Snapshots', icon: HardDrive },
  { id: 'object',     label: 'Object Backups',       icon: Package },
  { id: 'activity',   label: 'Activity',             icon: ActivityIcon },
];

function isTab(v: string | null): v is Tab {
  return TABS.some((t) => t.id === v);
}

function formatBytes(b: number): string {
  if (b === 0) return '0 B';
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GiB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)} MiB`;
  if (b >= 1024) return `${(b / 1024).toFixed(0)} KiB`;
  return `${b} B`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

export default function TenantBackupDetail() {
  const { tenantId } = useParams<{ tenantId: string }>();
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const tab: Tab = isTab(raw) ? raw : 'filesystem';

  const { data, isLoading, error } = useQuery({
    queryKey: ['admin', 'backups', 'tenants', tenantId, 'overview'],
    queryFn: () => apiFetch<{ data: TenantBackupDetail }>(`/api/v1/admin/backups/tenants/${tenantId}/overview`),
    enabled: !!tenantId,
    staleTime: 15_000,
  });
  const detail = data?.data;

  if (isLoading) {
    return <div className="flex items-center gap-2 text-sm text-gray-500"><Loader2 size={14} className="animate-spin" /> Loading…</div>;
  }
  if (error || !detail) {
    return (
      <div className="rounded-lg border border-rose-200 dark:border-rose-700 bg-rose-50 dark:bg-rose-900/20 p-4 text-sm text-rose-700 dark:text-rose-300">
        Failed to load tenant: {error instanceof Error ? error.message : 'not found'}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <Link to="/backups/tenants" className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 dark:text-brand-400 hover:underline">
          <ArrowLeft size={11} /> Tenant Backups
        </Link>
        <div className="flex flex-wrap items-baseline gap-x-3">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{detail.tenantName}</h1>
          {detail.isSystem && <span className="rounded bg-purple-100 dark:bg-purple-900/40 px-2 py-0.5 text-xs font-medium text-purple-700 dark:text-purple-300">SYSTEM</span>}
          {detail.planName && <span className="text-sm text-gray-500 dark:text-gray-400">Plan: {detail.planName}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <IncludeOverridePill tenantId={detail.tenantId} state={detail.scheduledBundlesOverride} resolved={detail.includedInScheduledBundles} />
          <QuotaBar
            currentBytes={detail.quota.currentBytes}
            maxBytes={detail.quota.maxBytes}
            currentCount={detail.quota.currentCount}
            maxCount={detail.quota.maxCount}
          />
        </div>
      </header>

      <nav className="border-b border-gray-200 dark:border-gray-700">
        <div className="-mb-px flex flex-wrap gap-x-2">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setParams({ tab: t.id }, { replace: true })}
                data-testid={`tenant-backup-detail-tab-${t.id}`}
                className={clsx(
                  'flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium transition-colors',
                  active
                    ? 'border-brand-500 text-brand-600 dark:text-brand-300'
                    : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200',
                )}
              >
                <Icon size={16} />
                {t.label}
              </button>
            );
          })}
        </div>
      </nav>

      <div data-testid={`tenant-backup-detail-pane-${tab}`}>
        {tab === 'filesystem' && <FilesystemSnapshotsPane detail={detail} />}
        {tab === 'object' && <ObjectBundlesPane detail={detail} />}
        {tab === 'activity' && <ActivityPane tenantId={detail.tenantId} />}
      </div>
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────

function IncludeOverridePill({ tenantId, state, resolved }: { tenantId: string; state: 'inherit' | 'on' | 'off'; resolved: boolean }) {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: (next: 'inherit' | 'on' | 'off') => apiFetch(`/api/v1/admin/tenants/${tenantId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        include_in_scheduled_bundles_override: next === 'inherit' ? null : next === 'on',
      }),
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'backups', 'tenants'] }),
  });
  return (
    <div className="inline-flex items-center gap-1 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1 text-xs">
      <span className="text-gray-500 dark:text-gray-400">Scheduled bundles:</span>
      {(['inherit', 'on', 'off'] as const).map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => m.mutate(s)}
          disabled={m.isPending}
          data-testid={`include-override-${s}`}
          className={clsx(
            'rounded px-2 py-0.5 text-xs font-medium transition-colors',
            state === s
              ? 'bg-brand-500 text-white'
              : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700',
          )}
        >
          {s === 'inherit' ? `Inherit (${resolved ? 'ON' : 'OFF'})` : s.toUpperCase()}
        </button>
      ))}
      {m.isPending && <Loader2 size={11} className="animate-spin text-gray-400" />}
    </div>
  );
}

function QuotaBar({ currentBytes, maxBytes, currentCount, maxCount }: { currentBytes: number; maxBytes: number; currentCount: number; maxCount: number }) {
  const bytesPct = maxBytes > 0 ? Math.min(100, (currentBytes / maxBytes) * 100) : 0;
  const countPct = maxCount > 0 ? Math.min(100, (currentCount / maxCount) * 100) : 0;
  return (
    <div className="inline-flex items-center gap-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-1.5 text-xs">
      <div>
        <div className="text-gray-500 dark:text-gray-400">Bytes</div>
        <div className="font-mono text-gray-900 dark:text-gray-100">{formatBytes(currentBytes)} / {formatBytes(maxBytes)}</div>
        <div className="mt-1 h-1 w-32 rounded-full bg-gray-200 dark:bg-gray-700">
          <div className={clsx('h-1 rounded-full', bytesPct > 90 ? 'bg-rose-500' : bytesPct > 70 ? 'bg-amber-500' : 'bg-brand-500')} style={{ width: `${bytesPct}%` }} />
        </div>
      </div>
      <div>
        <div className="text-gray-500 dark:text-gray-400">Count</div>
        <div className="font-mono text-gray-900 dark:text-gray-100">{currentCount} / {maxCount}</div>
        <div className="mt-1 h-1 w-32 rounded-full bg-gray-200 dark:bg-gray-700">
          <div className={clsx('h-1 rounded-full', countPct > 90 ? 'bg-rose-500' : countPct > 70 ? 'bg-amber-500' : 'bg-brand-500')} style={{ width: `${countPct}%` }} />
        </div>
      </div>
    </div>
  );
}

function FilesystemSnapshotsPane({ detail }: { detail: TenantBackupDetail }) {
  const qc = useQueryClient();
  const trigger = useMutation({
    mutationFn: () => apiFetch(`/api/v1/admin/tenants/${detail.tenantId}/storage/snapshot`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'backups', 'tenants', detail.tenantId, 'overview'] }),
  });
  const delSnap = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/v1/admin/storage/snapshots/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'backups', 'tenants', detail.tenantId, 'overview'] }),
  });
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-900/10 px-3 py-2 text-xs text-blue-700 dark:text-blue-300">
        Filesystem snapshots are <strong>on-demand only</strong> — there's no per-tenant cron. The plan's
        retention setting (currently {detail.quota.retentionDays} days) governs auto-delete; older
        snapshots are pruned by the storage-lifecycle scheduler.
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => trigger.mutate()}
          disabled={trigger.isPending}
          className="inline-flex items-center gap-2 rounded-lg border border-brand-500 bg-brand-500 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-brand-600 disabled:opacity-50"
          data-testid="tenant-snapshot-trigger"
        >
          {trigger.isPending ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
          Take snapshot now
        </button>
        {trigger.isError && <span className="text-xs text-rose-600">{(trigger.error as Error).message}</span>}
      </div>

      <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700 text-sm">
          <thead className="bg-gray-50 dark:bg-gray-900/50 text-xs uppercase tracking-wider text-gray-500">
            <tr>
              <th className="px-4 py-2 text-left">Label</th>
              <th className="px-4 py-2 text-left">Created</th>
              <th className="px-4 py-2 text-right">Size</th>
              <th className="px-4 py-2 text-left">Status</th>
              <th className="px-4 py-2 text-left">Target</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {detail.snapshots.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-gray-500">No snapshots yet.</td></tr>
            ) : detail.snapshots.map((s) => (
              <tr key={s.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                <td className="px-4 py-2 font-medium text-gray-900 dark:text-gray-100">{s.label ?? <span className="text-gray-400">(unlabeled)</span>}</td>
                <td className="px-4 py-2 text-gray-600 dark:text-gray-400">{formatDate(s.createdAt)}</td>
                <td className="px-4 py-2 text-right font-mono text-xs">{formatBytes(s.sizeBytes)}</td>
                <td className="px-4 py-2"><StatusPill status={s.status} /></td>
                <td className="px-4 py-2 text-gray-600 dark:text-gray-400">{s.targetName ?? '—'}</td>
                <td className="px-4 py-2 text-right">
                  <button
                    type="button"
                    onClick={() => { if (confirm(`Delete snapshot "${s.label ?? s.id}"?`)) delSnap.mutate(s.id); }}
                    disabled={delSnap.isPending}
                    className="inline-flex items-center gap-1 rounded border border-rose-200 dark:border-rose-700 px-2 py-0.5 text-xs font-medium text-rose-700 dark:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-900/20 disabled:opacity-50"
                  >
                    <Trash2 size={11} /> Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ObjectBundlesPane({ detail }: { detail: TenantBackupDetail }) {
  const qc = useQueryClient();
  const trigger = useMutation({
    mutationFn: () => apiFetch(`/api/v1/admin/tenants/${detail.tenantId}/backups`, {
      method: 'POST',
      body: JSON.stringify({ initiator: 'admin', components: { files: true, mailboxes: true, config: true, secrets: true } }),
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'backups', 'tenants', detail.tenantId, 'overview'] }),
  });
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-900/10 px-3 py-2 text-xs text-blue-700 dark:text-blue-300">
        Bundles are Plesk-style restore archives (files + mailboxes + config + secrets). Automatic
        creation is governed by the system-wide cron under{' '}
        <Link to="/backups/tenants?tab=schedule" className="font-medium underline">Tenant Backups → Schedule</Link>{' '}
        and the per-tenant include override above.
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => trigger.mutate()}
          disabled={trigger.isPending}
          className="inline-flex items-center gap-2 rounded-lg border border-brand-500 bg-brand-500 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-brand-600 disabled:opacity-50"
          data-testid="tenant-bundle-trigger"
        >
          {trigger.isPending ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
          Create bundle now
        </button>
        {detail.openCartId && (
          <Link to={`/restore?cartId=${detail.openCartId}`} className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 dark:text-brand-400 hover:underline">
            <RotateCw size={11} /> Open restore cart
          </Link>
        )}
      </div>

      <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700 text-sm">
          <thead className="bg-gray-50 dark:bg-gray-900/50 text-xs uppercase tracking-wider text-gray-500">
            <tr>
              <th className="px-4 py-2 text-left">Label</th>
              <th className="px-4 py-2 text-left">Created</th>
              <th className="px-4 py-2 text-right">Size</th>
              <th className="px-4 py-2 text-left">Status</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {detail.bundles.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-sm text-gray-500">No bundles yet.</td></tr>
            ) : detail.bundles.map((b) => (
              <tr key={b.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                <td className="px-4 py-2 font-medium text-gray-900 dark:text-gray-100">{b.label ?? <span className="text-gray-400">(unlabeled)</span>}</td>
                <td className="px-4 py-2 text-gray-600 dark:text-gray-400">{formatDate(b.createdAt)}</td>
                <td className="px-4 py-2 text-right font-mono text-xs">{formatBytes(b.sizeBytes)}</td>
                <td className="px-4 py-2"><StatusPill status={b.status} /></td>
                <td className="px-4 py-2 text-right">
                  <Link to={`/restore?bundleId=${b.id}&tenantId=${detail.tenantId}`} className="text-xs font-medium text-brand-600 dark:text-brand-400 hover:underline">Restore →</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ActivityPane({ tenantId }: { tenantId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'audit-logs', { tenant: tenantId }],
    queryFn: () => apiFetch<{ data: { rows: Array<{ id: string; action: string; resourceType: string; createdAt: string; actorEmail: string | null }> } }>(
      `/api/v1/admin/audit-logs?tenantId=${tenantId}&limit=50`,
    ),
    staleTime: 15_000,
  });
  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm">
      <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Recent activity</h3>
      {isLoading ? (
        <div className="mt-4 flex items-center gap-2 text-sm text-gray-500"><Loader2 size={14} className="animate-spin" /> Loading…</div>
      ) : data?.data?.rows && data.data.rows.length > 0 ? (
        <ul className="mt-4 divide-y divide-gray-100 dark:divide-gray-700">
          {data.data.rows.map((r) => (
            <li key={r.id} className="py-2 text-sm">
              <div className="font-mono text-xs text-gray-700 dark:text-gray-200">{r.action}</div>
              <div className="text-xs text-gray-500 dark:text-gray-400">{new Date(r.createdAt).toLocaleString()}{r.actorEmail ? ` · ${r.actorEmail}` : ''}</div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">No recent activity.</p>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    ready: 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300',
    completed: 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300',
    creating: 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300',
    pending: 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300',
    failed: 'bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-300',
    expired: 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300',
  };
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${map[status] ?? 'bg-gray-100 text-gray-700'}`}>
      {status.toUpperCase()}
    </span>
  );
}

