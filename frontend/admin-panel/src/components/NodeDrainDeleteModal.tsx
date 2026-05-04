import { Fragment, useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  X, AlertTriangle, Loader2, AlertCircle, CheckCircle, Trash2, ShieldAlert,
  ExternalLink, Database as DatabaseIcon, ChevronRight, ChevronDown,
} from 'lucide-react';
import {
  useDrainImpact,
  useDrainNode,
  useDeleteNode,
  useClusterNodes,
} from '@/hooks/use-cluster-nodes';
import type { ClusterNodeResponse, DrainImpact } from '@k8s-hosting/api-contracts';
import ErrorPanel from '@/components/ErrorPanel';
import { extractOperatorError } from '@/lib/extract-operator-error';

interface NodeDrainDeleteModalProps {
  readonly node: ClusterNodeResponse;
  readonly onClose: () => void;
}

/**
 * Two-stage destructive flow for a node:
 *   1. DRAIN  — cordon + evict every non-system pod. Operators re-pin
 *               affected CLIENTS (not individual workloads or PVCs);
 *               pinning is a client-level property and the orchestrator
 *               propagates the chosen target across every Deployment,
 *               StatefulSet, FM sidecar, and Longhorn volume in the
 *               client's namespace.
 *   2. DELETE — only enabled after the node is fully drained.
 *
 * Design goals:
 *  - One re-pin target per client (matches the client-detail page,
 *    where pinning is also expressed at the client level).
 *  - Each row expandable to show the workloads + PVCs that will be
 *    moved together — informational, not editable.
 *  - The "Last-replica risk" banner is reserved for PLATFORM volumes
 *    (postgres, longhorn-system, mail) since tenant volumes are
 *    already represented inside their client row.
 */
