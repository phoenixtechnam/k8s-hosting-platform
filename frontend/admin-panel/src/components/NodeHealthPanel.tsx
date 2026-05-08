import { useState } from 'react';
import { Loader2, RefreshCw, AlertCircle, AlertTriangle, CheckCircle2, Wrench } from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';
import { useNodeHealth, useReconcileNodeHealth, type NodeHealthEntry, type NodeHealthSeverity } from '@/hooks/use-node-health';
import NodeRecoveryModal from '@/components/NodeRecoveryModal';

const SEVERITY_BADGE: Record<NodeHealthSeverity, 'error' | 'warning' | 'healthy'> = {
  critical: 'error',
  warning: 'warning',
  normal: 'healthy',
};

const SEVERITY_ICON: Record<NodeHealthSeverity, typeof CheckCircle2> = {
  critical: AlertCircle,
  warning: AlertTriangle,
  normal: CheckCircle2,
};

const SEVERITY_LABEL: Record<NodeHealthSeverity, string> = {
  critical: 'Critical',
  warning: 'Warning',
  normal: 'Healthy',
};

function formatRelative(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 60 * 60_000) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < 24 * 60 * 60_000) return `${Math.floor(ms / (60 * 60_000))} h ago`;
  return `${Math.floor(ms / (24 * 60 * 60_000))} d ago`;
}

function pressureSummary(entry: NodeHealthEntry): string {
  const parts: string[] = [];
  if (!entry.ready) parts.push('NotReady');
  if (entry.pressures.length > 0) parts.push(entry.pressures.map((p) => `${p}-pressure`).join(' + '));
  if (entry.csiDriversMissing.length > 0) parts.push(`CSI missing: ${entry.csiDriversMissing.join(', ')}`);
  if (entry.evictionsLastHour > 0) parts.push(`${entry.evictionsLastHour} evictions/h`);
  if (entry.diskUsedPct !== null) parts.push(`disk ${entry.diskUsedPct.toFixed(0)}%`);
  return parts.length === 0 ? 'all clear' : parts.join(' · ');
}

