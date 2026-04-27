import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  X, AlertTriangle, Loader2, AlertCircle, CheckCircle, Trash2, ShieldAlert,
  ExternalLink, Database as DatabaseIcon,
} from 'lucide-react';
import {
  useDrainImpact,
  useDrainNode,
  useDeleteNode,
  useClusterNodes,
} from '@/hooks/use-cluster-nodes';
import type { ClusterNodeResponse, DrainImpact } from '@k8s-hosting/api-contracts';

interface NodeDrainDeleteModalProps {
  readonly node: ClusterNodeResponse;
  readonly onClose: () => void;
}

/**
 * Two-stage destructive flow for a node:
 *   1. DRAIN  — cordon + evict every non-system pod. Per-row dropdowns
 *               let the operator re-pin tenant workloads + PVCs to a
 *               specific node (or "Auto" / "Stay") before eviction.
 *   2. DELETE — only enabled after the node is fully drained.
 *
 * Design goals:
 *  - Show every affected resource grouped by kind: pinned workloads,
 *    non-system pods (live), tenant PVCs, last-replica platform volumes,
 *    system pods (info only, never evicted).
 *  - Each tenant resource carries its client name with a link to the
 *    client detail page.
 *  - The re-pin dropdowns are populated from the live Cluster Nodes
 *    list, excluding the node being drained, restricted to those that
 *    accept client workloads.
 */