export default function NodeDrainDeleteModal({ node, onClose }: NodeDrainDeleteModalProps) {
  const [forceLastReplica, setForceLastReplica] = useState(false);
  const impactQuery = useDrainImpact(node.name, true);
  const nodesQuery = useClusterNodes();
  const drain = useDrainNode(node.name);
  const del = useDeleteNode(node.name);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // clientPlacement keyed by clientId. Values: "" (auto, default),
  // "<targetNode>" (re-pin), or "stay" (refuse to move).
  const [clientPlacement, setClientPlacement] = useState<Record<string, string>>({});
  // Per-client expand state for the workloads/PVCs detail.
  const [expandedClients, setExpandedClients] = useState<Record<string, boolean>>({});

  const impact: DrainImpact | undefined = impactQuery.data?.data;
  const drained = impact !== undefined
    && impact.alreadyCordoned
    && impact.nonSystemPods.length === 0;
  // Reserve the "Last-replica risk" banner for PLATFORM volumes —
  // tenant volumes are already represented in their client row above
  // (where the re-pin dropdown lives).
  const lastReplicaVolumes = impact?.longhornReplicas.filter(
    (r) => r.isLastReplica && r.clientId === null,
  ) ?? [];

  const targetNodeOptions = useMemo(() => {
    const list = nodesQuery.data?.data ?? [];
    return list
      .filter((n) => n.name !== node.name && n.canHostClientWorkloads)
      .map((n) => n.name);
  }, [nodesQuery.data, node.name]);

  // Block "Apply re-pin & drain" only when the operator has EXPLICITLY
  // set a client to "stay" — that's a refusal-to-move signal and
  // letting the drain proceed would evict pods but leave their
  // nodeSelector pointing at the cordoned node.
  const stayPinnedClients = (impact?.pinnedClients ?? []).filter(
    (c) => clientPlacement[c.clientId] === 'stay',
  );
  const anyStayPinned = stayPinnedClients.length > 0;

  const handleDrain = async (): Promise<void> => {
    try {
      // Auto-fill: any pinned client without an explicit placement
      // gets "" (auto). Backend defaults the same — this is just a
      // defence-in-depth so an older backend that hasn't rolled the
      // server-side default still gets a complete map.
      const finalClientPlacement = { ...clientPlacement };
      for (const c of impact?.pinnedClients ?? []) {
        if (!(c.clientId in finalClientPlacement)) finalClientPlacement[c.clientId] = '';
      }
      await drain.mutateAsync({
        forceLastReplica,
        clientPlacement: finalClientPlacement,
      });
      // Refetch impact so the modal flips to "drained → ready to delete".
      await impactQuery.refetch();
    } catch {
      // surfaced via drain.error below
    }
  };

  const toggleExpand = (clientId: string) => {
    setExpandedClients((prev) => ({ ...prev, [clientId]: !prev[clientId] }));
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

              {/* ─── Pinned clients — one re-pin target per client ─── */}
              {impact.pinnedClients.length > 0 && (
                <ImpactSection
                  title={`Pinned clients (${impact.pinnedClients.length})`}
                  tone={impact.pinnedClients.some((c) => c.pvcs.some((p) => p.isLastReplica)) ? 'danger' : 'warn'}
                  content="These tenants have one or more workloads or volumes on this node. Pinning is a client-level property — pick one target per client; drain will patch every Deployment, StatefulSet, and Longhorn volume in the client's namespace consistently. Click a row to see what will be moved."
                >
                  <table className="mt-3 w-full text-xs">
                    <thead className="text-gray-500 dark:text-gray-400">
                      <tr>
                        <th className="w-6"></th>
                        <th className="text-left py-1 pr-2">Client</th>
                        <th className="text-left py-1 pr-2">Tier</th>
                        <th className="text-left py-1 pr-2">Current pin</th>
                        <th className="text-right py-1 pr-2">Workloads</th>
                        <th className="text-right py-1 pr-2">PVCs</th>
                        <th className="text-left py-1">Re-pin to</th>
                      </tr>
                    </thead>
                    <tbody>
                      {impact.pinnedClients.map((c) => {
                        const isExpanded = expandedClients[c.clientId] === true;
                        const value = clientPlacement[c.clientId] ?? '';
                        const hasLastReplica = c.pvcs.some((p) => p.isLastReplica);
                        const rowBorder = hasLastReplica
                          ? 'border-t border-red-200/60 dark:border-red-700/40'
                          : 'border-t border-amber-200/60 dark:border-amber-700/40';
                        return (
                          <Fragment key={c.clientId}>
                            <tr className={rowBorder}>
                              <td className="py-1.5 pl-1">
                                <button
                                  type="button"
                                  onClick={() => toggleExpand(c.clientId)}
                                  className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                                  aria-label={isExpanded ? 'Collapse details' : 'Expand details'}
                                  data-testid={`expand-client-${c.clientId}`}
                                >
                                  {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                </button>
                              </td>
                              <td className="py-1.5 pr-2">
                                <Link
                                  to={`/clients/${c.clientId}`}
                                  className="inline-flex items-center gap-1 text-brand-600 hover:underline dark:text-brand-400"
                                  data-testid={`pinned-client-link-${c.clientId}`}
                                >
                                  {c.clientName}
                                  <ExternalLink size={10} />
                                </Link>
                              </td>
                              <td className="py-1.5 pr-2">
                                <span className={c.storageTier === 'ha'
                                  ? 'rounded bg-blue-100 px-1 py-0.5 text-[10px] text-blue-800 dark:bg-blue-900/40 dark:text-blue-300'
                                  : 'rounded bg-gray-100 px-1 py-0.5 text-[10px] text-gray-700 dark:bg-gray-800 dark:text-gray-300'}>
                                  {c.storageTier}
                                </span>
                              </td>
                              <td className="py-1.5 pr-2 font-mono text-gray-600 dark:text-gray-400">
                                {c.currentWorkerNodeName ?? <span className="italic text-gray-400">—</span>}
                              </td>
                              <td className="py-1.5 pr-2 text-right tabular-nums">{c.workloads.length}</td>
                              <td className="py-1.5 pr-2 text-right tabular-nums">
                                {c.pvcs.length}
                                {hasLastReplica && (
                                  <span className="ml-1 rounded bg-red-100 px-1 py-0.5 text-[10px] text-red-800 dark:bg-red-900/40 dark:text-red-300">LAST</span>
                                )}
                              </td>
                              <td className="py-1.5">
                                <select
                                  className="rounded border border-amber-300 bg-white px-2 py-0.5 text-xs dark:bg-gray-800 dark:border-amber-700"
                                  value={value}
                                  onChange={(e) => setClientPlacement((prev) => ({ ...prev, [c.clientId]: e.target.value }))}
                                  data-testid={`client-placement-${c.clientId}`}
                                >
                                  <option value="stay">Stay (refuse to move)</option>
                                  <option value="">Auto (clear pin)</option>
                                  {targetNodeOptions.map((n) => (
                                    <option key={n} value={n}>{n}</option>
                                  ))}
                                </select>
                              </td>
                            </tr>
                            {isExpanded && (
                              <tr className="bg-amber-50/50 dark:bg-amber-900/10">
                                <td></td>
                                <td colSpan={6} className="py-2 pr-2">
                                  <div className="space-y-2">
                                    {c.workloads.length > 0 && (
                                      <div>
                                        <div className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Workloads</div>
                                        <ul className="mt-0.5 space-y-0.5 font-mono text-[11px] text-gray-700 dark:text-gray-300">
                                          {c.workloads.map((w) => (
                                            <li key={`${w.kind}/${w.name}`}>
                                              {w.kind}/{w.name}
                                              <span className="ml-2 text-gray-500">replicas={w.replicas} · pin={w.pinKind}</span>
                                            </li>
                                          ))}
                                        </ul>
                                      </div>
                                    )}
                                    {c.pvcs.length > 0 && (
                                      <div>
                                        <div className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Volumes</div>
                                        <ul className="mt-0.5 space-y-0.5 font-mono text-[11px] text-gray-700 dark:text-gray-300">
                                          {c.pvcs.map((p) => {
                                            const sizeGiB = (p.sizeBytes / (1024 ** 3)).toFixed(0);
                                            return (
                                              <li key={p.volumeName} className="flex items-center gap-1">
                                                <DatabaseIcon size={10} className="text-gray-400" />
                                                {p.pvcName || p.volumeName}
                                                <span className="ml-2 text-gray-500">{sizeGiB} GiB · replicas={p.replicaCount}</span>
                                                {p.isLastReplica && (
                                                  <span className="ml-1 rounded bg-red-100 px-1 py-0.5 text-[10px] text-red-800 dark:bg-red-900/40 dark:text-red-300">LAST</span>
                                                )}
                                              </li>
                                            );
                                          })}
                                        </ul>
                                      </div>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            )}
                          </Fragment>
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

              {/* ─── Platform last-replica risk ─── */}
              {lastReplicaVolumes.length > 0 && (
                <ImpactSection
                  title={`Last-replica risk (${lastReplicaVolumes.length})`}
                  tone="danger"
                  content={`${lastReplicaVolumes.length} volume(s) have only this node holding a healthy replica. Drain will be REFUSED unless you tick "force last replica".`}
                >
                  <table className="mt-2 w-full text-xs">
                    <thead className="text-gray-500 dark:text-gray-400">
                      <tr>
                        <th className="text-left py-1 pr-2">Owner</th>
                        <th className="text-left py-1 pr-2">PVC</th>
                        <th className="text-left py-1">Volume</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lastReplicaVolumes.map((r) => (
                        <tr key={r.replicaName} className="border-t border-red-200/60 dark:border-red-700/40">
                          <td className="py-1.5 pr-2">
                            {r.clientId ? (
                              <Link
                                to={`/clients/${r.clientId}`}
                                className="inline-flex items-center gap-1 text-brand-600 hover:underline dark:text-brand-400"
                              >
                                {r.clientName ?? r.ownerLabel}
                                <ExternalLink size={10} />
                              </Link>
                            ) : (
                              <span className="text-gray-700 dark:text-gray-300">{r.ownerLabel}</span>
                            )}
                          </td>
                          <td className="py-1.5 pr-2 font-mono text-gray-700 dark:text-gray-300">
                            {r.namespace && r.pvcName ? `${r.namespace}/${r.pvcName}` : <span className="text-gray-400 italic">unbound</span>}
                          </td>
                          <td className="py-1.5 font-mono text-gray-500 dark:text-gray-400">{r.volumeName}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
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
            <ErrorPanel
              error={extractOperatorError(drain.error)}
              severity="error"
              compact
              testId="drain-error-panel"
            />
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
              Re-pinned: {drain.data?.data.rePinnedClients ?? 0} client(s)
              {' '}({drain.data?.data.rePinnedWorkloads ?? 0} workload(s), {drain.data?.data.rePinnedPvcs ?? 0} PVC(s)).
            </p>
          )}
          {delErr && (
            <ErrorPanel
              error={extractOperatorError(del.error)}
              severity="error"
              compact
              testId="delete-error-panel"
            />
          )}

          {!drained && anyStayPinned && (
            <div className="rounded-lg border border-amber-400 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-600 dark:bg-amber-900/40 dark:text-amber-100" data-testid="drain-blocked-stay-pinned">
              <div className="flex items-center gap-1 font-semibold">
                <AlertTriangle size={12} /> Drain blocked — {stayPinnedClients.length} client(s) still set to &quot;Stay&quot;.
              </div>
              <p className="mt-1">Pick &quot;Auto&quot; or a specific target node for each pinned client. Leaving a client on &quot;Stay&quot; would evict its pods but their nodeSelectors would still point at this cordoned node — replacement pods sit Pending forever.</p>
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
                  ? `${stayPinnedClients.length} client(s) still set to "Stay" — pick Auto or a target node first`
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
