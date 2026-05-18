/**
 * /backups/system — consolidated System Backups page.
 *
 * Sub-tabs:
 *   1. Filesystem Snapshots — Longhorn CSI for Longhorn PVCs + the
 *      per-PVC drill-in modal. Also surfaces the local-path PVC
 *      (stalwart-rocksdb-data) row with restic-merged stats.
 *   2. Object Backups — Mail restic, Secrets bundle, Postgres
 *      WAL archive, System DBs. Each surfaces its own schedule
 *      strip + Enable/Disable toggle (strict-gated).
 *   3. Restore — PITR modal launcher, Longhorn rollback, secrets
 *      bundle restore.
 *   4. DR Drill — existing component verbatim.
 *   5. Activity — recent audit (system subsystems).
 *
 * Replaces:
 *   - /storage (admin "Backups & Snapshots" tab content)
 *   - /system-backup (old SystemBackupPage)
 *   - MailSnapshotHealthCard on Email Management
 */

import { useSearchParams, Link } from 'react-router-dom';
import {
  Shield, HardDrive, Database, Activity as ActivityIcon, RotateCw, Stethoscope,
  AlertTriangle, CheckCircle, Loader2,
} from 'lucide-react';
import clsx from 'clsx';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { SystemBackupsOverview } from '@k8s-hosting/api-contracts';
import SecretsBundleTab from '@/components/system-backup/SecretsBundleTab';
import SystemDatabasesTab from '@/components/system-backup/SystemDatabasesTab';
import WalArchiveTab from '@/components/system-backup/WalArchiveTab';
import DrDrillTab from '@/components/system-backup/DrDrillTab';
import SystemSnapshotsSection from '@/components/SystemSnapshotsSection';
import ScheduleCard from '@/components/backups/ScheduleCard';
import MailObjectBackupCard from '@/components/backups/MailObjectBackupCard';

type Tab = 'filesystem' | 'object' | 'restore' | 'dr-drill' | 'activity';

const TABS: Array<{ id: Tab; label: string; icon: typeof Shield }> = [
  { id: 'filesystem', label: 'Filesystem Snapshots', icon: HardDrive },
  { id: 'object',     label: 'Object Backups',       icon: Database },
  { id: 'restore',    label: 'Restore',              icon: RotateCw },
  { id: 'dr-drill',   label: 'DR Drill',             icon: Stethoscope },
  { id: 'activity',   label: 'Activity',             icon: ActivityIcon },
];

function isTab(v: string | null): v is Tab {
  return TABS.some((t) => t.id === v);
}

