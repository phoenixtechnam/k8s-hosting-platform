import { useState } from 'react';
import { Server, Loader2, AlertCircle, Edit, ShieldAlert, HardDrive, Cpu, AlertTriangle } from 'lucide-react';
import clsx from 'clsx';
import { useClusterNodes } from '@/hooks/use-cluster-nodes';
import { useNodeSubsystemHealth, type NodeSubsystemReport, type NodeSubsystemStatus } from '@/hooks/use-cluster-health';
import type { ClusterNodeResponse, NodeIngressMode } from '@k8s-hosting/api-contracts';
import NodeEditModal from '@/components/NodeEditModal';
import NodeDrainDeleteModal from '@/components/NodeDrainDeleteModal';

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
  const nodes = (data?.data ?? []) as readonly ClusterNodeResponse[];
  const subsystemByName = new Map<string, NodeSubsystemReport>(
    (subsystemData?.data.nodes ?? []).map((s) => [s.nodeName, s]),
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
        <div className="space-y-4">
          {nodes.map((node) => (
            <NodeCard key={node.name} node={node} subsystem={subsystemByName.get(node.name)} />
          ))}
        </div>
      )}
    </div>
  );
}

function NodeCard({ node, subsystem }: { readonly node: ClusterNodeResponse; readonly subsystem?: NodeSubsystemReport }) {
  const [editOpen, setEditOpen] = useState(false);
  const [drainOpen, setDrainOpen] = useState(false);
  const ready = readyCondition(node);
  const stale = staleness(node.lastSeenAt);
  // Surface alias when present, but always keep the k8s identity visible.
  const headerName = node.displayName?.trim() ? node.displayName : node.name;

  return (
    <div className="rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4 dark:border-gray-700">
        <div className="flex items-center gap-3">
          <Server size={20} className="text-gray-500 dark:text-gray-400" />
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{headerName}</h2>
              {node.displayName && node.displayName !== node.name && (
                <span className="font-mono text-xs text-gray-500 dark:text-gray-400" title="kubernetes node name">
                  ({node.name})
                </span>
              )}
              <RolePill role={node.role} />
              {node.canHostClientWorkloads ? (
                <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300">
                  hosts tenants
                </span>
              ) : (
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700 dark:bg-gray-700 dark:text-gray-300">
                  system only
                </span>
              )}
              <IngressModePill mode={node.ingressMode} />
              <ReadyPill ready={ready} />
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {node.publicIp ?? 'no public IP'} · k3s {node.k3sVersion ?? '—'} · kubelet {node.kubeletVersion ?? '—'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span
            className={clsx(
              'text-xs',
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
        </div>
      </div>

      {subsystem && (
        <SubsystemHealthRow subsystem={subsystem} />
      )}

      <NodeDetails node={node} />

      {editOpen && <NodeEditModal node={node} onClose={() => setEditOpen(false)} />}
      {drainOpen && <NodeDrainDeleteModal node={node} onClose={() => setDrainOpen(false)} />}
    </div>
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

