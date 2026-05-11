// Client-panel "Available updates" card for an installed deployment.
// Used inside InstalledAppDetailModal. Mirrors the admin-panel surface but
// from the customer's POV: pick a target version, confirm the upgrade, see
// the rollback button after a successful upgrade.

import { useState } from 'react';
import { Loader2, ArrowUpCircle, AlertTriangle, RotateCcw, Lock, CheckCircle2 } from 'lucide-react';
import clsx from 'clsx';
import { apiFetch } from '@/lib/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AvailableUpgradesResponse, DeploymentResponse } from '@k8s-hosting/api-contracts';

interface Props {
  readonly clientId: string;
  readonly deploymentId: string;
  readonly deploymentName: string;
  readonly installedVersion: string | null;
  readonly previousVersion: string | null;
}

// ─── Hooks ──────────────────────────────────────────────────────────────────
// Local copies — the client-panel has its own apiFetch and hook conventions
// (separate package, no shared admin hook dir). These mirror the admin hooks
// in functionality but are scoped to client-panel.

function useAvailableUpgrades(clientId: string, deploymentId: string) {
  return useQuery({
    queryKey: ['available-upgrades', clientId, deploymentId],
    queryFn: () =>
      apiFetch<{ data: AvailableUpgradesResponse }>(
        `/api/v1/clients/${clientId}/deployments/${deploymentId}/available-upgrades`,
      ).then((r) => r.data),
    staleTime: 60_000,
  });
}

function useUpgradeVersion(clientId: string, deploymentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ targetVersion }: { targetVersion: string }) =>
      apiFetch<{ data: DeploymentResponse }>(
        `/api/v1/clients/${clientId}/deployments/${deploymentId}/version`,
        { method: 'PATCH', body: JSON.stringify({ target_version: targetVersion }) },
      ).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['available-upgrades', clientId, deploymentId] });
      qc.invalidateQueries({ queryKey: ['deployments', clientId] });
      qc.invalidateQueries({ queryKey: ['deployment', deploymentId] });
    },
  });
}

