// Admin upgrades tab — replaces the old UpgradeHistoryTab (which targeted an
// unbuilt /application-upgrades API). This one groups by catalog entry,
// shows each customer's deployment with current/available versions, preview
// URL, auto-upgrade toggle, and per-row action buttons.
//
// Sources:
//   GET /api/v1/admin/upgrades/overview        (the table data)
//   PATCH /api/v1/clients/:cid/.../version     (single upgrade)
//   POST /api/v1/admin/deployments/bulk-upgrade (per-app fleet upgrade)
//   POST /api/v1/admin/deployments/:id/rollback-version (admin rollback)
//   PATCH /api/v1/clients/:cid/.../auto-upgrade (toggle)

import { useState, useMemo } from 'react';
import {
  Loader2,
  AlertCircle,
  ExternalLink,
  RotateCcw,
  ArrowUpCircle,
  Lock,
  AlertTriangle,
  ChevronDown,
  Filter,
  CheckCircle2,
} from 'lucide-react';
import clsx from 'clsx';
import {
  useAdminUpgradesOverview,
  useUpgradeDeploymentVersion,
  useBulkUpgrade,
  useAdminRollback,
  useSetAutoUpgrade,
  type BulkUpgradeResult,
} from '@/hooks/use-deployment-upgrades';
import type { AdminUpgradesGroup, AdminUpgradesDeployment } from '@k8s-hosting/api-contracts';
import StatusBadge from './ui/StatusBadge';

type FilterMode = 'all' | 'upgradeable' | 'stale' | 'strict';

export default function DeploymentUpgradesTab() {
  const { data: groups, isLoading, isError, error } = useAdminUpgradesOverview();
  const [filterMode, setFilterMode] = useState<FilterMode>('upgradeable');
  const [bulkResult, setBulkResult] = useState<{ app: string; toVersion: string; result: BulkUpgradeResult } | null>(null);

  const filtered = useMemo(() => {
    if (!groups) return [];
    const now = Date.now();
    const thirtyDaysMs = 30 * 24 * 3600 * 1000;
    return groups
      .map((g) => {
        let deps = g.deployments;
        if (filterMode === 'upgradeable') deps = deps.filter((d) => d.availableUpgradeCount > 0);
        if (filterMode === 'stale') {
          deps = deps.filter((d) => {
            if (!d.lastUpgradedAt) return true;
            return now - new Date(d.lastUpgradedAt).getTime() > thirtyDaysMs;
          });
        }
        if (filterMode === 'strict' && g.lockMode !== 'strict') return null;
        return { ...g, deployments: deps };
      })
      .filter((g): g is AdminUpgradesGroup => g !== null && g.deployments.length > 0);
  }, [groups, filterMode]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12" data-testid="upgrades-tab-loading">
        <Loader2 size={24} className="animate-spin text-brand-500" />
        <span className="ml-2 text-sm text-gray-500 dark:text-gray-400">Loading upgrades overview…</span>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-700 dark:text-red-400">
        <AlertCircle size={16} />
        <span>Failed to load upgrades overview: {error?.message ?? 'Unknown error'}</span>
      </div>
    );
  }

  const totalDeployments = (groups ?? []).reduce((acc, g) => acc + g.deployments.length, 0);
  const upgradeableCount = (groups ?? []).reduce(
    (acc, g) => acc + g.deployments.filter((d) => d.availableUpgradeCount > 0).length,
    0,
  );

  return (
    <div className="space-y-4" data-testid="deployment-upgrades-tab">
      {/* Header strip */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-3">
        <div className="flex items-center gap-4 text-sm">
          <Stat label="Total deployments" value={totalDeployments} />
          <Stat label="With updates available" value={upgradeableCount} tone={upgradeableCount > 0 ? 'amber' : 'neutral'} />
        </div>
        <div className="flex items-center gap-2">
          <Filter size={14} className="text-gray-400" />
          <select
            value={filterMode}
            onChange={(e) => setFilterMode(e.target.value as FilterMode)}
            className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 py-1.5 pl-3 pr-8 text-sm text-gray-700 dark:text-gray-300 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            data-testid="upgrade-filter"
          >
            <option value="upgradeable">Upgradeable only</option>
            <option value="all">All deployments</option>
            <option value="stale">Not upgraded in 30d</option>
            <option value="strict">Strict-mode apps only</option>
          </select>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-lg border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 px-5 py-10 text-center text-sm text-green-700 dark:text-green-400">
          <CheckCircle2 size={32} className="mx-auto mb-2" />
          {filterMode === 'upgradeable'
            ? 'All deployments are on the latest reachable version.'
            : 'No deployments match this filter.'}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((g) => (
            <AppGroup key={g.catalogEntryId} group={g} onBulkComplete={(toVersion, result) => setBulkResult({ app: g.code, toVersion, result })} />
          ))}
        </div>
      )}

      {bulkResult && (
        <BulkResultModal
          appCode={bulkResult.app}
          toVersion={bulkResult.toVersion}
          result={bulkResult.result}
          onClose={() => setBulkResult(null)}
        />
      )}
    </div>
  );
}

