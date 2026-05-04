import { useEffect, useState } from 'react';
import { CheckCircle, AlertTriangle, Loader2, X, AlertCircle, AlertOctagon } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import type { PlatformStorageApplyRun } from '@k8s-hosting/api-contracts';

/**
 * Live progress for an Apply HA / Apply Local run.
 *
 * The PATCH /admin/platform-storage-policy returns runId + runStatus
 * along with the synchronous patch outcome. This modal opens at that
 * point and polls GET /admin/platform-storage-policy/runs/:id every
 * 2 s until status !== 'running' (succeeded / partial / failed /
 * capacity_blocked) or the operator clicks Close.
 *
 * UX shape:
 *   1. Header: tier + elapsed timer + final status icon when done.
 *   2. Synchronous patch summary: per-resource bullet list (volumes,
 *      deployments, CNPG clusters) with green check / red X / spinner.
 *   3. Convergence progress bar: volumes/cnpg/deployments converged
 *      vs total, with the stuckResources list naming what's still
 *      mid-rebuild.
 *   4. Footer with "Close" + "Show details" toggle.
 *
 * The run row is the single source of truth — patchOutcome (synchronous
 * patches) and convergence (post-patch live snapshot) are both stored
 * server-side, so a tab close + reopen on the same run id resumes the
 * live view exactly where it was.
 */

interface PatchResult {
  readonly namespace: string;
  readonly name?: string;
  readonly volumeName?: string;
  readonly previousReplicas?: number;
  readonly newReplicas?: number;
  readonly previousInstances?: number;
  readonly newInstances?: number;
  readonly patched: boolean;
  readonly error: string | null;
}

interface PatchOutcome {
  volumes?: PatchResult[];
  deployments?: PatchResult[];
  cnpgClusters?: PatchResult[];
}

interface Props {
  readonly runId: string;
  readonly onClose: () => void;
}

const POLL_MS = 2_000;

