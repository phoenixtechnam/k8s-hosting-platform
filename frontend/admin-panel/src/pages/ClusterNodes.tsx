import { useState, type FormEvent } from 'react';
import { Server, Loader2, AlertCircle, Edit, X, Save, ShieldAlert, CheckCircle, HardDrive, Cpu } from 'lucide-react';
import clsx from 'clsx';
import { useClusterNodes, useUpdateClusterNode } from '@/hooks/use-cluster-nodes';
import type { ClusterNodeResponse } from '@k8s-hosting/api-contracts';

const INPUT_CLASS = 'mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2.5 text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-700 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

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

export default function ClusterNodes() {
  const { data, isLoading, error } = useClusterNodes();
  const nodes = (data?.data ?? []) as readonly ClusterNodeResponse[];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={24} className="animate-spin text-brand-500" />
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="cluster-nodes-page">
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
            <NodeCard key={node.name} node={node} />
          ))}
        </div>
      )}
    </div>
  );
}

function NodeCard({ node }: { readonly node: ClusterNodeResponse }) {
  const [editing, setEditing] = useState(false);
  const ready = readyCondition(node);
  const stale = staleness(node.lastSeenAt);

  return (
    <div className="rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4 dark:border-gray-700">
        <div className="flex items-center gap-3">
          <Server size={20} className="text-gray-500 dark:text-gray-400" />
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{node.name}</h2>
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
            onClick={() => setEditing((p) => !p)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
            data-testid={`edit-node-${node.name}-button`}
          >
            {editing ? <X size={14} /> : <Edit size={14} />} {editing ? 'Cancel' : 'Edit'}
          </button>
        </div>
      </div>

      {editing ? (
        <NodeEditForm node={node} onDone={() => setEditing(false)} />
      ) : (
        <NodeDetails node={node} />
      )}
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
            {node.taints.map((t, i) => (
              <li key={`${t.key}-${i}`} className="font-mono text-gray-700 dark:text-gray-300">
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

function NodeEditForm({ node, onDone }: { readonly node: ClusterNodeResponse; readonly onDone: () => void }) {
  const update = useUpdateClusterNode(node.name);
  const [role, setRole] = useState<'server' | 'worker'>(node.role);
  const [canHost, setCanHost] = useState(node.canHostClientWorkloads);
  const [notes, setNotes] = useState(node.notes ?? '');
  const [force, setForce] = useState(false);

  const isDemotion = node.role === 'server' && role === 'worker';

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await update.mutateAsync({
        role,
        canHostClientWorkloads: canHost,
        notes: notes.trim() === '' ? null : notes,
        force: isDemotion && force ? true : undefined,
      });
      onDone();
    } catch {
      // error surfaced via update.error below
    }
  };

  const err = update.error as { message?: string } | null;
  const isDemotionBlocked = Boolean(err?.message?.includes('NODE_DEMOTION_BLOCKED'));

  return (
    <form onSubmit={handleSubmit} className="space-y-4 bg-gray-50 px-5 py-4 dark:bg-gray-900" data-testid={`edit-node-${node.name}-form`}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Role</label>
          <select value={role} onChange={(e) => setRole(e.target.value as 'server' | 'worker')} className={INPUT_CLASS}>
            <option value="server">server (runs system workloads)</option>
            <option value="worker">worker (tenants only)</option>
          </select>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Demoting a server with system pods still on it requires Force.
          </p>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Can host client workloads</label>
          <select
            value={canHost ? 'true' : 'false'}
            onChange={(e) => setCanHost(e.target.value === 'true')}
            className={INPUT_CLASS}
          >
            <option value="true">Yes — tenant pods may schedule here</option>
            <option value="false">No — NoSchedule taint for tenant pods</option>
          </select>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Servers default to No; workers default to Yes.
          </p>
        </div>
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Operator notes</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          maxLength={2000}
          className={INPUT_CLASS}
          placeholder="Free text — surfaced only in this admin UI."
        />
      </div>
      {isDemotion && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200">
          <ShieldAlert size={14} className="mt-0.5 shrink-0" />
          <div>
            Demoting a server to worker evicts any system pods still running on it. The API will refuse unless you drain first or set Force.
            <label className="mt-1.5 flex items-center gap-2">
              <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
              <span>Force — bypass the safety check</span>
            </label>
          </div>
        </div>
      )}
      {err && !isDemotionBlocked && (
        <p className="flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
          <AlertCircle size={12} /> {err.message}
        </p>
      )}
      {isDemotionBlocked && (
        <p className="flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
          <AlertCircle size={12} /> Demotion blocked — tick Force to override.
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        <button type="button" onClick={onDone} className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700">
          Cancel
        </button>
        <button
          type="submit"
          disabled={update.isPending}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
          data-testid={`save-node-${node.name}-button`}
        >
          {update.isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          Save
        </button>
      </div>
      {update.isSuccess && (
        <p className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
          <CheckCircle size={12} /> Saved.
        </p>
      )}
    </form>
  );
}
