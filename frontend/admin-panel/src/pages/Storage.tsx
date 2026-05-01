import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { HardDrive, Archive, Loader2, Settings as SettingsIcon, Cloud, Server, ExternalLink, RotateCcw } from 'lucide-react';
import clsx from 'clsx';
import StatCard from '@/components/ui/StatCard';
import SearchableClientSelect from '@/components/ui/SearchableClientSelect';
import { useBackups } from '@/hooks/use-backups';
import { useDashboardMetrics } from '@/hooks/use-dashboard';
import { useBackupConfigs, useBackupList } from '@/hooks/use-backup-config';
import {
  useSnapshots,
  useCreateSnapshot,
  useDeleteSnapshot,
  useStorageAudit,
  type StorageSnapshot,
  type AuditRow,
} from '@/hooks/use-storage-lifecycle';
import {
  useStorageLifecycleSettings,
  useUpdateStorageLifecycleSettings,
  type StorageLifecycleSettingsUpdate,
} from '@/hooks/use-storage-settings';
import type { BackupResponse } from '@k8s-hosting/api-contracts';
import { useSortable } from '@/hooks/use-sortable';
import SortableHeader from '@/components/ui/SortableHeader';

type Tab = 'overview' | 'backups' | 'snapshots' | 'audit' | 'settings';

const TABS: readonly { readonly id: Tab; readonly label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'backups', label: 'Backups' },
  { id: 'snapshots', label: 'Snapshots' },
  { id: 'audit', label: 'Audit' },
  { id: 'settings', label: 'Settings' },
] as const;

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