export default function NodeDrainDeleteModal({ node, onClose }: NodeDrainDeleteModalProps) {
  const [forceLastReplica, setForceLastReplica] = useState(false);
  const impactQuery = useDrainImpact(node.name, true);
  const nodesQuery = useClusterNodes();
  const drain = useDrainNode(node.name);
  const del = useDeleteNode(node.name);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // workloadPlacement keyed by "<ns>/<kind>/<name>", value is "" (auto),
  // "<targetNode>", or "stay". Defaults to "stay" so the operator must
  // explicitly opt into a re-pin.
  const [workloadPlacement, setWorkloadPlacement] = useState<Record<string, string>>({});
  const [pvcPlacement, setPvcPlacement] = useState<Record<string, string>>({});

  const impact: DrainImpact | undefined = impactQuery.data?.data;
  const drained = impact !== undefined
    && impact.alreadyCordoned
    && impact.nonSystemPods.length === 0;
  const lastReplicaVolumes = impact?.longhornReplicas.filter((r) => r.isLastReplica) ?? [];

  const targetNodeOptions = useMemo(() => {
    const list = nodesQuery.data?.data ?? [];
    return list
      .filter((n) => n.name !== node.name && n.canHostClientWorkloads)
      .map((n) => n.name);
  }, [nodesQuery.data, node.name]);

  // Block the drain button when any pinned workload is still set to
  // "stay" — the operator must explicitly choose Auto / specific node
  // for each. Otherwise the workload's nodeSelector still points at
  // the cordoned node and its replacement pods sit Pending forever.
  const stayPinnedWorkloads = (impact?.pinnedWorkloads ?? []).filter(
    (w) => (workloadPlacement[`${w.namespace}/${w.kind}/${w.name}`] ?? 'stay') === 'stay',
  );
  const anyStayPinned = stayPinnedWorkloads.length > 0;

  const handleDrain = async (): Promise<void> => {
    try {
      await drain.mutateAsync({
        forceLastReplica,
        workloadPlacement,
        pvcPlacement,
      });
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
    } catch { /* surfaced below */ }
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
        className="w-full max-w-4xl rounded-xl bg-white shadow-xl dark:bg-gray-800 max-h-[calc(100vh-4rem)] overflow-y-auto"
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

              {/* ─── Pinned workloads — re-pin dropdowns ─── */}
              {impact.pinnedWorkloads.length > 0 && (
                <ImpactSection
                  title={`Pinned workloads (${impact.pinnedWorkloads.length})`}
                  tone="warn"
                  content="These Deployments / StatefulSets have nodeSelector/nodeAffinity locking them to this node. Pick a target node OR Auto (clear pin) below — drain will patch the workload and let the scheduler place it."
                >
                  <table className="mt-3 w-full text-xs">
                    <thead className="text-gray-500 dark:text-gray-400">
                      <tr>
                        <th className="text-left py-1 pr-2">Client</th>
                        <th className="text-left py-1 pr-2">Workload</th>
                        <th className="text-left py-1 pr-2">Pin via</th>
                        <th className="text-right py-1 pr-2">Replicas</th>
                        <th className="text-left py-1">Re-pin to</th>
                      </tr>
                    </thead>
                    <tbody>
                      {impact.pinnedWorkloads.map((w) => {
                        const key = `${w.namespace}/${w.kind}/${w.name}`;
                        const value = workloadPlacement[key] ?? 'stay';
                        return (
                          <tr key={key} className="border-t border-amber-200/60 dark:border-amber-700/40">
                            <td className="py-1.5 pr-2">
                              {w.clientId ? (
                                <Link
                                  to={`/clients/${w.clientId}`}
                                  className="inline-flex items-center gap-1 text-brand-600 hover:underline dark:text-brand-400"
                                  data-testid={`pinned-workload-client-link-${key}`}
                                >
                                  {w.clientName ?? w.clientId.slice(0, 8)}
                                  <ExternalLink size={10} />
                                </Link>
                              ) : (
                                <span className="text-gray-400 italic">{w.namespace}</span>
                              )}
                            </td>
                            <td className="py-1.5 pr-2 font-mono">{w.kind}/{w.name}</td>
                            <td className="py-1.5 pr-2 text-gray-500">{w.pinKind}</td>
                            <td className="py-1.5 pr-2 text-right tabular-nums">{w.replicas}</td>
                            <td className="py-1.5">
                              <select
                                className="rounded border border-amber-300 bg-white px-2 py-0.5 text-xs dark:bg-gray-800 dark:border-amber-700"
                                value={value}
                                onChange={(e) => setWorkloadPlacement((prev) => ({ ...prev, [key]: e.target.value }))}
                                data-testid={`workload-placement-${key}`}
                              >
                                <option value="stay">Stay (refuse to move)</option>
                                <option value="">Auto (clear pin, scheduler decides)</option>
                                {targetNodeOptions.map((n) => (
                                  <option key={n} value={n}>{n}</option>
                                ))}
                              </select>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </ImpactSection>
              )}

              {/* ─── Non-system pods (live) ─── */}
              <ImpactSection
                title={`Non-system pods (${impact.nonSystemPods.length})`}
                tone={impact.nonSystemPods.length === 0 ? 'good' : 'warn'}
                content={
                  impact.nonSystemPods.length === 0
                    ? 'No tenant or non-system workload remaining on this node — safe to delete.'
                    : 'These pods will be evicted. Pods owned by Deployments/StatefulSets will be recreated by their controllers.'
                }
              >
                {impact.nonSystemPods.length > 0 && (
                  <table className="mt-2 w-full text-xs">
                    <thead className="text-gray-500 dark:text-gray-400">
                      <tr>
                        <th className="text-left py-1 pr-2">Client</th>
                        <th className="text-left py-1 pr-2">Pod</th>
                        <th className="text-left py-1 pr-2">Owner</th>
                        <th className="text-left py-1">Flags</th>
                      </tr>
                    </thead>
                    <tbody>
                      {impact.nonSystemPods.map((p) => (
                        <tr key={`${p.namespace}/${p.name}`} className="border-t border-gray-200/60 dark:border-gray-700/40">
                          <td className="py-1.5 pr-2">
                            {p.clientId ? (
                              <Link
                                to={`/clients/${p.clientId}`}
                                className="inline-flex items-center gap-1 text-brand-600 hover:underline dark:text-brand-400"
                              >
                                {p.clientName ?? p.clientId.slice(0, 8)}
                                <ExternalLink size={10} />
                              </Link>
                            ) : (
                              <span className="text-gray-400 italic">{p.namespace}</span>
                            )}
                          </td>
                          <td className="py-1.5 pr-2 font-mono">{p.name}</td>
                          <td className="py-1.5 pr-2 text-gray-500">
                            {p.workloadKind && p.workloadName ? `${p.workloadKind}/${p.workloadName}` : '—'}
                          </td>
                          <td className="py-1.5">
                            {p.pinnedToThisNode && (
                              <span className="rounded bg-amber-100 px-1 py-0.5 text-[10px] text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">pinned</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </ImpactSection>

              {/* ─── Tenant PVCs ─── */}
              {impact.tenantPvcs.length > 0 && (
                <ImpactSection
                  title={`Tenant PVCs with replicas here (${impact.tenantPvcs.length})`}
                  tone={impact.tenantPvcs.some((p) => p.isLastReplica) ? 'danger' : 'warn'}
                  content="Pick a target node to migrate the replica, or Auto to let Longhorn pick. Volumes with replicas elsewhere will rebuild without operator action."
                >
                  <table className="mt-2 w-full text-xs">
                    <thead className="text-gray-500 dark:text-gray-400">
                      <tr>
                        <th className="text-left py-1 pr-2">Client</th>
                        <th className="text-left py-1 pr-2">Volume</th>
                        <th className="text-right py-1 pr-2">Size</th>
                        <th className="text-right py-1 pr-2">Replicas</th>
                        <th className="text-left py-1">Re-pin to</th>
                      </tr>
                    </thead>
                    <tbody>
                      {impact.tenantPvcs.map((p) => {
                        const sizeGiB = (p.sizeBytes / (1024 ** 3)).toFixed(0);
                        const value = pvcPlacement[p.volumeName] ?? 'stay';
                        return (
                          <tr key={p.volumeName} className="border-t border-gray-200/60 dark:border-gray-700/40">
                            <td className="py-1.5 pr-2">
                              {p.clientId ? (
                                <Link
                                  to={`/clients/${p.clientId}`}
                                  className="inline-flex items-center gap-1 text-brand-600 hover:underline dark:text-brand-400"
                                >
                                  {p.clientName ?? p.clientId.slice(0, 8)}
                                  <ExternalLink size={10} />
                                </Link>
                              ) : (
                                <span className="text-gray-400 italic">{p.namespace}</span>
                              )}
                            </td>
                            <td className="py-1.5 pr-2 font-mono flex items-center gap-1">
                              <DatabaseIcon size={10} className="text-gray-400" />
                              {p.pvcName || p.volumeName}
                            </td>
                            <td className="py-1.5 pr-2 text-right tabular-nums">{sizeGiB} GiB</td>
                            <td className="py-1.5 pr-2 text-right tabular-nums">
                              {p.replicaCount}
                              {p.isLastReplica && (
                                <span className="ml-1 rounded bg-red-100 px-1 py-0.5 text-[10px] text-red-800 dark:bg-red-900/40 dark:text-red-300">LAST</span>
                              )}
                            </td>
                            <td className="py-1.5">
                              <select
                                className="rounded border border-amber-300 bg-white px-2 py-0.5 text-xs dark:bg-gray-800 dark:border-amber-700"
                                value={value}
                                onChange={(e) => setPvcPlacement((prev) => ({ ...prev, [p.volumeName]: e.target.value }))}
                                data-testid={`pvc-placement-${p.volumeName}`}
                              >
                                <option value="stay">Stay</option>
                                <option value="">Auto (Longhorn picks)</option>
                                {targetNodeOptions.map((n) => (
                                  <option key={n} value={n}>{n}</option>
                                ))}
                              </select>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </ImpactSection>
              )}

              {/* ─── Platform last-replica risk ─── */}
              {lastReplicaVolumes.length > 0 && (
                <ImpactSection
                  title={`Platform last-replica risk (${lastReplicaVolumes.length})`}
                  tone="danger"
                  content={`${lastReplicaVolumes.length} platform volume(s) have only this node holding a healthy replica. Drain will be REFUSED unless you tick "force last replica".`}
                >
                  <ul className="mt-2 max-h-32 space-y-1 overflow-y-auto text-xs">
                    {lastReplicaVolumes.map((r) => (
                      <li key={r.replicaName} className="font-mono text-gray-700 dark:text-gray-300">
                        {r.volumeName}
                      </li>
                    ))}
                  </ul>
                  <label className="mt-2 flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={forceLastReplica}
                      onChange={(e) => setForceLastReplica(e.target.checked)}
                      data-testid="force-last-replica-checkbox"
                    />
                    <span>I accept data risk — force drain even with last replicas here.</span>
                  </label>
                </ImpactSection>
              )}

              {/* ─── System pods (info only) ─── */}
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
          {drain.isSuccess && (
            <p className="text-xs text-gray-600 dark:text-gray-400">
              Re-pinned: {drain.data?.data.rePinnedWorkloads ?? 0} workload(s), {drain.data?.data.rePinnedPvcs ?? 0} PVC(s).
            </p>
          )}
          {delErr && (
            <p className="flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
              <AlertCircle size={12} /> {delErr.message}
            </p>
          )}

          {!drained && anyStayPinned && (
            <div className="rounded-lg border border-amber-400 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-600 dark:bg-amber-900/40 dark:text-amber-100" data-testid="drain-blocked-stay-pinned">
              <div className="flex items-center gap-1 font-semibold">
                <AlertTriangle size={12} /> Drain blocked — {stayPinnedWorkloads.length} pinned workload(s) still set to &quot;Stay&quot;.
              </div>
              <p className="mt-1">Pick &quot;Auto&quot; or a specific target node for each pinned workload. Leaving them on &quot;Stay&quot; would evict the pod but its nodeSelector would still point at this cordoned node — replacement pods sit Pending forever.</p>
            </div>
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
                disabled={
                  drain.isPending
                  || !impact
                  || (lastReplicaVolumes.length > 0 && !forceLastReplica)
                  || anyStayPinned
                }
                title={anyStayPinned
                  ? `${stayPinnedWorkloads.length} pinned workload(s) still set to "Stay" — pick Auto or a target node first`
                  : undefined}
                className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
                data-testid={`drain-node-${node.name}-button`}
              >
                {drain.isPending ? <Loader2 size={14} className="animate-spin" /> : <AlertTriangle size={14} />}
                Apply re-pin &amp; drain
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