function useRollbackVersion(clientId: string, deploymentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ data: DeploymentResponse }>(
        `/api/v1/clients/${clientId}/deployments/${deploymentId}/rollback-version`,
        { method: 'POST' },
      ).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['available-upgrades', clientId, deploymentId] });
      qc.invalidateQueries({ queryKey: ['deployments', clientId] });
      qc.invalidateQueries({ queryKey: ['deployment', deploymentId] });
    },
  });
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function AvailableUpgradesCard({
  clientId,
  deploymentId,
  deploymentName,
  installedVersion,
  previousVersion,
}: Props) {
  const { data, isLoading, isError } = useAvailableUpgrades(clientId, deploymentId);
  const upgrade = useUpgradeVersion(clientId, deploymentId);
  const rollback = useRollbackVersion(clientId, deploymentId);
  const [confirmTarget, setConfirmTarget] = useState<string | null>(null);
  const [rollbackConfirmOpen, setRollbackConfirmOpen] = useState(false);

  // Hide the card entirely while loading + when no upgrades are available
  // AND no rollback is available. The customer doesn't need to see "nothing
  // here" — Apps that ARE updateable get a colourful badge instead.
  if (isLoading) return null;
  if (isError) return null;
  if (!data) return null;

  const direct = data.direct;
  const chain = data.recommendedChain;
  const canRollback = !!previousVersion;
  const hasUpdates = direct.length > 0;

  if (!hasUpdates && !canRollback) return null;

  return (
    <div className="mb-6 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-4" data-testid="available-upgrades-card">
      <div className="flex items-start gap-3">
        <ArrowUpCircle size={20} className="mt-0.5 text-amber-600 dark:text-amber-400 flex-shrink-0" />
        <div className="flex-1 space-y-3">
          <div>
            <h3 className="font-semibold text-gray-900 dark:text-gray-100">
              {hasUpdates ? `${direct.length} update${direct.length !== 1 ? 's' : ''} available` : 'Rollback available'}
            </h3>
            <p className="text-xs text-gray-600 dark:text-gray-400">
              Currently running <span className="font-mono">{installedVersion ? `v${installedVersion}` : 'unversioned'}</span>
              {data.lockMode === 'strict' && (
                <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-red-100 dark:bg-red-900/30 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:text-red-300">
                  <Lock size={9} /> strict mode
                </span>
              )}
            </p>
          </div>

          {/* Direct upgrades */}
          {hasUpdates && (
            <div className="flex flex-wrap items-center gap-2">
              {direct.map((u) => (
                <button
                  key={u.version}
                  type="button"
                  onClick={() => setConfirmTarget(u.version)}
                  className={clsx(
                    'inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors',
                    u.isDefault
                      ? 'border-brand-300 dark:border-brand-700 bg-brand-50 dark:bg-brand-900/30 text-brand-700 dark:text-brand-300 hover:bg-brand-100 dark:hover:bg-brand-800/50'
                      : 'border-amber-300 dark:border-amber-700 bg-white dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-800/50',
                  )}
                  data-testid={`upgrade-to-${u.version}`}
                >
                  Upgrade to v{u.version}
                  {u.isDefault && <span className="text-[10px] font-normal opacity-70">recommended</span>}
                  {u.eolDate && new Date(u.eolDate) < new Date(Date.now() + 90 * 24 * 3600_000) && (
                    <span className="text-[10px] font-normal text-red-600 dark:text-red-400">EOL {u.eolDate}</span>
                  )}
                </button>
              ))}
            </div>
          )}

          {/* Recommended chain for strict apps that can't reach the newest directly */}
          {chain.length > 0 && (
            <div className="rounded-md border border-amber-300 dark:border-amber-700 bg-white/50 dark:bg-amber-900/10 p-3 text-xs">
              <div className="font-medium text-gray-700 dark:text-gray-300 mb-1">
                To reach the newest version, upgrade through these intermediate releases:
              </div>
              <div className="flex items-center gap-1 font-mono text-gray-600 dark:text-gray-400">
                <span className="opacity-60">v{installedVersion}</span>
                {chain.map((c, i) => (
                  <span key={c.version} className="flex items-center gap-1">
                    <span>→</span>
                    <span className={clsx(i === 0 && 'text-brand-600 dark:text-brand-400 font-semibold')}>v{c.version}</span>
                  </span>
                ))}
              </div>
              <div className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
                The platform enforces one-major-at-a-time upgrades for this app. Start with the first hop.
              </div>
            </div>
          )}

          {/* Rollback */}
          {canRollback && (
            <div className="flex items-center gap-2 pt-1 border-t border-amber-200/50 dark:border-amber-800/50">
              <span className="text-xs text-gray-600 dark:text-gray-400">
                Recently upgraded from v{previousVersion}?
              </span>
              <button
                type="button"
                onClick={() => setRollbackConfirmOpen(true)}
                className="inline-flex items-center gap-1 rounded-md border border-orange-300 dark:border-orange-700 bg-white dark:bg-orange-900/30 px-2 py-1 text-xs font-medium text-orange-700 dark:text-orange-300 hover:bg-orange-50 dark:hover:bg-orange-800/50"
                data-testid="rollback-btn"
              >
                <RotateCcw size={11} /> Roll back to v{previousVersion}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Confirm modals */}
      {confirmTarget && (
        <UpgradeConfirmModal
          deploymentName={deploymentName}
          fromVersion={installedVersion}
          toVersion={confirmTarget}
          lockMode={data.lockMode}
          isPending={upgrade.isPending}
          error={upgrade.error}
          onClose={() => setConfirmTarget(null)}
          onConfirm={() =>
            upgrade.mutate(
              { targetVersion: confirmTarget },
              { onSuccess: () => setConfirmTarget(null) },
            )
          }
        />
      )}

      {rollbackConfirmOpen && previousVersion && (
        <RollbackConfirmModal
          deploymentName={deploymentName}
          fromVersion={installedVersion}
          toVersion={previousVersion}
          isPending={rollback.isPending}
          error={rollback.error}
          onClose={() => setRollbackConfirmOpen(false)}
          onConfirm={() => rollback.mutate(undefined, { onSuccess: () => setRollbackConfirmOpen(false) })}
        />
      )}

      {upgrade.isSuccess && !confirmTarget && (
        <div className="mt-2 flex items-center gap-1 text-xs text-green-700 dark:text-green-400">
          <CheckCircle2 size={12} /> Upgrade started — your app is restarting with the new version.
        </div>
      )}
    </div>
  );
}

// ─── Modals ────────────────────────────────────────────────────────────────

function UpgradeConfirmModal({
  deploymentName,
  fromVersion,
  toVersion,
  lockMode,
  isPending,
  error,
  onClose,
  onConfirm,
}: {
  readonly deploymentName: string;
  readonly fromVersion: string | null;
  readonly toVersion: string;
  readonly lockMode: 'strict' | 'advisory' | 'open';
  readonly isPending: boolean;
  readonly error: Error | null;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md space-y-3 rounded-lg bg-white dark:bg-gray-800 p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        data-testid="upgrade-confirm-modal"
      >
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Upgrade {deploymentName}</h3>
        <p className="text-sm text-gray-600 dark:text-gray-300">
          This will restart your app at version <span className="font-mono">v{toVersion}</span>
          {fromVersion && <> (currently <span className="font-mono">v{fromVersion}</span>)</>}. Database
          migrations run automatically for supported apps.
        </p>
        {lockMode === 'strict' && (
          <div className="rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            <AlertTriangle size={12} className="inline mr-1 -mt-0.5" />
            This app upgrades one major version at a time. We recommend backing up before proceeding.
          </div>
        )}
        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-700 dark:text-red-400">
            {error.message}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isPending}
            className="inline-flex items-center gap-1 rounded-md bg-brand-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
            data-testid="confirm-upgrade"
          >
            {isPending && <Loader2 size={12} className="animate-spin" />}
            Upgrade now
          </button>
        </div>
      </div>
    </div>
  );
}

function RollbackConfirmModal({
  deploymentName,
  fromVersion,
  toVersion,
  isPending,
  error,
  onClose,
  onConfirm,
}: {
  readonly deploymentName: string;
  readonly fromVersion: string | null;
  readonly toVersion: string;
  readonly isPending: boolean;
  readonly error: Error | null;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md space-y-3 rounded-lg bg-white dark:bg-gray-800 p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        data-testid="rollback-confirm-modal"
      >
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Roll back {deploymentName}</h3>
        <p className="text-sm text-gray-600 dark:text-gray-300">
          Revert from <span className="font-mono">v{fromVersion}</span> back to{' '}
          <span className="font-mono">v{toVersion}</span>?
        </p>
        <div className="rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle size={12} className="inline mr-1 -mt-0.5" />
          <strong>Heads up:</strong> Schema migrations applied during the upgrade are NOT reversed.
          If your app changed its database schema, rolling back may leave data in an inconsistent state.
          Restore from a snapshot if you're unsure.
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
            className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isPending}
            className="inline-flex items-center gap-1 rounded-md bg-orange-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-orange-600 disabled:opacity-50"
            data-testid="confirm-rollback"
          >
            {isPending && <Loader2 size={12} className="animate-spin" />}
            Roll back
          </button>
        </div>
      </div>
    </div>
  );
}