// ─── App group (one row per catalog entry) ──────────────────────────────────

function AppGroup({
  group,
  onBulkComplete,
}: {
  readonly group: AdminUpgradesGroup;
  readonly onBulkComplete: (toVersion: string, result: BulkUpgradeResult) => void;
}) {
  const [open, setOpen] = useState(group.deployments.some((d) => d.availableUpgradeCount > 0));
  const bulkUpgrade = useBulkUpgrade();
  const [bulkTarget, setBulkTarget] = useState<string>('');
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);

  // Collect all distinct versions reachable from at least one deployment.
  const reachableVersions = useMemo(() => {
    const set = new Set<string>();
    for (const d of group.deployments) {
      if (d.latestReachable) set.add(d.latestReachable);
    }
    return Array.from(set).sort();
  }, [group.deployments]);

  // Default bulk target = the most-common latestReachable (covers the most deployments at once).
  const defaultTarget = useMemo(() => {
    const counts = new Map<string, number>();
    for (const d of group.deployments) {
      if (d.latestReachable) counts.set(d.latestReachable, (counts.get(d.latestReachable) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  }, [group.deployments]);

  const upgradeableIds = group.deployments
    .filter((d) => d.latestReachable && d.latestReachable === (bulkTarget || defaultTarget))
    .map((d) => d.id);

  const lockBadge = LOCK_BADGES[group.lockMode];

  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-800/70"
        data-testid={`app-group-${group.code}`}
      >
        <div className="flex items-center gap-3">
          <ChevronDown size={16} className={clsx('text-gray-400 transition-transform', !open && '-rotate-90')} />
          <span className="font-medium text-gray-900 dark:text-gray-100">{group.name}</span>
          <span className="text-xs text-gray-500 dark:text-gray-400 font-mono">{group.code}</span>
          <span className={clsx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', lockBadge.classes)}>
            {lockBadge.icon} {lockBadge.label}
          </span>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span className="text-gray-500 dark:text-gray-400">{group.deployments.length} deployment{group.deployments.length !== 1 ? 's' : ''}</span>
          {group.latestVersion && (
            <span className="rounded-md bg-gray-100 dark:bg-gray-700 px-2 py-0.5 font-mono text-gray-700 dark:text-gray-300">
              latest: {group.latestVersion}
            </span>
          )}
        </div>
      </button>

      {open && (
        <div className="border-t border-gray-100 dark:border-gray-700">
          {/* Bulk action strip */}
          {upgradeableIds.length > 1 && (
            <div className="flex items-center gap-3 border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 px-4 py-2">
              <span className="text-xs text-gray-600 dark:text-gray-400">Fleet upgrade:</span>
              <select
                value={bulkTarget || defaultTarget}
                onChange={(e) => setBulkTarget(e.target.value)}
                className="rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 py-1 pl-2 pr-7 text-xs"
                data-testid={`bulk-target-${group.code}`}
              >
                {reachableVersions.map((v) => (
                  <option key={v} value={v}>v{v}</option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => setBulkConfirmOpen(true)}
                className="inline-flex items-center gap-1 rounded-md bg-brand-50 dark:bg-brand-900/30 px-2.5 py-1 text-xs font-medium text-brand-700 dark:text-brand-300 hover:bg-brand-100 dark:hover:bg-brand-800/50"
                data-testid={`bulk-upgrade-${group.code}`}
              >
                <ArrowUpCircle size={12} />
                Upgrade {upgradeableIds.length} deployments
              </button>
            </div>
          )}

          {/* Deployment rows */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid={`deployments-table-${group.code}`}>
              <thead>
                <tr className="border-b border-gray-100 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/50 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  <th className="px-4 py-2">Customer</th>
                  <th className="px-4 py-2">Deployment</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2">Current</th>
                  <th className="px-4 py-2">Available</th>
                  <th className="px-4 py-2">Last upgraded</th>
                  <th className="px-4 py-2">Auto</th>
                  <th className="px-4 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {group.deployments.map((d) => (
                  <DeploymentRow key={d.id} dep={d} lockMode={group.lockMode} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {bulkConfirmOpen && (
        <BulkUpgradeConfirm
          appName={group.name}
          appCode={group.code}
          deploymentIds={upgradeableIds}
          targetVersion={bulkTarget || defaultTarget}
          lockMode={group.lockMode}
          onClose={() => setBulkConfirmOpen(false)}
          onConfirm={(force) => {
            const target = bulkTarget || defaultTarget;
            bulkUpgrade.mutate(
              { deploymentIds: upgradeableIds, targetVersion: target, force },
              {
                onSuccess: (result) => {
                  setBulkConfirmOpen(false);
                  onBulkComplete(target, result);
                },
              },
            );
          }}
          isPending={bulkUpgrade.isPending}
        />
      )}
    </div>
  );
}

// ─── Per-deployment row ─────────────────────────────────────────────────────

function DeploymentRow({ dep, lockMode }: { readonly dep: AdminUpgradesDeployment; readonly lockMode: 'strict' | 'advisory' | 'open' }) {
  const upgrade = useUpgradeDeploymentVersion();
  const rollback = useAdminRollback();
  const toggleAuto = useSetAutoUpgrade();
  const [upgradeConfirmOpen, setUpgradeConfirmOpen] = useState(false);
  const [rollbackConfirmOpen, setRollbackConfirmOpen] = useState(false);

  const canRollback = !!dep.previousVersion;
  const canAutoToggle = lockMode !== 'strict';

  return (
    <>
      <tr className="hover:bg-gray-50 dark:hover:bg-gray-800/50" data-testid={`deployment-row-${dep.id}`}>
        <td className="px-4 py-2 text-gray-900 dark:text-gray-100">{dep.clientCompanyName ?? <span className="text-gray-400">—</span>}</td>
        <td className="px-4 py-2">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-gray-700 dark:text-gray-300">{dep.name}</span>
            {dep.previewUrl && (
              <a
                href={dep.previewUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-0.5 text-xs text-brand-600 hover:text-brand-700 dark:text-brand-400"
                title={dep.previewUrl}
                data-testid={`preview-${dep.id}`}
              >
                <ExternalLink size={11} />
              </a>
            )}
          </div>
        </td>
        <td className="px-4 py-2">
          <StatusBadge status={dep.status as Parameters<typeof StatusBadge>[0]['status']} />
        </td>
        <td className="px-4 py-2 font-mono text-xs text-gray-700 dark:text-gray-300">
          {dep.installedVersion ? `v${dep.installedVersion}` : <span className="text-gray-400">—</span>}
        </td>
        <td className="px-4 py-2">
          {dep.availableUpgradeCount > 0 ? (
            <span className="inline-flex items-center gap-1 rounded-md bg-amber-50 dark:bg-amber-900/20 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">
              <ArrowUpCircle size={11} />
              {dep.latestReachable ? `v${dep.latestReachable}` : `${dep.availableUpgradeCount} available`}
            </span>
          ) : (
            <span className="text-xs text-gray-400">up to date</span>
          )}
        </td>
        <td className="px-4 py-2 text-xs text-gray-500 dark:text-gray-400">
          {dep.lastUpgradedAt ? new Date(dep.lastUpgradedAt).toLocaleDateString() : <span className="text-gray-400">never</span>}
        </td>
        <td className="px-4 py-2">
          {canAutoToggle ? (
            <label className="inline-flex items-center cursor-pointer" data-testid={`auto-toggle-${dep.id}`}>
              <input
                type="checkbox"
                checked={dep.autoUpgrade}
                onChange={(e) =>
                  toggleAuto.mutate({ clientId: dep.clientId, deploymentId: dep.id, enabled: e.target.checked })
                }
                disabled={toggleAuto.isPending}
                className="h-3.5 w-3.5 rounded border-gray-300 dark:border-gray-600 text-brand-500 focus:ring-brand-500"
              />
            </label>
          ) : (
            <span className="text-xs text-gray-400" title="Strict-mode apps require manual upgrade">—</span>
          )}
        </td>
        <td className="px-4 py-2">
          <div className="flex items-center justify-end gap-1">
            {dep.availableUpgradeCount > 0 && dep.latestReachable && (
              <button
                type="button"
                onClick={() => setUpgradeConfirmOpen(true)}
                className="inline-flex items-center gap-1 rounded-md bg-brand-50 dark:bg-brand-900/30 px-2 py-1 text-xs font-medium text-brand-700 dark:text-brand-300 hover:bg-brand-100 dark:hover:bg-brand-800/50"
                data-testid={`upgrade-btn-${dep.id}`}
              >
                <ArrowUpCircle size={11} /> Upgrade
              </button>
            )}
            {canRollback && (
              <button
                type="button"
                onClick={() => setRollbackConfirmOpen(true)}
                className="inline-flex items-center gap-1 rounded-md bg-orange-50 dark:bg-orange-900/20 px-2 py-1 text-xs font-medium text-orange-700 dark:text-orange-300 hover:bg-orange-100 dark:hover:bg-orange-800/50"
                title={`Roll back to v${dep.previousVersion}`}
                data-testid={`rollback-btn-${dep.id}`}
              >
                <RotateCcw size={11} /> Rollback
              </button>
            )}
          </div>
        </td>
      </tr>

      {upgradeConfirmOpen && dep.latestReachable && (
        <SingleUpgradeConfirm
          dep={dep}
          targetVersion={dep.latestReachable}
          lockMode={lockMode}
          isPending={upgrade.isPending}
          onClose={() => setUpgradeConfirmOpen(false)}
          onConfirm={(force) =>
            upgrade.mutate(
              { clientId: dep.clientId, deploymentId: dep.id, targetVersion: dep.latestReachable!, force },
              { onSuccess: () => setUpgradeConfirmOpen(false) },
            )
          }
          error={upgrade.error}
        />
      )}

      {rollbackConfirmOpen && (
        <RollbackConfirm
          dep={dep}
          isPending={rollback.isPending}
          onClose={() => setRollbackConfirmOpen(false)}
          onConfirm={() =>
            rollback.mutate(
              { deploymentId: dep.id },
              { onSuccess: () => setRollbackConfirmOpen(false) },
            )
          }
          error={rollback.error}
        />
      )}
    </>
  );
}

// ─── Modals + helpers ───────────────────────────────────────────────────────

function SingleUpgradeConfirm({
  dep,
  targetVersion,
  lockMode,
  isPending,
  onClose,
  onConfirm,
  error,
}: {
  readonly dep: AdminUpgradesDeployment;
  readonly targetVersion: string;
  readonly lockMode: 'strict' | 'advisory' | 'open';
  readonly isPending: boolean;
  readonly onClose: () => void;
  readonly onConfirm: (force: boolean) => void;
  readonly error: Error | null;
}) {
  return (
    <ModalShell title={`Upgrade ${dep.name}`} onClose={onClose}>
      <p className="text-sm text-gray-600 dark:text-gray-300">
        Upgrade <span className="font-mono">{dep.name}</span> from{' '}
        <span className="font-mono">{dep.installedVersion ? `v${dep.installedVersion}` : '(none)'}</span> to{' '}
        <span className="font-mono">v{targetVersion}</span>?
      </p>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        The deployment will restart. Schema migrations run automatically on supported apps.
        {lockMode === 'strict' && ' This app requires one-major-at-a-time upgrades — the platform enforces the path.'}
      </p>
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-700 dark:text-red-400">
          {error.message}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => onConfirm(false)}
          disabled={isPending}
          className="inline-flex items-center gap-1 rounded-md bg-brand-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
          data-testid="confirm-upgrade-btn"
        >
          {isPending && <Loader2 size={12} className="animate-spin" />}
          Upgrade
        </button>
      </div>
    </ModalShell>
  );
}

function RollbackConfirm({
  dep,
  isPending,
  onClose,
  onConfirm,
  error,
}: {
  readonly dep: AdminUpgradesDeployment;
  readonly isPending: boolean;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
  readonly error: Error | null;
}) {
  return (
    <ModalShell title={`Roll back ${dep.name}`} onClose={onClose}>
      <p className="text-sm text-gray-600 dark:text-gray-300">
        Revert <span className="font-mono">{dep.name}</span> from{' '}
        <span className="font-mono">v{dep.installedVersion}</span> to{' '}
        <span className="font-mono">v{dep.previousVersion}</span>?
      </p>
      <div className="rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
        <AlertTriangle size={12} className="inline mr-1 -mt-0.5" />
        <strong>Schema migrations are NOT reversed.</strong> If the upgrade changed the database schema,
        rolling back the image may leave the app in an inconsistent state. Restore from a tenant snapshot
        if your data integrity is at risk.
      </div>
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-700 dark:text-red-400">
          {error.message}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={isPending}
          className="inline-flex items-center gap-1 rounded-md bg-orange-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-orange-600 disabled:opacity-50"
          data-testid="confirm-rollback-btn"
        >
          {isPending && <Loader2 size={12} className="animate-spin" />}
          Roll back
        </button>
      </div>
    </ModalShell>
  );
}

function BulkUpgradeConfirm({
  appName,
  appCode,
  deploymentIds,
  targetVersion,
  lockMode,
  onClose,
  onConfirm,
  isPending,
}: {
  readonly appName: string;
  readonly appCode: string;
  readonly deploymentIds: readonly string[];
  readonly targetVersion: string;
  readonly lockMode: 'strict' | 'advisory' | 'open';
  readonly onClose: () => void;
  readonly onConfirm: (force: boolean) => void;
  readonly isPending: boolean;
}) {
  return (
    <ModalShell title={`Upgrade all ${appName} deployments`} onClose={onClose}>
      <p className="text-sm text-gray-600 dark:text-gray-300">
        Upgrade <strong>{deploymentIds.length}</strong> {appCode} deployment{deploymentIds.length !== 1 ? 's' : ''} to{' '}
        <span className="font-mono">v{targetVersion}</span>?
      </p>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Each deployment is upgraded sequentially. Failures are recorded but won't abort the batch — you'll get a summary at the end.
      </p>
      {lockMode === 'strict' && (
        <div className="rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle size={12} className="inline mr-1 -mt-0.5" />
          Strict-mode app — only deployments where v{targetVersion} is directly reachable from their current version will be upgraded. Others stay put.
        </div>
      )}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => onConfirm(false)}
          disabled={isPending}
          className="inline-flex items-center gap-1 rounded-md bg-brand-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
          data-testid="confirm-bulk-upgrade-btn"
        >
          {isPending && <Loader2 size={12} className="animate-spin" />}
          Upgrade {deploymentIds.length}
        </button>
      </div>
    </ModalShell>
  );
}

function BulkResultModal({
  appCode,
  toVersion,
  result,
  onClose,
}: {
  readonly appCode: string;
  readonly toVersion: string;
  readonly result: BulkUpgradeResult;
  readonly onClose: () => void;
}) {
  return (
    <ModalShell title={`Bulk upgrade complete: ${appCode} → v${toVersion}`} onClose={onClose}>
      <div className="grid grid-cols-3 gap-3 text-center text-sm">
        <Stat label="Succeeded" value={result.succeeded} tone="green" />
        <Stat label="Failed" value={result.failed} tone={result.failed > 0 ? 'red' : 'neutral'} />
        <Stat label="Total" value={result.total} />
      </div>
      {result.errors.length > 0 && (
        <div className="max-h-64 overflow-y-auto rounded-md border border-red-200 bg-red-50 dark:bg-red-900/20 p-3 text-xs">
          {result.errors.map((e) => (
            <div key={e.deploymentId} className="border-b border-red-100 dark:border-red-800/30 py-1 last:border-0">
              <span className="font-mono text-red-700 dark:text-red-300">{e.deploymentId.slice(0, 8)}</span>
              {e.code && <span className="ml-2 text-red-600 dark:text-red-400">[{e.code}]</span>}
              <div className="text-red-700 dark:text-red-300">{e.error}</div>
            </div>
          ))}
        </div>
      )}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md bg-brand-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-600"
        >
          Close
        </button>
      </div>
    </ModalShell>
  );
}

function ModalShell({
  title,
  children,
  onClose,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
  readonly onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg space-y-3 rounded-lg bg-white dark:bg-gray-800 p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        data-testid="upgrade-modal"
      >
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
        {children}
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { readonly label: string; readonly value: number; readonly tone?: 'amber' | 'green' | 'red' | 'neutral' }) {
  const toneClass = tone === 'amber'
    ? 'text-amber-600 dark:text-amber-400'
    : tone === 'green'
    ? 'text-green-600 dark:text-green-400'
    : tone === 'red'
    ? 'text-red-600 dark:text-red-400'
    : 'text-gray-700 dark:text-gray-300';
  return (
    <div>
      <div className={clsx('text-lg font-semibold', toneClass)}>{value}</div>
      <div className="text-xs text-gray-500 dark:text-gray-400">{label}</div>
    </div>
  );
}

const LOCK_BADGES = {
  strict: {
    label: 'strict',
    icon: <Lock size={10} />,
    classes: 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300',
  },
  advisory: {
    label: 'advisory',
    icon: null,
    classes: 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300',
  },
  open: {
    label: 'open',
    icon: null,
    classes: 'bg-gray-50 dark:bg-gray-900/20 text-gray-600 dark:text-gray-400',
  },
} as const;
