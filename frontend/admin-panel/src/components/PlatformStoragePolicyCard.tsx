import { useState } from 'react';
import { Database, AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react';
import {
  usePlatformStoragePolicy,
  useUpdatePlatformStoragePolicy,
} from '@/hooks/use-platform-storage-policy';

/**
 * Platform-storage replication policy card. Lives on StorageSettings.
 *
 * Shows the current tier (local/ha), the recommended tier based on
 * Ready server count, and the live per-volume replica state of the
 * platform's StatefulSets (postgres, stalwart-mail). Operator clicks
 * Apply HA / Apply Local to flip the policy — backend patches each
 * Longhorn Volume's .spec.numberOfReplicas; replicas converge async.
 */
export default function PlatformStoragePolicyCard() {
  const { data, isLoading, error, refetch } = usePlatformStoragePolicy();
  const update = useUpdatePlatformStoragePolicy();
  const [confirming, setConfirming] = useState<'local' | 'ha' | null>(null);

  if (isLoading) {
    return (
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm">
        <div className="text-gray-500 dark:text-gray-400">Loading platform storage policy…</div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="rounded-xl border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 p-5">
        <div className="text-red-700 dark:text-red-300">
          Failed to load platform storage policy.{' '}
          <button onClick={() => refetch()} className="underline">retry</button>
        </div>
      </div>
    );
  }

  const policy = data.data.policy;
  const cluster = data.data.clusterState;
  const isHA = policy.systemTier === 'ha';
  const recommendsHA = cluster.recommendedTier === 'ha';
  const showRecommendBanner = !policy.pinnedByAdmin && recommendsHA && policy.systemTier === 'local';
  const replicasOutOfSync = cluster.volumes.some((v) => v.currentReplicas !== v.desiredReplicas);

  const onApply = (tier: 'local' | 'ha') => {
    setConfirming(tier);
  };

  const onConfirm = async () => {
    if (!confirming) return;
    try {
      await update.mutateAsync({ systemTier: confirming, pinnedByAdmin: true });
    } finally {
      setConfirming(null);
    }
  };

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm space-y-4">
      <div className="flex items-center gap-3">
        <Database size={20} className="text-gray-700 dark:text-gray-300" />
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          Platform Storage Replication
        </h2>
      </div>

      <p className="text-sm text-gray-600 dark:text-gray-400">
        Controls Longhorn replica count for the platform's own Postgres and Stalwart-mail volumes.
        Distinct from per-tenant storage tier (set on each client).
      </p>

      {showRecommendBanner && (
        <div className="rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-4 flex gap-3">
          <AlertTriangle size={20} className="text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <div className="text-sm text-amber-900 dark:text-amber-200">
            <strong>Cluster reached HA size.</strong> {cluster.readyServerCount} of {cluster.totalNodeCount} nodes
            are Ready servers. Switch to <code>ha</code> to replicate platform volumes 3× and survive a single
            node outage. Reversible — switch back to <code>local</code> anytime.
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Stat label="Current tier" value={policy.systemTier} highlight={isHA ? 'green' : 'gray'} />
        <Stat label="Recommended" value={cluster.recommendedTier} highlight={recommendsHA ? 'green' : 'gray'} />
        <Stat label="Ready servers" value={`${cluster.readyServerCount} / ${cluster.totalNodeCount} nodes`} />
      </div>

      <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 dark:bg-gray-900/50 text-gray-600 dark:text-gray-400">
            <tr>
              <th className="px-3 py-2 text-left">Volume</th>
              <th className="px-3 py-2 text-left">PVC</th>
              <th className="px-3 py-2 text-right">Current</th>
              <th className="px-3 py-2 text-right">Desired</th>
              <th className="px-3 py-2 text-left">Replicas on</th>
              <th className="px-3 py-2 text-left">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {cluster.volumes.map((v) => {
              const inSync = v.currentReplicas === v.desiredReplicas;
              const drift = v.hasOffSystemReplica;
              return (
                <tr key={v.volumeName} className={drift ? 'bg-amber-50 dark:bg-amber-900/10' : ''}>
                  <td className="px-3 py-2 font-mono text-xs text-gray-900 dark:text-gray-100">{v.volumeName}</td>
                  <td className="px-3 py-2 text-gray-700 dark:text-gray-300">{v.namespace}/{v.pvcName}</td>
                  <td className="px-3 py-2 text-right text-gray-900 dark:text-gray-100">{v.currentReplicas}</td>
                  <td className="px-3 py-2 text-right text-gray-900 dark:text-gray-100">{v.desiredReplicas}</td>
                  <td className="px-3 py-2 text-xs text-gray-700 dark:text-gray-300" data-testid={`replica-nodes-${v.volumeName}`}>
                    {v.replicaNodes.length === 0 ? (
                      <span className="text-gray-400">—</span>
                    ) : (
                      <span className="font-mono">{v.replicaNodes.join(', ')}</span>
                    )}
                    {drift && (
                      <span className="ml-2 inline-flex items-center gap-0.5 rounded bg-amber-100 px-1 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300" title="At least one replica is on a non-system server. Trigger Apply HA / Apply Local to migrate.">
                        <AlertTriangle size={10} /> off-system
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {inSync && v.healthy ? (
                      <span className="inline-flex items-center gap-1 text-green-700 dark:text-green-400">
                        <CheckCircle2 size={14} /> in-sync
                      </span>
                    ) : !inSync ? (
                      <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
                        <RefreshCw size={14} /> reconciling
                      </span>
                    ) : (
                      <span className="text-gray-600 dark:text-gray-400">{v.phase ?? 'unknown'}</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {cluster.volumes.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-4 text-center text-gray-500 dark:text-gray-400">
                  No platform Longhorn volumes detected yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <button
          onClick={() => onApply('ha')}
          disabled={isHA || update.isPending}
          className="px-4 py-2 rounded-lg bg-green-600 text-white text-sm font-medium hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Apply HA (3 replicas)
        </button>
        <button
          onClick={() => onApply('local')}
          disabled={!isHA || update.isPending}
          className="px-4 py-2 rounded-lg bg-gray-600 text-white text-sm font-medium hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Revert to Local (1 replica)
        </button>
        {replicasOutOfSync && !update.isPending && (
          <span className="text-xs text-amber-700 dark:text-amber-400 ml-2">
            Replicas reconciling — Longhorn rebuilds in the background.
          </span>
        )}
        {policy.lastAppliedAt && (
          <span className="text-xs text-gray-500 dark:text-gray-400 ml-auto">
            Last applied: {new Date(policy.lastAppliedAt).toLocaleString()}
          </span>
        )}
      </div>

      {update.isError && (
        <div className="text-sm text-red-700 dark:text-red-400">
          Failed to apply — check the cluster events page for details. (Common causes: no admin
          permission, Longhorn unreachable, or a volume currently detaching.)
        </div>
      )}

      {confirming && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setConfirming(null)}>
          <div className="bg-white dark:bg-gray-800 rounded-xl p-6 max-w-lg shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-3">
              Confirm: switch platform storage to <code>{confirming}</code>?
            </h3>
            <ul className="text-sm text-gray-700 dark:text-gray-300 space-y-1 mb-4 list-disc pl-5">
              <li><strong>Longhorn volumes:</strong> {confirming === 'ha' ? '1 → 3 replicas (Longhorn rebuilds in background)' : '3 → 1 replica (extra copies deleted permanently)'}</li>
              <li><strong>Postgres (CNPG):</strong> {confirming === 'ha' ? '1 → 3 instances (streaming replication, primary stays primary)' : '3 → 1 instance (replicas removed; primary keeps data)'}</li>
              <li><strong>Stateless deployments:</strong> {confirming === 'ha' ? '2 → 3 replicas (admin-panel, client-panel, platform-api, oauth2-proxy, dex) + topology spread to one pod per server' : '3 → 2 replicas (topology spread retained, harmless at 2)'}</li>
              <li>No data migration. No downtime.</li>
              <li>{confirming === 'ha' ? 'Disk + CPU usage roughly triples for the affected components.' : 'Cluster reverts to "single-node failure = platform outage" risk profile.'}</li>
            </ul>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirming(null)} className="px-3 py-2 rounded-lg text-sm bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-gray-100">Cancel</button>
              <button onClick={onConfirm} className={`px-3 py-2 rounded-lg text-sm text-white ${confirming === 'ha' ? 'bg-green-600 hover:bg-green-700' : 'bg-amber-600 hover:bg-amber-700'}`}>
                Apply {confirming}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: 'green' | 'gray' }) {
  const color = highlight === 'green'
    ? 'text-green-700 dark:text-green-400'
    : 'text-gray-900 dark:text-gray-100';
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-3">
      <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">{label}</div>
      <div className={`mt-1 text-lg font-semibold ${color} font-mono`}>{value}</div>
    </div>
  );
}