export default function NodeHealthPanel() {
  const { data, isLoading, isError, error } = useNodeHealth();
  const reconcile = useReconcileNodeHealth();
  const [recoveryNode, setRecoveryNode] = useState<NodeHealthEntry | null>(null);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-gray-600 dark:text-gray-400">
        <Loader2 className="animate-spin" size={16} /> loading node health…
      </div>
    );
  }

  if (isError) {
    return (
      <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300">
        Failed to load node health: {(error as Error)?.message ?? 'unknown error'}
      </div>
    );
  }

  const summary = data?.data;
  if (!summary) return null;

  const sortedNodes = summary.nodes;
  const lastTickLabel = formatRelative(summary.lastTickAt);
  const overallBadge = SEVERITY_BADGE[summary.overallSeverity];
  const OverallIcon = SEVERITY_ICON[summary.overallSeverity];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <OverallIcon
            size={18}
            className={
              summary.overallSeverity === 'critical' ? 'text-red-600 dark:text-red-400'
              : summary.overallSeverity === 'warning' ? 'text-amber-600 dark:text-amber-400'
              : 'text-green-600 dark:text-green-400'
            }
          />
          <div>
            <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
              Overall: <StatusBadge status={overallBadge} label={SEVERITY_LABEL[summary.overallSeverity]} />
            </div>
            <div className="text-xs text-gray-500 dark:text-gray-400">
              {summary.nodes.length} node(s) · last tick {lastTickLabel}
            </div>
          </div>
        </div>
        <button
          onClick={() => reconcile.mutate()}
          disabled={reconcile.isPending}
          className="inline-flex items-center gap-1.5 rounded border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
          data-testid="node-health-reconcile"
        >
          {reconcile.isPending ? <Loader2 className="animate-spin" size={12} /> : <RefreshCw size={12} />}
          Reconcile now
        </button>
      </div>

      {sortedNodes.length === 0 ? (
        <div className="rounded border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600 dark:border-gray-700 dark:bg-gray-800/40 dark:text-gray-300">
          No nodes observed yet. The first reconciler tick fires ~90s after platform-api starts.
        </div>
      ) : (
        <div className="overflow-x-auto rounded border border-gray-200 dark:border-gray-700">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500 dark:bg-gray-800 dark:text-gray-400">
              <tr>
                <th className="px-3 py-2 font-medium">Node</th>
                <th className="px-3 py-2 font-medium">Severity</th>
                <th className="px-3 py-2 font-medium">Ready</th>
                <th className="px-3 py-2 font-medium">Pressures</th>
                <th className="px-3 py-2 font-medium">CSI drivers</th>
                <th className="px-3 py-2 font-medium text-right">Evictions/h</th>
                <th className="px-3 py-2 font-medium">Detail</th>
                <th className="px-3 py-2 font-medium text-right">Recover</th>
              </tr>
            </thead>
            <tbody>
              {sortedNodes.map((n) => {
                const Icon = SEVERITY_ICON[n.severity];
                return (
                  <tr key={n.name} className="border-t border-gray-100 dark:border-gray-700/40" data-testid={`node-health-row-${n.name}`}>
                    <td className="px-3 py-2 font-mono text-xs">{n.name}</td>
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center gap-1.5">
                        <Icon
                          size={14}
                          className={
                            n.severity === 'critical' ? 'text-red-600 dark:text-red-400'
                            : n.severity === 'warning' ? 'text-amber-600 dark:text-amber-400'
                            : 'text-green-600 dark:text-green-400'
                          }
                        />
                        <StatusBadge status={SEVERITY_BADGE[n.severity]} label={SEVERITY_LABEL[n.severity]} />
                      </span>
                    </td>
                    <td className="px-3 py-2">{n.ready ? '✓' : <span className="text-red-600 dark:text-red-400">✗</span>}</td>
                    <td className="px-3 py-2 text-xs">
                      {n.pressures.length === 0 ? (
                        <span className="text-gray-400">—</span>
                      ) : (
                        n.pressures.map((p) => (
                          <span
                            key={p}
                            className="mr-1 inline-block rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                          >
                            {p}
                          </span>
                        ))
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <span className={n.csiDriversMissing.length > 0 ? 'text-red-600 dark:text-red-400' : ''}>
                        {n.csiDriversPresent}/{n.csiDriversExpected}
                      </span>
                      {n.csiDriversMissing.length > 0 && (
                        <span className="ml-1 text-[10px] text-red-500 dark:text-red-400">missing: {n.csiDriversMissing.join(', ')}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {n.evictionsLastHour > 0 ? (
                        <span className="text-amber-600 dark:text-amber-400">{n.evictionsLastHour}</span>
                      ) : (
                        <span className="text-gray-400">0</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-600 dark:text-gray-300">
                      {pressureSummary(n)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {n.severity !== 'normal' ? (
                        <button
                          type="button"
                          onClick={() => setRecoveryNode(n)}
                          className="inline-flex items-center gap-1 rounded border border-gray-300 bg-white px-2 py-1 text-[11px] font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
                          data-testid={`recovery-open-${n.name}`}
                        >
                          <Wrench size={11} /> Recover…
                        </button>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="text-xs text-gray-500 dark:text-gray-400">
        Reconciler runs every 5 min. Notifications fire on severity transitions and re-fire every 24 h while a node remains warning/critical. Recovery actions audit-log every run; see{' '}
        <code className="rounded bg-gray-100 px-1 py-0.5 text-[10px] dark:bg-gray-800">docs/02-operations/NODE_HEALTH_MONITORING.md</code> for the action catalogue.
      </div>

      {recoveryNode && (
        <NodeRecoveryModal entry={recoveryNode} onClose={() => setRecoveryNode(null)} />
      )}
    </div>
  );
}
