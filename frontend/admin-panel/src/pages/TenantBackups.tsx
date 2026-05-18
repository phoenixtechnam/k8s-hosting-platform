/**
 * /backups/tenants — flat searchable + sortable table of tenants
 * with their backup status. Three top tabs: Tenants / Schedule / Activity.
 *
 * Replaces /tenant-backup and /restore-carts.
 */

import { useMemo, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { Users, Calendar, Activity as ActivityIcon, Search, AlertTriangle, CheckCircle, Loader2, ArrowUpDown } from 'lucide-react';
import clsx from 'clsx';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { TenantsBackupsOverviewResponse, TenantBackupOverviewRow } from '@k8s-hosting/api-contracts';
import ScheduleCard from '@/components/backups/ScheduleCard';

type Tab = 'tenants' | 'schedule' | 'activity';

const TABS: Array<{ id: Tab; label: string; icon: typeof Users }> = [
  { id: 'tenants',  label: 'Tenants',  icon: Users },
  { id: 'schedule', label: 'Schedule', icon: Calendar },
  { id: 'activity', label: 'Activity', icon: ActivityIcon },
];

function isTab(v: string | null): v is Tab {
  return TABS.some((t) => t.id === v);
}

type SortKey = 'name' | 'lastBundleAt' | 'lastSnapshotAt' | 'snapshotBytes' | 'quotaPct';

function formatBytes(b: number): string {
  if (b === 0) return '—';
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1)} GiB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(0)} MiB`;
  return `${(b / 1024).toFixed(0)} KiB`;
}

function formatAge(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 'just now';
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

export default function TenantBackups() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const tab: Tab = isTab(raw) ? raw : 'tenants';

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <Users size={22} className="text-brand-600 dark:text-brand-400" />
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Tenant Backups</h1>
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400 max-w-3xl">
          Per-tenant snapshots (Longhorn PVC tarballs, on-demand) and bundles (Plesk-style
          restore archives, system-wide nightly cron). The SYSTEM tenant is included —
          platform mailboxes + apex-domain data are backed up like any other tenant.
        </p>
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
                data-testid={`tenant-backups-tab-${t.id}`}
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

      <div data-testid={`tenant-backups-pane-${tab}`}>
        {tab === 'tenants' && <TenantsTable />}
        {tab === 'schedule' && (
          <ScheduleCard
            subsystem="tenant_bundle"
            title="Tenant bundle nightly schedule"
            description="System-wide cron that creates a Plesk-style bundle per included tenant. Per-tenant override lives on each tenant's detail page (Inherit / On / Off)."
          />
        )}
        {tab === 'activity' && <BackupActivity />}
      </div>
    </div>
  );
}

// ─── Tenants table ──────────────────────────────────────────────────

function TenantsTable() {
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortAsc, setSortAsc] = useState(true);

  const { data, isLoading, error } = useQuery({
    queryKey: ['admin', 'backups', 'tenants', 'overview', { search }],
    queryFn: () => apiFetch<{ data: TenantsBackupsOverviewResponse }>(
      `/api/v1/admin/backups/tenants/overview${search ? `?filter=${encodeURIComponent(search)}` : ''}`,
    ),
    staleTime: 15_000,
  });

  const rows = data?.data?.rows ?? [];
  const kpi = data?.data?.kpi;

  const sorted = useMemo(() => {
    const arr = [...rows];
    arr.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'name': cmp = a.tenantName.localeCompare(b.tenantName); break;
        case 'lastBundleAt':
          cmp = (a.lastBundleAt ?? '').localeCompare(b.lastBundleAt ?? '');
          break;
        case 'lastSnapshotAt':
          cmp = (a.lastSnapshotAt ?? '').localeCompare(b.lastSnapshotAt ?? '');
          break;
        case 'snapshotBytes':
          cmp = a.snapshotBytes - b.snapshotBytes;
          break;
        case 'quotaPct':
          cmp = (a.snapshotQuotaPct ?? 0) - (b.snapshotQuotaPct ?? 0);
          break;
      }
      // SYSTEM tenant always at top regardless of sort order.
      if (a.isSystem !== b.isSystem) return a.isSystem ? -1 : 1;
      return sortAsc ? cmp : -cmp;
    });
    return arr;
  }, [rows, sortKey, sortAsc]);

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortAsc(!sortAsc);
    else { setSortKey(k); setSortAsc(true); }
  };

  return (
    <div className="space-y-4">
      <section className="grid grid-cols-2 gap-3 md:grid-cols-5" data-testid="tenant-backups-kpi">
        <KpiCard label="Total tenants" value={kpi?.totalTenants ?? 0} />
        <KpiCard label="Included" value={kpi?.includedTenants ?? 0} />
        <KpiCard label="Overdue (>36h)" value={kpi?.overdueTenants ?? 0} warn={!!kpi && kpi.overdueTenants > 0} />
        <KpiCard label="Snapshot bytes" sub={kpi ? formatBytes(kpi.totalSnapshotBytes) : '—'} />
        <KpiCard label="Bundle bytes" sub={kpi ? formatBytes(kpi.totalBundleBytes) : '—'} />
      </section>

      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by tenant name…"
            data-testid="tenant-backups-search"
            className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 pl-9 pr-3 py-1.5 text-sm text-gray-900 dark:text-gray-100"
          />
        </div>
        {isLoading && <Loader2 size={14} className="animate-spin text-gray-400" />}
      </div>

      {error && (
        <div className="rounded-lg border border-rose-200 dark:border-rose-700 bg-rose-50 dark:bg-rose-900/20 px-4 py-3 text-sm text-rose-700 dark:text-rose-300">
          Failed to load tenant overview: {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700 text-sm" data-testid="tenant-backups-table">
          <thead className="bg-gray-50 dark:bg-gray-900/50 text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400">
            <tr>
              <SortableTh active={sortKey === 'name'} asc={sortAsc} onClick={() => toggleSort('name')}>Tenant</SortableTh>
              <th className="px-4 py-2 text-left">Plan</th>
              <th className="px-4 py-2 text-left">Schedule</th>
              <SortableTh active={sortKey === 'quotaPct'} asc={sortAsc} onClick={() => toggleSort('quotaPct')} className="text-right">Quota %</SortableTh>
              <SortableTh active={sortKey === 'lastSnapshotAt'} asc={sortAsc} onClick={() => toggleSort('lastSnapshotAt')}>Last snapshot</SortableTh>
              <SortableTh active={sortKey === 'snapshotBytes'} asc={sortAsc} onClick={() => toggleSort('snapshotBytes')} className="text-right">Snapshots</SortableTh>
              <SortableTh active={sortKey === 'lastBundleAt'} asc={sortAsc} onClick={() => toggleSort('lastBundleAt')}>Last bundle</SortableTh>
              <th className="px-4 py-2 text-right">Bundles</th>
              <th className="px-4 py-2 text-right">Open cart</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {sorted.map((row) => <TenantRow key={row.tenantId} row={row} />)}
            {sorted.length === 0 && !isLoading && (
              <tr><td colSpan={10} className="px-4 py-8 text-center text-sm text-gray-500">No tenants match.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SortableTh({ children, active, asc, onClick, className }: { children: React.ReactNode; active: boolean; asc: boolean; onClick: () => void; className?: string }) {
  return (
    <th className={clsx('px-4 py-2 text-left cursor-pointer select-none', className)} onClick={onClick}>
      <span className="inline-flex items-center gap-1">
        {children}
        <ArrowUpDown size={11} className={clsx(active ? 'text-brand-600 dark:text-brand-400' : 'text-gray-300 dark:text-gray-600', !asc && active ? 'rotate-180' : '')} />
      </span>
    </th>
  );
}

function TenantRow({ row }: { row: TenantBackupOverviewRow }) {
  const overdue = row.includedInScheduledBundles && (!row.lastBundleAt || Date.now() - new Date(row.lastBundleAt).getTime() > 36 * 3600 * 1000);
  return (
    <tr className="hover:bg-gray-50 dark:hover:bg-gray-700/50" data-testid={`tenant-row-${row.tenantId}`}>
      <td className="px-4 py-2 font-medium text-gray-900 dark:text-gray-100">
        <div className="flex items-center gap-2">
          {row.tenantName}
          {row.isSystem && <span className="rounded bg-purple-100 dark:bg-purple-900/40 px-1.5 py-0.5 text-[10px] font-medium text-purple-700 dark:text-purple-300">SYSTEM</span>}
        </div>
      </td>
      <td className="px-4 py-2 text-gray-600 dark:text-gray-400">{row.planName ?? '—'}</td>
      <td className="px-4 py-2">
        <ScheduledPill state={row.scheduledBundlesOverride} resolved={row.includedInScheduledBundles} />
      </td>
      <td className="px-4 py-2 text-right font-mono text-xs">
        {row.snapshotQuotaPct !== null ? `${Math.round(row.snapshotQuotaPct * 100)}%` : '—'}
      </td>
      <td className="px-4 py-2 text-gray-600 dark:text-gray-400">{formatAge(row.lastSnapshotAt)}</td>
      <td className="px-4 py-2 text-right">
        {row.snapshotCount > 0
          ? <span>{row.snapshotCount} · {formatBytes(row.snapshotBytes)}</span>
          : <span className="text-gray-400">—</span>}
      </td>
      <td className={clsx('px-4 py-2', overdue ? 'text-amber-700 dark:text-amber-300 font-medium' : 'text-gray-600 dark:text-gray-400')}>
        {overdue && <AlertTriangle size={11} className="inline mr-1" />}
        {formatAge(row.lastBundleAt)}
      </td>
      <td className="px-4 py-2 text-right">
        {row.bundleCount > 0
          ? <span>{row.bundleCount} · {formatBytes(row.bundleBytes)}</span>
          : <span className="text-gray-400">—</span>}
      </td>
      <td className="px-4 py-2 text-right">
        {row.openCartId
          ? <Link to={`/restore?cartId=${row.openCartId}`} className="text-xs font-medium text-brand-600 dark:text-brand-400 hover:underline">Open →</Link>
          : <span className="text-gray-400">—</span>}
      </td>
      <td className="px-4 py-2 text-right">
        <Link to={`/backups/tenants/${row.tenantId}`} className="text-xs font-medium text-brand-600 dark:text-brand-400 hover:underline">Open</Link>
      </td>
    </tr>
  );
}

function ScheduledPill({ state, resolved }: { state: 'inherit' | 'on' | 'off'; resolved: boolean }) {
  if (state === 'on') {
    return <span className="rounded bg-green-100 dark:bg-green-900/40 px-2 py-0.5 text-[10px] font-medium text-green-700 dark:text-green-300">Override: ON</span>;
  }
  if (state === 'off') {
    return <span className="rounded bg-gray-100 dark:bg-gray-700 px-2 py-0.5 text-[10px] font-medium text-gray-700 dark:text-gray-300">Override: OFF</span>;
  }
  // inherit
  return (
    <span className={clsx(
      'rounded px-2 py-0.5 text-[10px] font-medium',
      resolved
        ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
        : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300',
    )}>
      Inherit · {resolved ? 'ON' : 'OFF'}
    </span>
  );
}

function KpiCard({ label, value, sub, warn }: { label: string; value?: number; sub?: string; warn?: boolean }) {
  return (
    <div className={clsx(
      'rounded-xl border bg-white dark:bg-gray-800 p-3 shadow-sm',
      warn ? 'border-amber-300 dark:border-amber-700' : 'border-gray-200 dark:border-gray-700',
    )}>
      <div className="text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400">{label}</div>
      <div className="mt-1 text-xl font-semibold text-gray-900 dark:text-gray-100">{value ?? sub ?? '—'}</div>
    </div>
  );
}

function BackupActivity() {
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'audit-logs', { category: 'backup' }],
    queryFn: () => apiFetch<{ data: { rows: Array<{ id: string; action: string; resourceType: string; resourceId: string | null; createdAt: string; actorEmail: string | null }> } }>(
      '/api/v1/admin/audit-logs?category=backup&limit=50',
    ),
    staleTime: 15_000,
  });
  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm">
      <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Recent backup activity</h3>
      {isLoading ? (
        <div className="mt-4 flex items-center gap-2 text-sm text-gray-500"><Loader2 size={14} className="animate-spin" /> Loading…</div>
      ) : data?.data?.rows && data.data.rows.length > 0 ? (
        <ul className="mt-4 divide-y divide-gray-100 dark:divide-gray-700">
          {data.data.rows.map((r) => (
            <li key={r.id} className="py-2 text-sm">
              <div className="flex items-center gap-2">
                <CheckCircle size={12} className="text-green-500" />
                <span className="font-mono text-xs text-gray-700 dark:text-gray-200">{r.action}</span>
                <span className="text-xs text-gray-500">{r.resourceType}</span>
              </div>
              <div className="ml-5 text-xs text-gray-500 dark:text-gray-400">
                {new Date(r.createdAt).toLocaleString()}{r.actorEmail ? ` · ${r.actorEmail}` : ''}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">No recent backup activity.</p>
      )}
    </div>
  );
}