function formatBytes(b: number): string {
  if (b === 0) return '0 B';
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GiB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(2)} MiB`;
  if (b >= 1024) return `${(b / 1024).toFixed(2)} KiB`;
  return `${b} B`;
}

function formatAge(seconds: number | null): string {
  if (seconds === null) return 'never';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export default function SystemBackups() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const tab: Tab = isTab(raw) ? raw : 'filesystem';

  const { data, isLoading, error } = useQuery({
    queryKey: ['admin', 'backups', 'system', 'overview'],
    queryFn: () => apiFetch<{ data: SystemBackupsOverview }>('/api/v1/admin/backups/system/overview'),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
  const ov = data?.data;

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <Shield size={22} className="text-brand-600 dark:text-brand-400" />
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">System Backups</h1>
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400 max-w-3xl">
          Platform-side backups: filesystem snapshots (Longhorn / local-path) and object
          backups (mail restic, secrets bundle, Postgres WAL archive). Customer-side
          data lives under{' '}
          <Link to="/backups/tenants" className="font-medium text-brand-600 dark:text-brand-400 hover:underline">Tenant Backups</Link>.
        </p>
      </header>

      {/* ── KPI strip ───────────────────────────────────────────────── */}
      <section
        className="grid grid-cols-1 gap-3 md:grid-cols-4"
        data-testid="system-backups-kpi"
      >
        <KpiCard
          label="Filesystem snapshots"
          value={isLoading ? '…' : String(ov?.filesystem.totalSnapshots ?? 0)}
          sub={isLoading ? '' : `${formatBytes(ov?.filesystem.totalBytes ?? 0)} across ${ov?.filesystem.pvcsWithSnapshots ?? 0} PVCs`}
        />
        <KpiCard
          label="Mail restic snapshots"
          value={isLoading ? '…' : String(ov?.objectBackups.mail.snapshotCount ?? 0)}
          sub={isLoading ? '' : ov?.objectBackups.mail.lastRunAt
            ? `Last run ${formatAge(ov.objectBackups.mail.secondsSinceLastRun)} ago`
            : 'No restic runs yet'}
          warn={!!(ov && !ov.objectBackups.mail.healthy && ov.objectBackups.mail.enabled)}
        />
        <KpiCard
          label="Secrets bundle"
          value={ov?.objectBackups.secrets.lastBackupAt ? '✓' : '—'}
          sub={ov?.objectBackups.secrets.lastBackupAt
            ? formatBytes(ov.objectBackups.secrets.sizeBytes ?? 0)
            : 'No bundle exported yet'}
        />
        <KpiCard
          label="Postgres PITR base"
          value={ov?.objectBackups.pitr.baseBackupAt ? '✓' : '—'}
          sub={ov?.objectBackups.pitr.baseBackupAt
            ? `Base ${formatAge(ov.objectBackups.pitr.secondsSinceBase)} old`
            : 'No base backup yet'}
        />
      </section>

      {error && (
        <div className="rounded-lg border border-rose-200 dark:border-rose-700 bg-rose-50 dark:bg-rose-900/20 px-4 py-3 text-sm text-rose-700 dark:text-rose-300">
          Overview load failed: {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      {/* ── Sub-tab nav ─────────────────────────────────────────────── */}
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
                data-testid={`system-backups-tab-${t.id}`}
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

      {/* ── Tab content ─────────────────────────────────────────────── */}
      <div data-testid={`system-backups-pane-${tab}`}>
        {tab === 'filesystem' && (
          <div className="space-y-3">
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Block-level snapshots for system PVCs. CNPG clusters collapse into one row;
              click a row to drill into per-replica PVCs and take / restore / delete individual
              snapshots.
            </p>
            <SystemSnapshotsSection />
          </div>
        )}

        {tab === 'object' && (
          <div className="space-y-6">
            <ScheduleCard
              subsystem="mail"
              title="Mail snapshots schedule"
              description="Restic backup of /var/lib/stalwart/data — runs as a CronJob in the mail namespace."
            />
            <MailObjectBackupCard ov={ov} loading={isLoading} />
            <ScheduleCard
              subsystem="system_pitr"
              title="Postgres PITR base backups"
              description="Daily base backup of the platform postgres. WAL archiving runs continuously when enabled."
            />
            <SecretsBundleTab />
            <SystemDatabasesTab />
            <WalArchiveTab />
          </div>
        )}

        {tab === 'restore' && <RestorePanel />}

        {tab === 'dr-drill' && <DrDrillTab />}

        {tab === 'activity' && <RecentActivity subsystem="system" />}
      </div>
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────

function KpiCard({ label, value, sub, warn }: { label: string; value: string; sub: string; warn?: boolean }) {
  return (
    <div className={clsx(
      'rounded-xl border bg-white dark:bg-gray-800 p-4 shadow-sm',
      warn ? 'border-amber-300 dark:border-amber-700' : 'border-gray-200 dark:border-gray-700',
    )}>
      <div className="flex items-center gap-2">
        <div className="text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400">{label}</div>
        {warn ? <AlertTriangle size={12} className="text-amber-600 dark:text-amber-400" /> : null}
      </div>
      <div className="mt-1 text-2xl font-semibold text-gray-900 dark:text-gray-100">{value}</div>
      <div className="text-xs text-gray-500 dark:text-gray-400">{sub}</div>
    </div>
  );
}

function RestorePanel() {
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm">
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Postgres point-in-time recovery</h3>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Restore the platform Postgres to a specific Longhorn snapshot + optional sub-hour PITR target.
          The orchestrator auto-promotes the restored cluster and replaces the source. Drives a multi-
          step modal — see Filesystem Snapshots tab to pick a snapshot.
        </p>
        <Link
          to="/backups/system?tab=filesystem"
          className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-brand-600 dark:text-brand-400 hover:underline"
        >
          Open Filesystem Snapshots →
        </Link>
      </div>
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm">
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Longhorn volume rollback</h3>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Pick a system PVC under Filesystem Snapshots → open the per-volume modal → Restore.
        </p>
      </div>
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm">
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Secrets bundle restore</h3>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Open the Secrets Bundle card under Object Backups → "Restore from bundle" — operator
          authenticates with the master key.
        </p>
      </div>
    </div>
  );
}

function RecentActivity({ subsystem }: { subsystem: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'audit-logs', { category: 'backup', subsystem }],
    queryFn: () => apiFetch<{ data: { rows: Array<{ id: string; action: string; resourceType: string; resourceId: string | null; createdAt: string; actorEmail: string | null }> } }>(
      `/api/v1/admin/audit-logs?category=backup&limit=25${subsystem ? `&subsystem=${encodeURIComponent(subsystem)}` : ''}`,
    ),
    staleTime: 15_000,
  });
  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm">
      <div className="flex items-center gap-2">
        <ActivityIcon size={16} className="text-gray-500" />
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Recent activity</h3>
        <span className="ml-auto text-xs text-gray-400">last 25</span>
      </div>
      {isLoading ? (
        <div className="mt-4 flex items-center gap-2 text-sm text-gray-500">
          <Loader2 size={14} className="animate-spin" /> Loading…
        </div>
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
                {new Date(r.createdAt).toLocaleString()}
                {r.actorEmail ? ` · ${r.actorEmail}` : ''}
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
