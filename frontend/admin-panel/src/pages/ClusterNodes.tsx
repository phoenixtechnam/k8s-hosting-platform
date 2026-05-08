import { useState } from 'react';
import {
  Server, Loader2, AlertCircle, Edit, ShieldAlert, HardDrive, Cpu, AlertTriangle,
  Trash2, ChevronRight, ChevronDown, CheckCircle2, Activity,
} from 'lucide-react';
import clsx from 'clsx';
import { useClusterNodes, useDeleteNode } from '@/hooks/use-cluster-nodes';
import { useNodeSubsystemHealth, type NodeSubsystemReport, type NodeSubsystemStatus } from '@/hooks/use-cluster-health';
import { useNodeHealth, type NodeHealthEntry } from '@/hooks/use-node-health';
import type { ClusterNodeResponse, NodeIngressMode } from '@k8s-hosting/api-contracts';
import NodeEditModal from '@/components/NodeEditModal';
import NodeDrainDeleteModal from '@/components/NodeDrainDeleteModal';
import NodeStorageCard from '@/components/NodeStorageCard';

// Saturation thresholds shared by the per-node compact summary, the cluster
// health bar, and the in-card UsageBar. Mirrors UsageBar's scale so the
// header dot, the aggregate-bar pressure pill, and the in-detail bar all
// agree on what counts as amber vs. red.
const PRESSURE_AMBER = 75;
const PRESSURE_RED = 90;

function nodePct(used: number | null | undefined, capacity: number | null | undefined): number | null {
  if (used == null || capacity == null || capacity <= 0) return null;
  return Math.min(100, Math.round((used / capacity) * 100));
}

function pctTone(pct: number | null): 'green' | 'amber' | 'red' | 'gray' {
  if (pct == null) return 'gray';
  if (pct >= PRESSURE_RED) return 'red';
  if (pct >= PRESSURE_AMBER) return 'amber';
  return 'green';
}

function isSubsystemUnhealthy(s: NodeSubsystemReport | undefined): boolean {
  if (!s) return false;
  return s.calico !== 'healthy' || s.longhornCsi !== 'healthy' || !s.csiDriverRegistered;
}

function formatBytes(bytes: number | null): string {
  if (bytes == null) return '—';
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(1)} TiB`;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MiB`;
  return `${bytes} B`;
}

function formatMillicores(millis: number | null): string {
  if (millis == null) return '—';
  if (millis >= 1000) return `${(millis / 1000).toFixed(1)} cores`;
  return `${millis}m`;
}

function staleness(lastSeenAt: string): { label: string; tone: 'fresh' | 'stale' | 'dead' } {
  const diff = Date.now() - new Date(lastSeenAt).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 2) return { label: 'just now', tone: 'fresh' };
  if (mins < 5) return { label: `${mins}m ago`, tone: 'fresh' };
  if (mins < 30) return { label: `${mins}m ago`, tone: 'stale' };
  if (mins < 60 * 24) return { label: `${Math.floor(mins / 60)}h ago`, tone: 'dead' };
  return { label: `${Math.floor(mins / 60 / 24)}d ago`, tone: 'dead' };
}

function readyCondition(node: ClusterNodeResponse): 'Ready' | 'NotReady' | 'Unknown' {
  if (!node.statusConditions) return 'Unknown';
  const ready = node.statusConditions.find((c) => c.type === 'Ready');
  if (!ready) return 'Unknown';
  return ready.status === 'True' ? 'Ready' : 'NotReady';
}

interface ClusterNodesProps {
  /** When true, omit the page-level <h1> header so the panel can be embedded inside a tabbed layout (e.g. NodesAndStorage). */
  readonly embedded?: boolean;
}