function truncateId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 12)}...` : id;
}

export default function Storage() {
  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);

  const {
    data: backupsData,
    isLoading: backupsLoading,
    error: backupsError,
  } = useBackups(selectedClientId ?? undefined);

  const { data: dashData } = useDashboardMetrics();
  const metrics = dashData?.data;

  const backups = backupsData?.data ?? [];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Backups &amp; Snapshots</h1>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard title="Total Storage" value="—" subtitle="No storage aggregation endpoint yet" icon={HardDrive} accent="brand" />
        <StatCard title="Backups" value={metrics?.total_backups ?? backups.length} icon={Archive} accent="amber" />
        <StatCard
          title="Storage Used"
          value="—"
          subtitle="No storage aggregation endpoint yet"
          icon={HardDrive}
          accent="brand"
        />
      </div>

      <div className="border-b border-gray-200 dark:border-gray-700">
        <nav className="-mb-px flex gap-6" data-testid="tab-bar">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={clsx(
                'whitespace-nowrap border-b-2 px-1 py-3 text-sm font-medium transition-colors',
                activeTab === tab.id
                  ? 'border-brand-500 text-brand-600 dark:text-brand-400'
                  : 'border-transparent text-gray-500 hover:border-gray-300 dark:hover:border-gray-600 hover:text-gray-700 dark:hover:text-gray-300',
              )}
              data-testid={`tab-${tab.id}`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {activeTab === 'overview' && <OverviewTab />}
      {activeTab === 'backups' && (
        <DataTab
          selectedClientId={selectedClientId}
          onClientChange={setSelectedClientId}
          isLoading={backupsLoading}
          error={backupsError}
        >
          <BackupsTable backups={backups} />
        </DataTab>
      )}
      {activeTab === 'snapshots' && (
        <SnapshotsTab
          selectedClientId={selectedClientId}
          onClientChange={setSelectedClientId}
        />
      )}
      {activeTab === 'audit' && <AuditTab />}
      {activeTab === 'settings' && <SettingsTab />}
    </div>
  );
}

function SnapshotsTab({
  selectedClientId,
  onClientChange,
}: {
  readonly selectedClientId: string | null;
  readonly onClientChange: (id: string | null) => void;
}) {
  const { data, isLoading, error } = useSnapshots(selectedClientId ?? undefined);
  const createSnap = useCreateSnapshot();
  const deleteSnap = useDeleteSnapshot();
  const snapshots = data?.data ?? [];

  return (
    <div className="space-y-4">
      <SearchableClientSelect
        selectedClientId={selectedClientId}
        onSelect={onClientChange}
        placeholder="Search clients..."
      />
      {!selectedClientId && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-5 py-16 text-center shadow-sm">
          <Archive size={40} className="mx-auto text-gray-300" />
          <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">
            Select a client to view and manage snapshots.
          </p>
        </div>
      )}
      {selectedClientId && (
        <>
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {snapshots.length} snapshot(s) — snapshots taken before resize/archive operations are retained per plan policy.
            </p>
            <button
              onClick={() => createSnap.mutate({ clientId: selectedClientId, label: `Manual ${new Date().toISOString().slice(0, 16)}` })}
              disabled={createSnap.isPending}
              className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {createSnap.isPending ? 'Creating…' : 'Take snapshot'}
            </button>
          </div>
          {isLoading && <Loader2 size={24} className="animate-spin text-gray-400" />}
          {error && <p className="text-sm text-red-500">{(error as Error).message}</p>}
          {!isLoading && !error && <SnapshotsTable snapshots={snapshots} onDelete={(id) => deleteSnap.mutate(id)} />}
        </>
      )}
    </div>
  );
}

function SnapshotsTable({ snapshots, onDelete }: { readonly snapshots: readonly StorageSnapshot[]; readonly onDelete: (id: string) => void }) {
  if (snapshots.length === 0) {
    return <p className="px-5 py-8 text-center text-sm text-gray-500">No snapshots yet.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm">
      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700 text-sm">
        <thead className="bg-gray-50 dark:bg-gray-900 text-xs uppercase text-gray-500 dark:text-gray-400">
          <tr>
            <th className="px-4 py-2 text-left">Kind</th>
            <th className="px-4 py-2 text-left">Status</th>
            <th className="px-4 py-2 text-left">Size</th>
            <th className="px-4 py-2 text-left">Label</th>
            <th className="px-4 py-2 text-left">Created</th>
            <th className="px-4 py-2 text-left">Expires</th>
            <th className="px-4 py-2"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
          {snapshots.map((s) => (
            <tr key={s.id}>
              <td className="px-4 py-2"><code className="text-xs">{s.kind}</code></td>
              <td className="px-4 py-2">
                <span className={clsx('rounded-full px-2 py-0.5 text-xs',
                  s.status === 'ready' && 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-200',
                  s.status === 'creating' && 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-200',
                  s.status === 'failed' && 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-200',
                  s.status === 'expired' && 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
                )}>
                  {s.status}
                </span>
              </td>
              <td className="px-4 py-2">{formatBytes(Number(s.sizeBytes))}</td>
              <td className="px-4 py-2 max-w-[200px] truncate text-gray-600 dark:text-gray-300">{s.label ?? '—'}</td>
              <td className="px-4 py-2 text-gray-500 dark:text-gray-400">{new Date(s.createdAt).toISOString().slice(0, 16)}</td>
              <td className="px-4 py-2 text-gray-500 dark:text-gray-400">{s.expiresAt ? new Date(s.expiresAt).toISOString().slice(0, 10) : 'never'}</td>
              <td className="px-4 py-2 text-right">
                <button
                  onClick={() => { if (confirm(`Delete snapshot ${s.id.slice(0, 8)}?`)) onDelete(s.id); }}
                  className="text-xs text-red-600 hover:underline"
                  disabled={s.status === 'creating'}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AuditTab() {
  const { data, isLoading, error } = useStorageAudit();
  const rows = data?.data ?? [];
  const totalWasteGi = rows.reduce((sum, r) => {
    const provGi = r.provisionedGi;
    const usedGi = r.usedBytes / (1024 ** 3);
    return sum + Math.max(0, provGi - usedGi);
  }, 0);
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Storage audit — provisioned vs used</h2>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Clients listed largest-waste first. High waste = good candidate for a shrink operation via the Clients page.
        </p>
        <p className="mt-2 text-lg font-bold text-gray-900 dark:text-gray-100">
          {totalWasteGi.toFixed(1)} GiB provisioned but unused across {rows.length} active client(s)
        </p>
      </div>
      {isLoading && <Loader2 size={24} className="animate-spin text-gray-400" />}
      {error && <p className="text-sm text-red-500">{(error as Error).message}</p>}
      {!isLoading && !error && <AuditTable rows={rows} />}
    </div>
  );
}

function AuditTable({ rows }: { readonly rows: readonly AuditRow[] }) {
  const sorted = [...rows].sort((a, b) => b.wastePct - a.wastePct);
  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm">
      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700 text-sm">
        <thead className="bg-gray-50 dark:bg-gray-900 text-xs uppercase text-gray-500 dark:text-gray-400">
          <tr>
            <th className="px-4 py-2 text-left">Namespace</th>
            <th className="px-4 py-2 text-right">Provisioned</th>
            <th className="px-4 py-2 text-right">Used</th>
            <th className="px-4 py-2 text-right">Waste %</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
          {sorted.map((r) => (
            <tr key={r.clientId}>
              <td className="px-4 py-2"><code className="text-xs text-gray-600 dark:text-gray-300">{r.namespace}</code></td>
              <td className="px-4 py-2 text-right">{r.provisionedGi} GiB</td>
              <td className="px-4 py-2 text-right">{formatBytes(r.usedBytes)}</td>
              <td className={clsx('px-4 py-2 text-right font-medium',
                r.wastePct > 80 && 'text-red-600 dark:text-red-400',
                r.wastePct > 50 && r.wastePct <= 80 && 'text-amber-600 dark:text-amber-400',
                r.wastePct <= 50 && 'text-gray-600 dark:text-gray-400',
              )}>
                {r.wastePct}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OverviewTab() {
  const { data: configsData, isLoading } = useBackupConfigs();
  const configs = configsData?.data ?? [];

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Backup Storage Targets</h2>
          <Link
            to="/settings/backups"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-600 dark:text-brand-400 hover:underline"
          >
            <SettingsIcon size={14} /> Configure
          </Link>
        </div>
        {isLoading && (
          <div className="flex justify-center py-6"><Loader2 size={20} className="animate-spin text-gray-400" /></div>
        )}
        {!isLoading && configs.length === 0 && (
          <div className="rounded-lg border border-dashed border-gray-300 dark:border-gray-600 px-5 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
            No backup targets configured.{' '}
            <Link to="/settings/backups" className="font-medium text-brand-600 dark:text-brand-400 hover:underline">
              Add one
            </Link>
            {' '}to enable system backups.
          </div>
        )}
        {!isLoading && configs.length > 0 && (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {configs.map((cfg) => <BackupTargetStatCard key={cfg.id} cfg={cfg} />)}
          </div>
        )}
      </div>
    </div>
  );
}

/** Per-target panel: shows backup count, total size, last-backup time. */
function BackupTargetStatCard({ cfg }: { readonly cfg: import('@k8s-hosting/api-contracts').BackupConfigResponse }) {
  const isS3 = cfg.storageType === 's3';
  const Icon = isS3 ? Cloud : Server;
  // Lazy-fetch backup list for this target — only when an active config
  // has Longhorn-side backups. Inactive configs don't have any in
  // longhorn-system yet (until activate).
  const { data, isLoading } = useBackupList(cfg.active ? cfg.id : null);
  const backups = (data?.data ?? []) as ReadonlyArray<{ size?: string | number; createdAt?: string | null }>;
  const totalBytes = backups.reduce((acc, b) => acc + (Number(b.size) || 0), 0);
  const latest = backups[0]?.createdAt ? new Date(backups[0].createdAt as string) : null;

  const formatBytes = (bytes: number) => {
    if (!bytes) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
  };

  return (
    <div className={clsx(
      'rounded-lg border p-4 transition-colors',
      cfg.active
        ? 'border-green-200 dark:border-green-700 bg-green-50/50 dark:bg-green-900/10'
        : 'border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/30',
    )}>
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          <Icon size={16} className="text-gray-500 dark:text-gray-400" />
          <div>
            <div className="font-medium text-gray-900 dark:text-gray-100 text-sm">{cfg.name}</div>
            <div className="text-xs text-gray-500 dark:text-gray-400">
              {isS3
                ? `S3: ${cfg.s3Bucket ?? '—'} (${cfg.s3Region ?? '—'})`
                : `SSH: ${cfg.sshUser}@${cfg.sshHost}:${cfg.sshPort}`}
            </div>
          </div>
        </div>
        {cfg.active && (
          <span className="rounded-full bg-green-100 dark:bg-green-900/40 px-2 py-0.5 text-[10px] font-medium text-green-700 dark:text-green-300">
            Active
          </span>
        )}
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
        <div>
          <div className="text-gray-500 dark:text-gray-400">Backups</div>
          <div className="font-medium text-gray-900 dark:text-gray-100">
            {!cfg.active ? '—' : isLoading ? '…' : backups.length}
          </div>
        </div>
        <div>
          <div className="text-gray-500 dark:text-gray-400">Total Size</div>
          <div className="font-medium text-gray-900 dark:text-gray-100">
            {!cfg.active ? '—' : isLoading ? '…' : formatBytes(totalBytes)}
          </div>
        </div>
        <div>
          <div className="text-gray-500 dark:text-gray-400">Last Backup</div>
          <div className="font-medium text-gray-900 dark:text-gray-100">
            {!cfg.active
              ? '—'
              : isLoading
                ? '…'
                : latest
                  ? latest.toLocaleDateString()
                  : 'never'}
          </div>
        </div>
      </div>
    </div>
  );
}

interface DataTabProps {
  readonly selectedClientId: string | null;
  readonly onClientChange: (id: string | null) => void;
  readonly isLoading: boolean;
  readonly error: Error | null;
  readonly children: React.ReactNode;
}

function DataTab({ selectedClientId, onClientChange, isLoading, error, children }: DataTabProps) {
  return (
    <div className="space-y-4">
      <SearchableClientSelect
        selectedClientId={selectedClientId}
        onSelect={onClientChange}
        placeholder="Search clients..."
      />

      {!selectedClientId && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-5 py-16 text-center shadow-sm">
          <Archive size={40} className="mx-auto text-gray-300" />
          <p className="mt-4 text-sm text-gray-500 dark:text-gray-400" data-testid="select-client-prompt">
            Select a client to view their data.
          </p>
        </div>
      )}

      {selectedClientId && isLoading && (
        <div className="flex items-center justify-center py-10">
          <Loader2 size={24} className="animate-spin text-gray-400" />
        </div>
      )}

      {selectedClientId && error && (
        <div className="px-5 py-10 text-center text-sm text-red-500 dark:text-red-400" data-testid="data-error">
          {error instanceof Error ? error.message : 'Failed to load data'}
        </div>
      )}

      {selectedClientId && !isLoading && !error && children}
    </div>
  );
}

interface BackupsTableProps {
  readonly backups: readonly BackupResponse[];
}

function BackupsTable({ backups }: BackupsTableProps) {
  const { sortedData: sortedBackups, sortKey, sortDirection, onSort } = useSortable(backups, 'createdAt', 'desc');

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full" data-testid="backups-table">
          <thead>
            <tr className="border-b border-gray-100 dark:border-gray-700 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
              <SortableHeader label="Backup ID" sortKey="id" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
              <SortableHeader label="Type" sortKey="backupType" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
              <SortableHeader label="Resource" sortKey="resourceType" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
              <SortableHeader label="Size" sortKey="sizeBytes" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="hidden md:table-cell" />
              <SortableHeader label="Created" sortKey="createdAt" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="hidden lg:table-cell" />
              <SortableHeader label="Expires" sortKey="expiresAt" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="hidden lg:table-cell" />
              <th className="px-5 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {sortedBackups.map((backup) => (
              <tr key={backup.id} className="transition-colors hover:bg-gray-50 dark:hover:bg-gray-700/50">
                <td className="px-5 py-3.5">
                  <span className="font-mono text-sm text-gray-900 dark:text-gray-100">{truncateId(backup.id)}</span>
                </td>
                <td className="px-5 py-3.5">
                  <span
                    className={clsx(
                      'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium capitalize',
                      backup.backupType === 'auto'
                        ? 'bg-blue-100 dark:bg-blue-900/20 text-blue-800 dark:text-blue-300'
                        : 'bg-purple-100 dark:bg-purple-900/20 text-purple-800 dark:text-purple-300',
                    )}
                  >
                    {backup.backupType}
                  </span>
                </td>
                <td className="px-5 py-3.5 text-sm text-gray-600 dark:text-gray-400">{backup.resourceType}</td>
                <td className="hidden px-5 py-3.5 text-sm text-gray-600 dark:text-gray-400 md:table-cell">
                  {backup.sizeBytes ? formatBytes(backup.sizeBytes) : '---'}
                </td>
                <td className="hidden px-5 py-3.5 text-sm text-gray-500 dark:text-gray-400 lg:table-cell">
                  {new Date(backup.createdAt).toLocaleDateString()}
                </td>
                <td className="hidden px-5 py-3.5 text-sm text-gray-500 dark:text-gray-400 lg:table-cell">
                  {backup.expiresAt ? new Date(backup.expiresAt).toLocaleDateString() : '---'}
                </td>
                <td className="px-5 py-3.5 text-right">
                  <RestoreLink backupId={backup.id} />
                </td>
              </tr>
            ))}
            {backups.length === 0 && (
              <tr>
                <td colSpan={7} className="px-5 py-10 text-center text-sm text-gray-500 dark:text-gray-400">
                  No backups found for this client.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Settings tab ─────────────────────────────────────────────────────

function SettingsTab() {
  const { data, isLoading, error } = useStorageLifecycleSettings();
  const update = useUpdateStorageLifecycleSettings();
  const { data: configsData } = useBackupConfigs();
  const backupConfigs = configsData?.data ?? [];

  const settings = data?.data;

  // Form state is seeded from the server response and tracks which
  // fields were actually touched — we only send dirty fields on save
  // so untouched secrets aren't overwritten.
  const [form, setForm] = useState<StorageLifecycleSettingsUpdate>({});
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  useEffect(() => {
    // Reset dirty state when server data loads/changes.
    if (settings) setForm({});
  }, [settings?.backend, settings?.hostpathRoot]);

  const patch = <K extends keyof StorageLifecycleSettingsUpdate>(k: K, v: StorageLifecycleSettingsUpdate[K]) => {
    setForm((prev) => ({ ...prev, [k]: v }));
    setSavedMessage(null);
  };

  const onSave = async () => {
    if (Object.keys(form).length === 0) return;
    try {
      await update.mutateAsync(form);
      setSavedMessage('Settings saved.');
      setTimeout(() => setSavedMessage(null), 3000);
    } catch {
      // react-query also records this on `update.error`, which the
      // banner below renders — we swallow here only to keep the
      // promise-rejection from propagating unhandled.
    }
  };

  if (isLoading) return <div className="flex py-10 justify-center"><Loader2 size={24} className="animate-spin text-gray-400" /></div>;
  if (error) return <p className="text-sm text-red-500">{(error as Error).message}</p>;
  if (!settings) return null;

  const backend = form.backend ?? settings.backend;

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm">
        <div className="flex items-center gap-2 mb-2">
          <SettingsIcon size={16} className="text-gray-500" />
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Snapshot Store</h2>
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
          Where client PVC snapshots are persisted. Changing the backend affects <strong>new</strong> snapshots only — existing archives stay where they were written.
        </p>
        {backupConfigs.length > 0 && (
          <div className="mb-4 rounded-md border border-blue-200 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/20 p-3 text-xs text-blue-700 dark:text-blue-300">
            <strong>Backup targets configured:</strong>{' '}
            {backupConfigs.map((c) => `${c.name} (${c.storageType})`).join(', ')}.{' '}
            <Link to="/settings/backups" className="font-medium underline hover:no-underline">
              Manage targets
            </Link>
            . Selecting an S3 store below will use the same target's credentials when configured.
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Backend</label>
            <select
              value={backend}
              onChange={(e) => patch('backend', e.target.value as 'hostpath' | 's3' | 'azure')}
              className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm"
              data-testid="snapshot-backend-select"
            >
              <option value="hostpath">hostpath (dev / single-node)</option>
              <option value="s3">S3 / S3-compatible</option>
              <option value="azure">Azure Blob</option>
            </select>
          </div>

          {backend === 'hostpath' && (
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Hostpath root</label>
              <input
                type="text"
                value={form.hostpathRoot ?? settings.hostpathRoot}
                onChange={(e) => patch('hostpathRoot', e.target.value)}
                className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm font-mono"
                placeholder="/var/lib/platform/snapshots"
              />
              <p className="mt-1 text-xs text-gray-500">Path on the node that backs the snapshot hostPath volume.</p>
            </div>
          )}
        </div>

        {backend === 's3' && (
          <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
            <SettingInput label="Bucket" value={form.s3Bucket ?? settings.s3Bucket ?? ''} onChange={(v) => patch('s3Bucket', v || null)} />
            <SettingInput label="Region" value={form.s3Region ?? settings.s3Region ?? ''} onChange={(v) => patch('s3Region', v || null)} placeholder="us-east-1" />
            <SettingInput label="Endpoint (optional, for S3-compatible)" value={form.s3Endpoint ?? settings.s3Endpoint ?? ''} onChange={(v) => patch('s3Endpoint', v || null)} placeholder="https://minio.example.com" />
            <SettingInput label="Access Key ID" value={form.s3AccessKeyId ?? settings.s3AccessKeyId ?? ''} onChange={(v) => patch('s3AccessKeyId', v || null)} />
            <SecretInput
              label="Secret Access Key"
              isSet={settings.s3SecretAccessKeySet}
              onChange={(v) => patch('s3SecretAccessKey', v)}
              onClear={() => patch('s3SecretAccessKey', null)}
            />
          </div>
        )}

        {backend === 'azure' && (
          <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
            <SettingInput label="Container" value={form.azureContainer ?? settings.azureContainer ?? ''} onChange={(v) => patch('azureContainer', v || null)} />
            <SecretInput
              label="Connection String"
              isSet={settings.azureConnectionStringSet}
              onChange={(v) => patch('azureConnectionString', v)}
              onClear={() => patch('azureConnectionString', null)}
            />
          </div>
        )}
      </div>

      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-3">Retention Policy (days)</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <NumberInput label="Manual snapshot" value={form.retentionManualDays ?? settings.retentionManualDays} onChange={(v) => patch('retentionManualDays', v)} />
          <NumberInput label="Pre-resize auto-snapshot" value={form.retentionPreResizeDays ?? settings.retentionPreResizeDays} onChange={(v) => patch('retentionPreResizeDays', v)} />
          <NumberInput label="Pre-archive snapshot" value={form.retentionPreArchiveDays ?? settings.retentionPreArchiveDays} onChange={(v) => patch('retentionPreArchiveDays', v)} />
        </div>
        <p className="mt-3 text-xs text-gray-500">Snapshots past their retention are reaped every 6h by the housekeeping scheduler.</p>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={onSave}
          disabled={update.isPending || Object.keys(form).length === 0}
          className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          data-testid="storage-settings-save"
        >
          {update.isPending ? 'Saving…' : 'Save changes'}
        </button>
        {update.error && <p className="text-sm text-red-500">{(update.error as Error).message}</p>}
        {savedMessage && <p className="text-sm text-green-600 dark:text-green-400">{savedMessage}</p>}
      </div>
    </div>
  );
}

/** Per-backup restore action.
 *
 * The actual restore (creating a new Longhorn Volume from the Backup
 * artifact) is a multi-step destructive operation that's safer to
 * drive from the Longhorn dashboard — it shows pre-flight validation,
 * source-volume metadata, and target-volume naming. We deep-link into
 * Longhorn UI's backup-details page rather than re-implementing the
 * flow ourselves and risking partial-restore corner cases.
 *
 * If the Longhorn UI ingress is not configured, this falls back to a
 * disabled tooltip pointing to the backup-target host.
 */
function RestoreLink({ backupId }: { readonly backupId: string }) {
  // Longhorn UI is mounted at /longhorn/ on the platform ingress.
  return (
    <a
      href="/longhorn/#/backup"
      target="_blank"
      rel="noopener noreferrer"
      title={`Open Longhorn UI to restore ${backupId.slice(0, 12)}…`}
      className="inline-flex items-center gap-1 rounded-md border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 px-2 py-1 text-xs font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-600 transition-colors"
    >
      <RotateCcw size={11} />
      Restore
      <ExternalLink size={10} className="text-gray-400" />
    </a>
  );
}

function SettingInput({ label, value, onChange, placeholder }: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (v: string) => void;
  readonly placeholder?: string;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm"
      />
    </div>
  );
}

function NumberInput({ label, value, onChange }: {
  readonly label: string;
  readonly value: number;
  readonly onChange: (v: number) => void;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">{label}</label>
      <input
        type="number"
        min={1}
        max={3650}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm"
      />
    </div>
  );
}

function SecretInput({ label, isSet, onChange, onClear }: {
  readonly label: string;
  readonly isSet: boolean;
  readonly onChange: (v: string) => void;
  readonly onClear: () => void;
}) {
  const [value, setValue] = useState('');
  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
        {label} {isSet && <span className="ml-1 text-green-600 dark:text-green-400">(set)</span>}
      </label>
      <div className="flex gap-2">
        <input
          type="password"
          value={value}
          onChange={(e) => { setValue(e.target.value); onChange(e.target.value); }}
          placeholder={isSet ? '•••••••• (leave blank to keep)' : 'Enter secret'}
          className="flex-1 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm font-mono"
        />
        {isSet && (
          <button
            type="button"
            onClick={() => { setValue(''); onClear(); }}
            className="rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/30 px-3 py-2 text-xs text-red-700 dark:text-red-300 hover:bg-red-100"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
