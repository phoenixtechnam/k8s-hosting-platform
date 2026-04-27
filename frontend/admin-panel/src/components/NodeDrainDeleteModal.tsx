import { useState } from 'react';
import { X, AlertTriangle, Loader2, AlertCircle, CheckCircle, Trash2, ShieldAlert } from 'lucide-react';
import { useDrainImpact, useDrainNode, useDeleteNode } from '@/hooks/use-cluster-nodes';
import type { ClusterNodeResponse } from '@k8s-hosting/api-contracts';

interface NodeDrainDeleteModalProps {
  readonly node: ClusterNodeResponse;
  readonly onClose: () => void;
}

/**
 * Two-stage destructive flow for a node:
 *   1. DRAIN  — cordon + evict every non-system pod. Refused when this
 *               node holds the last running Longhorn replica for any
 *               volume (operator can override with `force last replica`).
 *   2. DELETE — only enabled after the node is drained. Removes the
 *               node from Kubernetes and from the platform inventory
 *               row. The host (k3s-agent process) is NOT touched.
 *
 * The modal queries /admin/nodes/:name/drain-impact when opened so the
 * operator sees the exact list of pods, clients, and volumes that will
 * be affected before clicking through.
 */
export default function NodeDrainDeleteModal({ node, onClose }: NodeDrainDeleteModalProps) {
  const [forceLastReplica, setForceLastReplica] = useState(false);
  const impactQuery = useDrainImpact(node.name, true);
  const drain = useDrainNode(node.name);
  const del = useDeleteNode(node.name);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const impact = impactQuery.data?.data;
  const drained = impact !== undefined
    && impact.alreadyCordoned
    && impact.nonSystemPods.length === 0;
  const lastReplicaVolumes = impact?.longhornReplicas.filter((r) => r.isLastReplica) ?? [];

  const handleDrain = async (): Promise<void> => {
    try {
      await drain.mutateAsync({ forceLastReplica });
      // Refetch impact so the modal flips to "drained → ready to delete".
      await impactQuery.refetch();
    } catch {
      // surfaced via drain.error below
    }
  };

  const handleDelete = async (): Promise<void> => {
    try {
      await del.mutateAsync();
      onClose();
    } catch {
      // surfaced via del.error below
    }
  };

  const drainErr = drain.error as { message?: string } | null;
  const delErr = del.error as { message?: string } | null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 py-8"
      role="dialog"
      aria-modal="true"
      aria-labelledby="node-drain-modal-title"
      data-testid={`drain-node-${node.name}-modal`}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-3xl rounded-xl bg-white shadow-xl dark:bg-gray-800 max-h-[calc(100vh-4rem)] overflow-y-auto"
      >
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3 dark:border-gray-700">
          <h2 id="node-drain-modal-title" className="text-base font-semibold text-gray-900 dark:text-gray-100">
            Drain &amp; remove node — <span className="font-mono">{node.name}</span>
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4 text-sm">
          {impactQuery.isLoading && (
            <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
              <Loader2 size={14} className="animate-spin" /> Computing impact…
            </div>
          )}

          {impactQuery.error && (
            <p className="flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
              <AlertCircle size={12} /> {(impactQuery.error as Error).message}
            </p>
          )}

          {impact && (
            <>
              <ImpactSection
                title="Cordon state"
                tone={impact.alreadyCordoned ? 'good' : 'warn'}
                content={impact.alreadyCordoned
                  ? 'Already cordoned (unschedulable=true). Drain will evict remaining pods.'
                  : 'Not cordoned yet. Drain will cordon the node first, then evict pods.'}
              />

              <ImpactSection
                title={`Non-system pods (${impact.nonSystemPods.length})`}
                tone={impact.nonSystemPods.length === 0 ? 'good' : 'warn'}
                content={
                  impact.nonSystemPods.length === 0
                    ? 'No tenant or non-system workload remaining on this node — safe to delete.'
                    : 'These will be evicted. Pods owned by Deployments/StatefulSets reschedule elsewhere; pinned ones may go Pending.'
                }
              >
                {impact.nonSystemPods.length > 0 && (
                  <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto text-xs">
                    {impact.nonSystemPods.map((p) => (
                      <li key={`${p.namespace}/${p.name}`} className="font-mono text-gray-700 dark:text-gray-300">
                        {p.namespace}/{p.name}
                        {p.clientId && <span className="ml-2 rounded bg-indigo-100 px-1 py-0.5 text-[10px] text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300">client:{p.clientId.slice(0, 8)}</span>}
                        {p.pinnedToThisNode && <span className="ml-2 rounded bg-amber-100 px-1 py-0.5 text-[10px] text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">pinned</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </ImpactSection>

              <ImpactSection
                title={`Longhorn replicas on this node (${impact.longhornReplicas.length})`}
                tone={lastReplicaVolumes.length > 0 ? 'danger' : impact.longhornReplicas.length > 0 ? 'warn' : 'good'}
                content={
                  lastReplicaVolumes.length > 0
                    ? `${lastReplicaVolumes.length} volume(s) have only this node holding a healthy replica. Drain will be REFUSED unless you tick "force last replica".`
                    : impact.longhornReplicas.length === 0
                      ? 'No Longhorn replicas pinned here.'
                      : 'Other nodes carry healthy copies — Longhorn will rebuild during the drain.'
                }
              >
                {impact.longhornReplicas.length > 0 && (
                  <ul className="mt-2 max-h-32 space-y-1 overflow-y-auto text-xs">
                    {impact.longhornReplicas.map((r) => (
                      <li key={r.replicaName} className="font-mono text-gray-700 dark:text-gray-300">
                        {r.volumeName}
                        {r.isLastReplica && <span className="ml-2 rounded bg-red-100 px-1 py-0.5 text-[10px] text-red-800 dark:bg-red-900/40 dark:text-red-300">LAST</span>}
                      </li>
                    ))}
                  </ul>
                )}
                {lastReplicaVolumes.length > 0 && (
                  <label className="mt-2 flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={forceLastReplica}
                      onChange={(e) => setForceLastReplica(e.target.checked)}
                      data-testid="force-last-replica-checkbox"
                    />
                    <span>I accept data risk — force drain even with last replicas here.</span>
                  </label>
                )}
              </ImpactSection>

              <details className="rounded-lg border border-gray-200 dark:border-gray-700">
                <summary className="cursor-pointer px-3 py-2 text-xs text-gray-600 dark:text-gray-400">
                  System pods that will NOT be evicted ({impact.systemPods.length})
                </summary>
                <ul className="space-y-1 px-3 py-2 text-xs">
                  {impact.systemPods.map((p) => (
                    <li key={`${p.namespace}/${p.name}`} className="font-mono text-gray-700 dark:text-gray-300">
                      {p.namespace}/{p.name} <span className="text-gray-400">— {p.reason}</span>
                    </li>
                  ))}
                </ul>
              </details>
            </>
          )}

          {drainErr && (
            <p className="flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
              <AlertCircle size={12} /> {drainErr.message}
            </p>
          )}
          {drain.isSuccess && drain.data?.data.failed.length === 0 && !drained && (
            <p className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
              <CheckCircle size={12} /> Drain complete — refreshing state…
            </p>
          )}
          {drain.isSuccess && (drain.data?.data.failed.length ?? 0) > 0 && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200">
              <div className="flex items-center gap-1 font-semibold">
                <AlertTriangle size={12} /> {drain.data?.data.failed.length} pod(s) failed to evict (likely PDB).
              </div>
              <ul className="mt-1 space-y-0.5 font-mono">
                {drain.data?.data.failed.map((f) => (
                  <li key={`${f.namespace}/${f.name}`}>{f.namespace}/{f.name}: {f.error}</li>
                ))}
              </ul>
            </div>
          )}
          {delErr && (
            <p className="flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
              <AlertCircle size={12} /> {delErr.message}
            </p>
          )}

          {drained && !confirmDelete && (
            <div className="rounded-lg border border-green-300 bg-green-50 p-3 text-xs text-green-800 dark:border-green-700 dark:bg-green-900/30 dark:text-green-200">
              <div className="flex items-center gap-1 font-semibold">
                <CheckCircle size={12} /> Node is fully drained. You may now delete it from the cluster.
              </div>
            </div>
          )}

          {drained && confirmDelete && (
            <div className="flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 p-3 text-xs text-red-800 dark:border-red-700 dark:bg-red-900/30 dark:text-red-200">
              <ShieldAlert size={14} className="mt-0.5 shrink-0" />
              <div>
                Delete will run <span className="font-mono">kubectl delete node {node.name}</span> and remove the row from the inventory.
                The host itself stays running. Click <strong>Confirm Delete</strong> below.
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-gray-200 px-5 py-3 dark:border-gray-700">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            Close
          </button>
          <div className="flex items-center gap-2">
            {!drained && (
              <button
                type="button"
                onClick={handleDrain}
                disabled={drain.isPending || !impact || (lastReplicaVolumes.length > 0 && !forceLastReplica)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
                data-testid={`drain-node-${node.name}-button`}
              >
                {drain.isPending ? <Loader2 size={14} className="animate-spin" /> : <AlertTriangle size={14} />}
                Drain Node
              </button>
            )}
            {drained && !confirmDelete && (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700"
                data-testid={`delete-node-${node.name}-button`}
              >
                <Trash2 size={14} /> Delete Node
              </button>
            )}
            {drained && confirmDelete && (
              <button
                type="button"
                onClick={handleDelete}
                disabled={del.isPending}
                className="inline-flex items-center gap-1.5 rounded-lg bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800 disabled:opacity-50"
                data-testid={`confirm-delete-node-${node.name}-button`}
              >
                {del.isPending ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                Confirm Delete
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

interface ImpactSectionProps {
  readonly title: string;
  readonly tone: 'good' | 'warn' | 'danger';
  readonly content: string;
  readonly children?: React.ReactNode;
}

function ImpactSection({ title, tone, content, children }: ImpactSectionProps) {
  const toneClass =
    tone === 'good' ? 'border-green-300 bg-green-50 dark:border-green-700 dark:bg-green-900/20' :
    tone === 'warn' ? 'border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-900/20' :
                      'border-red-300 bg-red-50 dark:border-red-700 dark:bg-red-900/20';
  return (
    <div className={`rounded-lg border p-3 ${toneClass}`}>
      <h3 className="mb-1 text-xs font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
      <p className="text-xs text-gray-700 dark:text-gray-300">{content}</p>
      {children}
    </div>
  );
}