export default function ClusterNodes({ embedded = false }: ClusterNodesProps = {}) {
  const { data, isLoading, error } = useClusterNodes();
  const { data: subsystemData } = useNodeSubsystemHealth();
  const { data: nodeHealthData } = useNodeHealth();
  const nodes = (data?.data ?? []) as readonly ClusterNodeResponse[];
  const subsystemByName = new Map<string, NodeSubsystemReport>(
    (subsystemData?.data.nodes ?? []).map((s) => [s.nodeName, s]),
  );
  const nodeHealthByName = new Map<string, NodeHealthEntry>(
    (nodeHealthData?.data.nodes ?? []).map((n) => [n.name, n]),
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={24} className="animate-spin text-brand-500" />
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="cluster-nodes-page">
      {!embedded && (
        <div className="flex items-center gap-3">
          <Server size={28} className="text-brand-500" />
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Cluster Nodes</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Every node in the k3s cluster, with platform-managed role + host-client-workloads state.
              Labels on the k8s node are authoritative; edits here write the label first then refresh.
            </p>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 dark:border-red-700 dark:bg-red-900/30">
          <p className="flex items-center gap-2 text-sm text-red-800 dark:text-red-200">
            <AlertCircle size={16} /> Failed to load nodes: {(error as Error).message}
          </p>
        </div>
      )}

      {nodes.length === 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white px-5 py-12 text-center text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
          No nodes observed yet. The backend reconciler ticks every 60 seconds; check back shortly.
        </div>
      ) : (
        <>
          <ClusterHealthBar nodes={nodes} subsystemByName={subsystemByName} />
          <div className="space-y-3">
            {nodes.map((node) => (
              <NodeCard key={node.name} node={node} subsystem={subsystemByName.get(node.name)} health={nodeHealthByName.get(node.name)} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Cluster-wide compact health bar ─────────────────────────────────────────
//
// Aggregates per-node pressure + subsystem state into a single scannable row
// shown above the node list. When everything is healthy: a single green
// "All systems healthy" chip. Otherwise: only the issue chips render — zero
// counts hide so the bar stays compact on healthy clusters.
function ClusterHealthBar({
  nodes,
  subsystemByName,
}: {
  readonly nodes: readonly ClusterNodeResponse[];
  readonly subsystemByName: Map<string, NodeSubsystemReport>;
}) {
  let readyCount = 0;
  let notReadyCount = 0;
  let cordonedCount = 0;
  let drainedCount = 0;
  let cpuAmberCount = 0;
  let cpuRedCount = 0;
  let memAmberCount = 0;
  let memRedCount = 0;
  let subsystemBadCount = 0;

  for (const node of nodes) {
    const ready = readyCondition(node);
    if (ready === 'Ready') readyCount++;
    else notReadyCount++;
    if (node.cordoned && !node.drained) cordonedCount++;
    if (node.drained) drainedCount++;

    const cpuTone = pctTone(nodePct(node.cpuRequestsMillicores ?? null, node.cpuMillicores));
    if (cpuTone === 'red') cpuRedCount++;
    else if (cpuTone === 'amber') cpuAmberCount++;

    const memTone = pctTone(nodePct(node.memoryRequestsBytes ?? null, node.memoryBytes));
    if (memTone === 'red') memRedCount++;
    else if (memTone === 'amber') memAmberCount++;

    if (isSubsystemUnhealthy(subsystemByName.get(node.name))) subsystemBadCount++;
  }

  const cpuTotal = cpuAmberCount + cpuRedCount;
  const memTotal = memAmberCount + memRedCount;
  const allHealthy =
    notReadyCount === 0 &&
    cordonedCount === 0 &&
    drainedCount === 0 &&
    cpuTotal === 0 &&
    memTotal === 0 &&
    subsystemBadCount === 0;

  return (
    <div
      data-testid="cluster-health-bar"
      role="status"
      aria-live="polite"
      className={clsx(
        'flex flex-wrap items-center gap-2 rounded-xl border px-4 py-2.5 text-xs',
        allHealthy
          ? 'border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-900/20'
          : 'border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800',
      )}
    >
      <Activity size={14} className="text-gray-500 dark:text-gray-400 shrink-0" />
      <span className="font-medium text-gray-700 dark:text-gray-200">
        {nodes.length} node{nodes.length !== 1 ? 's' : ''}
      </span>

      {allHealthy ? (
        <HealthChip tone="green" testId="health-all-ok">
          <CheckCircle2 size={12} /> All systems healthy
        </HealthChip>
      ) : (
        <>
          <HealthChip tone={notReadyCount > 0 ? 'red' : 'green'} testId="health-ready">
            {readyCount}/{nodes.length} Ready
          </HealthChip>
          {cpuTotal > 0 && (
            <HealthChip tone={cpuRedCount > 0 ? 'red' : 'amber'} testId="health-cpu">
              <Cpu size={12} /> CPU pressure: {cpuTotal} node{cpuTotal !== 1 ? 's' : ''}
              {cpuRedCount > 0 && ` (${cpuRedCount} ≥${PRESSURE_RED}%)`}
            </HealthChip>
          )}
          {memTotal > 0 && (
            <HealthChip tone={memRedCount > 0 ? 'red' : 'amber'} testId="health-memory">
              <HardDrive size={12} /> Memory pressure: {memTotal} node{memTotal !== 1 ? 's' : ''}
              {memRedCount > 0 && ` (${memRedCount} ≥${PRESSURE_RED}%)`}
            </HealthChip>
          )}
          {subsystemBadCount > 0 && (
            <HealthChip tone="red" testId="health-subsystem">
              <ShieldAlert size={12} /> Worker subsystem issues: {subsystemBadCount}
            </HealthChip>
          )}
          {cordonedCount > 0 && (
            <HealthChip tone="amber" testId="health-cordoned">
              Cordoned: {cordonedCount}
            </HealthChip>
          )}
          {drainedCount > 0 && (
            <HealthChip tone="gray" testId="health-drained">
              Drained: {drainedCount}
            </HealthChip>
          )}
        </>
      )}
    </div>
  );
}

function HealthChip({
  tone,
  children,
  testId,
}: {
  readonly tone: 'green' | 'amber' | 'red' | 'gray';
  readonly children: React.ReactNode;
  readonly testId?: string;
}) {
  const cls = clsx(
    'inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium',
    tone === 'green' && 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
    tone === 'amber' && 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
    tone === 'red' && 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
    tone === 'gray' && 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
  );
  return <span className={cls} data-testid={testId}>{children}</span>;
}

function NodeCard({ node, subsystem, health }: { readonly node: ClusterNodeResponse; readonly subsystem?: NodeSubsystemReport; readonly health?: NodeHealthEntry }) {
  const [expanded, setExpanded] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [drainOpen, setDrainOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleteNodeMutation = useDeleteNode(node.name);
  const ready = readyCondition(node);
  const stale = staleness(node.lastSeenAt);
  // Surface alias when present, but always keep the k8s identity visible.
  const headerName = node.displayName?.trim() ? node.displayName : node.name;

  const cpuPct = nodePct(node.cpuRequestsMillicores ?? null, node.cpuMillicores);
  const memPct = nodePct(node.memoryRequestsBytes ?? null, node.memoryBytes);
  const subsystemBad = isSubsystemUnhealthy(subsystem);

  const handleDelete = () => {
    if (!confirm(`Delete node "${node.name}" from the cluster? The host itself stays running — kubectl delete + DB row removal only.`)) return;
    setDeleteError(null);
    deleteNodeMutation.mutate(undefined, {
      onError: (err) => setDeleteError(err instanceof Error ? err.message : 'Delete failed'),
    });
  };

  // The header row toggles expansion on click. The action buttons in the
  // header stop click propagation so the row click doesn't both open the
  // edit/drain/delete dialog AND toggle the card expansion. Keyboard
  // activation of those inner buttons fires a synthetic `click` event on
  // the button itself, which never bubbles up to the row's onClick — so no
  // onKeyDown guard is needed on the action wrapper.
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  const toggle = () => setExpanded((v) => !v);
  // The chevron is a real <button> for keyboard / screen-reader users —
  // it carries aria-expanded + aria-controls and stops click propagation
  // (the row already has its own click handler). Mouse users can click
  // anywhere on the row to expand; the row itself is NOT given role=button
  // because it contains real <button> children (Edit / Drain / Delete /
  // chevron) — nested interactive elements under role=button is an ARIA
  // authoring violation.

  return (
    <div
      className="rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800"
      data-testid={`node-card-${node.name}`}
    >
      <div
        onClick={toggle}
        className={clsx(
          'flex items-center justify-between gap-3 px-5 py-4 cursor-pointer select-none',
          'hover:bg-gray-50 dark:hover:bg-gray-700/40',
          expanded && 'border-b border-gray-100 dark:border-gray-700',
          'rounded-xl',
        )}
        data-testid={`node-card-header-${node.name}`}
      >
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <button
            type="button"
            onClick={(e) => { stop(e); toggle(); }}
            aria-expanded={expanded}
            aria-controls={`node-body-${node.name}`}
            aria-label={expanded ? `Collapse ${headerName}` : `Expand ${headerName}`}
            className="rounded p-0.5 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            data-testid={`node-card-toggle-${node.name}`}
          >
            {expanded
              ? <ChevronDown size={16} aria-hidden="true" />
              : <ChevronRight size={16} aria-hidden="true" />}
          </button>
          <Server size={20} className="text-gray-500 dark:text-gray-400 shrink-0" />
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{headerName}</h2>
              {node.displayName && node.displayName !== node.name && (
                <span className="font-mono text-xs text-gray-500 dark:text-gray-400" title="kubernetes node name">
                  ({node.name})
                </span>
              )}
              <RolePill role={node.role} />
              {health && health.severity !== 'normal' && (
                <span
                  className={clsx(
                    'rounded-full px-2 py-0.5 text-xs font-medium',
                    health.severity === 'critical'
                      ? 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300'
                      : 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
                  )}
                  title={
                    [
                      health.pressures.length > 0 ? `${health.pressures.join(' + ')}-pressure` : null,
                      health.csiDriversMissing.length > 0 ? `CSI missing: ${health.csiDriversMissing.join(', ')}` : null,
                      health.evictionsLastHour > 0 ? `${health.evictionsLastHour} pod evictions/h` : null,
                      !health.ready ? 'NotReady' : null,
                    ].filter(Boolean).join(' · ') || `severity=${health.severity}`
                  }
                  data-testid={`node-health-badge-${node.name}`}
                >
                  {health.severity === 'critical' ? '⚠ critical' : '! warning'}
                </span>
              )}
              {node.canHostClientWorkloads ? (
                <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300">
                  hosts tenants
                </span>
              ) : (
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700 dark:bg-gray-700 dark:text-gray-300">
                  system only
                </span>
              )}
              {node.cordoned && !node.drained && (
                <span
                  className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 dark:bg-red-900/40 dark:text-red-300"
                  title="Node is cordoned (spec.unschedulable=true) — no new pods will schedule here"
                  data-testid={`node-cordoned-tag-${node.name}`}
                >
                  Cordoned
                </span>
              )}
              {node.drained && (
                <span
                  className="rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-800 dark:bg-purple-900/40 dark:text-purple-300"
                  title="Node is fully drained — cordoned + no client workloads + no Longhorn replicas. Safe to delete."
                  data-testid={`node-drained-tag-${node.name}`}
                >
                  Drained
                </span>
              )}
              <IngressModePill mode={node.ingressMode} />
              <ReadyPill ready={ready} />
              {subsystemBad && (
                <span
                  className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 dark:bg-red-900/40 dark:text-red-300"
                  title="One or more worker subsystems are degraded — expand for details."
                  data-testid={`node-subsystem-tag-${node.name}`}
                >
                  <ShieldAlert size={10} /> subsystem
                </span>
              )}
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {node.publicIp ?? 'no public IP'} · k3s {node.k3sVersion ?? '—'} · kubelet {node.kubeletVersion ?? '—'}
            </p>
          </div>
        </div>

        {/* Compact resource summary — visible without expanding. Three dots
            with values; same colour scale as UsageBar so the operator can
            scan a list of cards without opening each. */}
        <div className="hidden md:flex items-center gap-3 text-xs text-gray-600 dark:text-gray-300 shrink-0">
          <SummaryDot label="CPU" pct={cpuPct} />
          <SummaryDot label="Mem" pct={memPct} />
          <span className="tabular-nums" title="scheduled pods">
            {node.scheduledPods ?? '—'} pods
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0" onClick={stop}>
          <span
            className={clsx(
              'text-xs whitespace-nowrap',
              stale.tone === 'fresh' && 'text-green-600 dark:text-green-400',
              stale.tone === 'stale' && 'text-amber-600 dark:text-amber-400',
              stale.tone === 'dead' && 'text-red-600 dark:text-red-400',
            )}
            title={`last seen: ${new Date(node.lastSeenAt).toLocaleString()}`}
          >
            {stale.label}
          </span>
          <button
            type="button"
            onClick={() => setEditOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
            data-testid={`edit-node-${node.name}-button`}
          >
            <Edit size={14} /> Edit
          </button>
          <button
            type="button"
            onClick={() => setDrainOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm text-amber-800 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200 dark:hover:bg-amber-900/50"
            data-testid={`drain-node-${node.name}-open-button`}
            title="Cordon, drain, and (after drained) delete this node"
          >
            <AlertTriangle size={14} /> Drain Node
          </button>
          {node.drained && (
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleteNodeMutation.isPending}
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-300 bg-red-50 px-3 py-1.5 text-sm text-red-800 hover:bg-red-100 disabled:opacity-50 dark:border-red-700 dark:bg-red-900/30 dark:text-red-200 dark:hover:bg-red-900/50"
              data-testid={`delete-node-${node.name}-button`}
              title="Remove the drained node from the cluster (kubectl delete node + DB row)"
            >
              <Trash2 size={14} /> {deleteNodeMutation.isPending ? 'Deleting…' : 'Delete'}
            </button>
          )}
        </div>
      </div>

      {deleteError && (
        <div className="border-b border-red-200 bg-red-50 px-5 py-2 text-xs text-red-800 dark:border-red-700 dark:bg-red-900/30 dark:text-red-200" data-testid={`delete-node-error-${node.name}`}>
          {deleteError}
        </div>
      )}

      {expanded && (
        <div id={`node-body-${node.name}`} data-testid={`node-card-body-${node.name}`}>
          {subsystem && <SubsystemHealthRow subsystem={subsystem} />}
          <NodeDetails node={node} />
          <NodeStorageCard nodeName={node.name} />
        </div>
      )}

      {editOpen && <NodeEditModal node={node} onClose={() => setEditOpen(false)} />}
      {drainOpen && <NodeDrainDeleteModal node={node} onClose={() => setDrainOpen(false)} />}
    </div>
  );
}

function SummaryDot({ label, pct }: { readonly label: string; readonly pct: number | null }) {
  const tone = pctTone(pct);
  const dotClass = clsx(
    'inline-block h-2 w-2 rounded-full',
    tone === 'green' && 'bg-green-500',
    tone === 'amber' && 'bg-amber-500',
    tone === 'red' && 'bg-red-500',
    tone === 'gray' && 'bg-gray-300 dark:bg-gray-600',
  );
  return (
    <span className="inline-flex items-center gap-1 tabular-nums" title={`${label} requests / allocatable`}>
      <span className={dotClass} />
      {label} {pct == null ? '—' : `${pct}%`}
    </span>
  );
}

function IngressModePill({ mode }: { readonly mode: NodeIngressMode }) {
  const styles = {
    all: { className: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300', label: 'ingress: all' },
    local: { className: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300', label: 'ingress: local' },
    none: { className: 'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-300', label: 'ingress: none' },
  } as const;
  const s = styles[mode];
  return <span className={clsx('rounded-full px-2 py-0.5 text-xs font-medium', s.className)}>{s.label}</span>;
}

function SubsystemHealthRow({ subsystem }: { readonly subsystem: NodeSubsystemReport }) {
  const allHealthy = subsystem.calico === 'healthy' && subsystem.longhornCsi === 'healthy' && subsystem.csiDriverRegistered;
  if (allHealthy) return null;

  const stateClass = (s: NodeSubsystemStatus): string => clsx(
    'rounded-full px-2 py-0.5 text-xs font-medium',
    s === 'healthy' && 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
    s === 'degraded' && 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
    s === 'missing' && 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  );

  return (
    <div className="border-y border-amber-200 bg-amber-50 px-5 py-3 text-xs dark:border-amber-800 dark:bg-amber-900/20" data-testid={`node-subsystem-${subsystem.nodeName}`}>
      <div className="flex items-center gap-2 mb-1">
        <ShieldAlert size={14} className="text-amber-700 dark:text-amber-400" />
        <span className="font-semibold text-amber-900 dark:text-amber-200">Worker subsystem issues</span>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-amber-900 dark:text-amber-200">
        <span className="inline-flex items-center gap-1.5">
          Calico CNI: <span className={stateClass(subsystem.calico)}>{subsystem.calico}</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          Longhorn CSI: <span className={stateClass(subsystem.longhornCsi)}>{subsystem.longhornCsi}</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          CSI driver registered: {subsystem.csiDriverRegistered ? '✓' : '✗'}
        </span>
      </div>
      {(subsystem.calicoMessage || subsystem.longhornCsiMessage) && (
        <ul className="mt-2 space-y-0.5 font-mono text-amber-900 dark:text-amber-300">
          {subsystem.calicoMessage && <li>calico: {subsystem.calicoMessage}</li>}
          {subsystem.longhornCsiMessage && <li>longhorn-csi: {subsystem.longhornCsiMessage}</li>}
        </ul>
      )}
      <p className="mt-2 text-amber-800 dark:text-amber-300">
        Tenant pods pinned to this node will fail to attach PVCs. Drain + re-bootstrap the worker via{' '}
        <code className="font-mono">./scripts/bootstrap.sh --remote &lt;ip&gt; --join-as worker --server &lt;cp&gt; --token &lt;t&gt;</code>.
      </p>
    </div>
  );
}

function RolePill({ role }: { readonly role: 'server' | 'worker' }) {
  return role === 'server' ? (
    <span className="rounded-full bg-brand-100 px-2 py-0.5 text-xs font-medium text-brand-800 dark:bg-brand-900/40 dark:text-brand-300">
      server
    </span>
  ) : (
    <span className="rounded-full bg-accent-100 px-2 py-0.5 text-xs font-medium text-accent-800 dark:bg-accent-900/40 dark:text-accent-300">
      worker
    </span>
  );
}

function ReadyPill({ ready }: { readonly ready: 'Ready' | 'NotReady' | 'Unknown' }) {
  const styles = {
    Ready: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
    NotReady: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
    Unknown: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
  } as const;
  return <span className={clsx('rounded-full px-2 py-0.5 text-xs font-medium', styles[ready])}>{ready}</span>;
}

function UsageBar({ used, capacity, label, formatValue }: {
  readonly used: number | null | undefined;
  readonly capacity: number | null | undefined;
  readonly label: string;
  readonly formatValue: (n: number | null) => string;
}) {
  const hasData = used != null && capacity != null && capacity > 0;
  const pct = hasData ? Math.min(100, Math.round((used / capacity) * 100)) : 0;
  const tone =
    pct >= 90 ? 'bg-red-500' :
      pct >= 75 ? 'bg-amber-500' :
        'bg-green-500';
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs text-gray-500 dark:text-gray-400">
        <span>{label}</span>
        <span className="tabular-nums">
          {hasData
            ? `${formatValue(used)} / ${formatValue(capacity)} (${pct}%)`
            : `— / ${formatValue(capacity ?? null)}`}
        </span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
        <div className={clsx('h-full transition-all', tone)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function NodeDetails({ node }: { readonly node: ClusterNodeResponse }) {
  return (
    <div className="space-y-4 px-5 py-4 text-sm">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="flex items-center gap-2">
          <Cpu size={16} className="text-gray-400" />
          <div className="flex-1">
            <UsageBar
              label="CPU (requests / allocatable)"
              used={node.cpuRequestsMillicores ?? null}
              capacity={node.cpuMillicores}
              formatValue={formatMillicores}
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <HardDrive size={16} className="text-gray-400" />
          <div className="flex-1">
            <UsageBar
              label="Memory (requests / allocatable)"
              used={node.memoryRequestsBytes ?? null}
              capacity={node.memoryBytes}
              formatValue={formatBytes}
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <HardDrive size={16} className="text-gray-400" />
          <div>
            <div className="text-xs text-gray-500 dark:text-gray-400">Scheduled pods</div>
            <div className="font-medium text-gray-900 dark:text-gray-100">
              {node.scheduledPods ?? '—'}
            </div>
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <HardDrive size={16} className="text-gray-400" />
        <div>
          <div className="text-xs text-gray-500 dark:text-gray-400">Ephemeral storage allocatable</div>
          <div className="font-medium text-gray-900 dark:text-gray-100">{formatBytes(node.storageBytes)}</div>
        </div>
      </div>
      {node.notes && (
        <div>
          <div className="text-xs text-gray-500 dark:text-gray-400">Operator notes</div>
          <p className="whitespace-pre-wrap text-gray-700 dark:text-gray-200">{node.notes}</p>
        </div>
      )}
      {node.taints && node.taints.length > 0 && (
        <div>
          <div className="text-xs text-gray-500 dark:text-gray-400">Taints</div>
          <ul className="mt-1 space-y-0.5 text-xs">
            {node.taints.map((t) => (
              // (key, effect) is unique within a valid taint set;
              // using both as the React key avoids the index-based
              // collision when two taints share the same key but
              // different effects.
              <li key={`${t.key}:${t.effect}`} className="font-mono text-gray-700 dark:text-gray-300">
                {t.key}
                {t.value ? `=${t.value}` : ''}:{t.effect}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