export default function ApplyHaProgressModal({ runId, onClose }: Props) {
  const [run, setRun] = useState<PlatformStorageApplyRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const resp = await apiFetch<{ data: PlatformStorageApplyRun }>(
          `/api/v1/admin/platform-storage-policy/runs/${runId}`,
        );
        if (cancelled) return;
        setRun(resp.data);
        // Stop polling when the run reaches a terminal state.
        if (resp.data.status === 'running') {
          timer = setTimeout(tick, POLL_MS);
        }
      } catch (err) {
        if (cancelled) return;
        setError((err as Error).message);
        timer = setTimeout(tick, POLL_MS * 2); // backoff on error
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [runId]);

  const status = run?.status ?? 'running';
  const conv = run?.convergence;
  const patchOutcome = run?.patchOutcome as PatchOutcome | null;

  const totalConverged = (conv?.volumesConverged ?? 0) + (conv?.cnpgConverged ?? 0) + (conv?.deploymentsConverged ?? 0);
  const totalResources = (conv?.volumesTotal ?? 0) + (conv?.cnpgTotal ?? 0) + (conv?.deploymentsTotal ?? 0);
  const convergencePct = totalResources > 0 ? Math.round((totalConverged / totalResources) * 100) : 0;
  const elapsedSec = conv?.elapsedMs != null ? Math.floor(conv.elapsedMs / 1000) : 0;
  const elapsedLabel = elapsedSec >= 60 ? `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s` : `${elapsedSec}s`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        data-testid="apply-ha-progress-modal"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 px-6 py-4">
          <div className="flex items-center gap-3">
            <StatusIcon status={status} />
            <div>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                Apply {run?.tier === 'ha' ? 'High Availability' : 'Local'} —{' '}
                <StatusLabel status={status} />
              </h2>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                Elapsed: {elapsedLabel}
                {run?.startedAt && ` · started ${new Date(run.startedAt).toLocaleTimeString()}`}
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-6">
          {error && (
            <div className="rounded-lg border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-800 dark:text-red-200">
              Polling failed: {error}
            </div>
          )}

          {/* Synchronous patch summary */}
          <PatchSummary outcome={patchOutcome} />

          {/* Convergence */}
          {conv && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  Cluster convergence
                </h3>
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {totalConverged} of {totalResources} resources at desired state
                </span>
              </div>
              <div className="h-2 w-full bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${convergencePct === 100 ? 'bg-green-500' : 'bg-blue-500'}`}
                  style={{ width: `${convergencePct}%` }}
                />
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-gray-600 dark:text-gray-400">
                <span>Volumes: {conv.volumesConverged}/{conv.volumesTotal}</span>
                <span>CNPG: {conv.cnpgConverged}/{conv.cnpgTotal}</span>
                <span>Deployments: {conv.deploymentsConverged}/{conv.deploymentsTotal}</span>
                {conv.volumesOffSystem > 0 && (
                  <span className="text-amber-600 dark:text-amber-400">
                    {conv.volumesOffSystem} replica{conv.volumesOffSystem === 1 ? '' : 's'} on non-system node
                  </span>
                )}
              </div>

              {conv.stuckResources.length > 0 && (
                <details className="mt-3" open={showDetails || status !== 'running'}>
                  <summary
                    className="cursor-pointer text-xs font-medium text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100"
                    onClick={() => setShowDetails((s) => !s)}
                  >
                    {conv.stuckResources.length} resource{conv.stuckResources.length === 1 ? '' : 's'} still mid-rebuild
                  </summary>
                  <ul className="mt-2 space-y-1 text-xs text-gray-600 dark:text-gray-400 max-h-40 overflow-y-auto">
                    {conv.stuckResources.map((r, i) => (
                      <li key={i} className="flex items-center gap-2">
                        <Loader2 size={10} className="animate-spin text-blue-500" />
                        <span className="font-mono">{r.kind}/{r.name}</span>
                        <span>—</span>
                        <span>{r.observed}/{r.desired}</span>
                        {r.reason && (
                          <span className="text-gray-400 dark:text-gray-500">({r.reason})</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}

          {/* Final-status summary */}
          {status !== 'running' && <FinalStatusBlock status={status} outcome={patchOutcome} />}
        </div>

        {/* Footer */}
        <div className="border-t border-gray-200 dark:border-gray-700 px-6 py-3 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-gray-100 hover:bg-gray-300 dark:hover:bg-gray-600"
          >
            {status === 'running' ? 'Close (orchestration continues)' : 'Close'}
          </button>
        </div>
      </div>
    </div>
  );
}

function StatusIcon({ status }: { status: string }) {
  if (status === 'running') return <Loader2 size={20} className="animate-spin text-blue-500" />;
  if (status === 'succeeded') return <CheckCircle size={20} className="text-green-600" />;
  if (status === 'partial') return <AlertTriangle size={20} className="text-amber-500" />;
  if (status === 'capacity_blocked') return <AlertOctagon size={20} className="text-red-600" />;
  return <AlertCircle size={20} className="text-red-600" />;
}

function StatusLabel({ status }: { status: string }) {
  const map: Record<string, { text: string; cls: string }> = {
    running: { text: 'in progress', cls: 'text-blue-600 dark:text-blue-400' },
    succeeded: { text: 'succeeded', cls: 'text-green-700 dark:text-green-400' },
    partial: { text: 'partial — some resources still rebuilding', cls: 'text-amber-700 dark:text-amber-400' },
    failed: { text: 'failed', cls: 'text-red-700 dark:text-red-400' },
    capacity_blocked: { text: 'capacity blocked', cls: 'text-red-700 dark:text-red-400' },
  };
  const m = map[status] ?? { text: status, cls: 'text-gray-700 dark:text-gray-300' };
  return <span className={m.cls}>{m.text}</span>;
}

function PatchSummary({ outcome }: { outcome: PatchOutcome | null }) {
  if (!outcome) {
    return (
      <div className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-2">
        <Loader2 size={10} className="animate-spin" />
        Waiting for patch outcome…
      </div>
    );
  }
  const sections = [
    { title: 'Longhorn volumes', items: outcome.volumes ?? [], idKey: 'volumeName' as const },
    { title: 'Stateless Deployments', items: outcome.deployments ?? [], idKey: 'name' as const },
    { title: 'CNPG clusters', items: outcome.cnpgClusters ?? [], idKey: 'name' as const },
  ];
  return (
    <div className="space-y-3">
      {sections.map(({ title, items, idKey }) => {
        if (items.length === 0) return null;
        const ok = items.filter((i) => i.patched).length;
        const errored = items.filter((i) => i.error).length;
        const noop = items.length - ok - errored;
        return (
          <div key={title}>
            <div className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-1.5">
              {title}{' '}
              <span className="text-xs font-normal text-gray-500 dark:text-gray-400">
                — {ok} patched, {noop} no-op, {errored} failed
              </span>
            </div>
            <ul className="space-y-1 text-xs">
              {items.map((it, i) => {
                const id = (it as unknown as Record<string, string>)[idKey] ?? `#${i}`;
                const ns = it.namespace;
                return (
                  <li key={i} className="flex items-center gap-2">
                    {it.error ? (
                      <AlertCircle size={12} className="text-red-500" />
                    ) : it.patched ? (
                      <CheckCircle size={12} className="text-green-600" />
                    ) : (
                      <span className="size-3 rounded-full bg-gray-300 dark:bg-gray-600" />
                    )}
                    <span className="font-mono text-gray-700 dark:text-gray-300">
                      {ns}/{id}
                    </span>
                    {it.error && (
                      <span className="text-red-700 dark:text-red-400 truncate">— {it.error}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function FinalStatusBlock({ status, outcome }: { status: string; outcome: PatchOutcome | null }) {
  if (status === 'succeeded') {
    return (
      <div className="rounded-lg border border-green-300 dark:border-green-700 bg-green-50 dark:bg-green-900/20 p-3 text-sm text-green-900 dark:text-green-200">
        All resources reached desired state. Cluster fully converged.
      </div>
    );
  }
  if (status === 'partial') {
    return (
      <div className="rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-3 text-sm text-amber-900 dark:text-amber-200">
        Apply succeeded but the cluster did not fully converge within 10 min. Longhorn replica
        rebuilds + CNPG joins continue in the background. Reload the storage page in a few minutes
        to confirm. Bell-icon notifications fire if anything is still stuck after that.
      </div>
    );
  }
  if (status === 'capacity_blocked') {
    const blocked = outcome?.cnpgClusters?.find((c) => c.error?.startsWith('INSUFFICIENT_STORAGE'));
    return (
      <div className="rounded-lg border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-900 dark:text-red-200">
        <div className="font-semibold mb-1">Insufficient storage capacity.</div>
        {blocked?.error && <div className="font-mono text-xs">{blocked.error}</div>}
        <div className="mt-2 text-xs">
          Free space (delete unused tenants / orphan PVs / snapshots) OR add a server node, then
          retry Apply HA.
        </div>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-900 dark:text-red-200">
      Apply failed. See the per-resource error messages above; the bell-icon notification has the
      same detail. Common causes: RBAC, Longhorn unreachable, CNPG webhook rejected.
    </div>
  );
}
