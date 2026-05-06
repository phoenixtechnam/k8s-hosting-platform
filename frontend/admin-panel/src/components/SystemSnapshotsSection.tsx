/**
 * Lifted from pages/Storage.tsx so both the Storage page and the new
 * System Backup → Longhorn Snapshots tab share one implementation.
 *
 * Self-contained: hits /admin/system-snapshots, groups CNPG cluster
 * replicas, opens SystemSnapshotsModal for per-volume management.
 */
import { useState, Fragment } from 'react';
import { Loader2, AlertTriangle } from 'lucide-react';
import { useSystemSnapshots } from '@/hooks/use-system-snapshots';
import SystemSnapshotsModal from '@/components/SystemSnapshotsModal';
import type { SystemPvcSnapshotSummary } from '@k8s-hosting/api-contracts';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

function SystemSnapshotsSection() {
  const { data, isLoading, error } = useSystemSnapshots();
  const [openVolume, setOpenVolume] = useState<SystemPvcSnapshotSummary | null>(null);
  const [expandedClusters, setExpandedClusters] = useState<Set<string>>(new Set());
  const items = data?.data.items ?? [];

  // Group CNPG cluster's replicas into a single collapsed row.
  interface ClusterGroup {
    readonly key: string;
    readonly clusterNamespace: string;
    readonly clusterName: string;
    readonly replicas: readonly SystemPvcSnapshotSummary[];
    readonly primary: SystemPvcSnapshotSummary | null;
    readonly snapshotCount: number;
    readonly snapshotBytesTotal: number;
    readonly volumeSizeBytes: number;
    readonly newestSnapshotAt: string | null;
    readonly degraded: boolean;
    readonly recurringJobs: readonly string[];
  }
  const clusterMap = new Map<string, SystemPvcSnapshotSummary[]>();
  const standalone: SystemPvcSnapshotSummary[] = [];
  for (const it of items) {
    if (it.cnpgCluster) {
      const k = `${it.cnpgCluster.namespace}/${it.cnpgCluster.name}`;
      const arr = clusterMap.get(k) ?? [];
      arr.push(it); clusterMap.set(k, arr);
    } else standalone.push(it);
  }
  const groups: ClusterGroup[] = Array.from(clusterMap.entries()).map(([key, replicas]) => {
    const [ns, name] = key.split('/');
    const primary = replicas.find((r) => r.cnpgRole === 'primary') ?? null;
    return {
      key, clusterNamespace: ns, clusterName: name, replicas, primary,
      snapshotCount: replicas.reduce((s, r) => s + r.snapshotCount, 0),
      snapshotBytesTotal: replicas.reduce((s, r) => s + r.snapshotBytesTotal, 0),
      volumeSizeBytes: (primary ?? replicas[0]).volumeSizeBytes,
      newestSnapshotAt: replicas.map((r) => r.newestSnapshotAt).filter((s): s is string => Boolean(s)).sort().pop() ?? null,
      degraded: replicas.some((r) => r.degraded),
      recurringJobs: Array.from(new Set(replicas.flatMap((r) => r.recurringJobs))).sort(),
    };
  });
  const toggleCluster = (k: string): void => {
    setExpandedClusters((prev) => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  };
  const totalRows = groups.length + standalone.length;

  return (
    <section className="space-y-3" data-testid="system-snapshots-section">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">System Snapshots</h2>
        {!isLoading && (
          <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600 dark:bg-gray-700 dark:text-gray-300">
            {totalRows} workload(s)
          </span>
        )}
      </div>
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Platform-managed PVCs. CNPG clusters collapse to one row — click ▶ to drill into per-replica PVCs.
      </p>

      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <Loader2 size={14} className="animate-spin" /> Loading system PVCs…
        </div>
      )}
      {error && (
        <p className="text-sm text-red-600 dark:text-red-400">{(error as Error).message}</p>
      )}

      {!isLoading && !error && totalRows === 0 && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-5 py-6 text-center text-sm text-gray-500 dark:text-gray-400">
          No platform/system PVCs detected.
        </div>
      )}

      {totalRows > 0 && (
        <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700 text-sm" data-testid="system-snapshots-table">
            <thead className="bg-gray-50 dark:bg-gray-900 text-xs uppercase text-gray-500 dark:text-gray-400">
              <tr>
                <th className="px-4 py-2 text-left">Workload</th>
                <th className="px-4 py-2 text-left">Volume size</th>
                <th className="px-4 py-2 text-right">Snapshots</th>
                <th className="px-4 py-2 text-right">Total size</th>
                <th className="px-4 py-2 text-left">Newest</th>
                <th className="px-4 py-2 text-left">Schedule</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {/* CNPG cluster groups */}
              {groups.map((g) => {
                const isExpanded = expandedClusters.has(g.key);
                return (
                  <Fragment key={g.key}>
                    <tr
                      className="cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50"
                      data-testid={`system-snapshots-cluster-${g.key}`}
                      onClick={() => g.primary && setOpenVolume(g.primary)}
                    >
                      <td className="px-4 py-2.5">
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); toggleCluster(g.key); }}
                          className="mr-2 inline-flex h-4 w-4 items-center justify-center rounded text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700"
                          aria-label={isExpanded ? 'Collapse' : 'Expand'}
                          data-testid={`expand-cluster-${g.key}`}
                        >
                          {isExpanded ? '▼' : '▶'}
                        </button>
                        <span className="font-medium text-gray-900 dark:text-gray-100">{g.clusterNamespace}/{g.clusterName}</span>
                        <span className="ml-2 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
                          CNPG · {g.replicas.length} replica{g.replicas.length === 1 ? '' : 's'}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 tabular-nums text-gray-700 dark:text-gray-300">{formatBytes(g.volumeSizeBytes)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{g.snapshotCount}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{formatBytes(g.snapshotBytesTotal)}</td>
                      <td className="px-4 py-2.5 text-gray-500 dark:text-gray-400 text-xs">
                        {g.newestSnapshotAt ? new Date(g.newestSnapshotAt).toISOString().slice(0, 16).replace('T', ' ') : '—'}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-gray-500 dark:text-gray-400">
                        {g.recurringJobs.length > 0 ? g.recurringJobs.join(', ') : <span className="italic">none</span>}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {g.degraded && (
                          <span className="inline-flex items-center gap-1 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:bg-red-900/40 dark:text-red-300" title="At least one replica is degraded">
                            <AlertTriangle size={10} /> degraded
                          </span>
                        )}
                      </td>
                    </tr>
                    {isExpanded && g.replicas.map((r) => (
                      <tr
                        key={r.longhornVolumeName}
                        onClick={() => setOpenVolume(r)}
                        className="cursor-pointer bg-gray-50/50 hover:bg-gray-100 dark:bg-gray-900/20 dark:hover:bg-gray-700/50"
                        data-testid={`system-snapshots-replica-${r.longhornVolumeName}`}
                      >
                        <td className="px-4 py-2 pl-10">
                          <div className="text-sm text-gray-700 dark:text-gray-300">
                            ↳ {r.pvcName}
                            {r.cnpgRole === 'primary' && (
                              <span className="ml-2 rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-800 dark:bg-green-900/40 dark:text-green-300">primary</span>
                            )}
                            {r.cnpgRole === 'replica' && (
                              <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600 dark:bg-gray-700 dark:text-gray-300">replica</span>
                            )}
                          </div>
                          <div className="text-[11px] font-mono text-gray-500 dark:text-gray-400">{r.longhornVolumeName}</div>
                        </td>
                        <td className="px-4 py-2 tabular-nums text-gray-700 dark:text-gray-300">{formatBytes(r.volumeSizeBytes)}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{r.snapshotCount}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{formatBytes(r.snapshotBytesTotal)}</td>
                        <td className="px-4 py-2 text-gray-500 dark:text-gray-400 text-xs">
                          {r.newestSnapshotAt ? new Date(r.newestSnapshotAt).toISOString().slice(0, 16).replace('T', ' ') : '—'}
                        </td>
                        <td className="px-4 py-2 text-xs text-gray-500 dark:text-gray-400">
                          {r.recurringJobs.length > 0 ? r.recurringJobs.join(', ') : <span className="italic text-amber-600 dark:text-amber-400">none (replica)</span>}
                        </td>
                        <td className="px-4 py-2 text-right">
                          {r.degraded && (
                            <span className="inline-flex items-center gap-1 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:bg-red-900/40 dark:text-red-300" title="Volume robustness=degraded">
                              <AlertTriangle size={10} /> degraded
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                );
              })}

              {/* Standalone PVCs (not CNPG) */}
              {standalone.map((v) => (
                <tr
                  key={v.longhornVolumeName}
                  onClick={() => setOpenVolume(v)}
                  className="cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50"
                  data-testid={`system-snapshots-row-${v.longhornVolumeName}`}
                >
                  <td className="px-4 py-2.5">
                    <div className="font-medium text-gray-900 dark:text-gray-100">{v.namespace}/{v.pvcName}</div>
                    <div className="text-[11px] font-mono text-gray-500 dark:text-gray-400">{v.longhornVolumeName}</div>
                  </td>
                  <td className="px-4 py-2.5 tabular-nums text-gray-700 dark:text-gray-300">{formatBytes(v.volumeSizeBytes)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{v.snapshotCount}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{formatBytes(v.snapshotBytesTotal)}</td>
                  <td className="px-4 py-2.5 text-gray-500 dark:text-gray-400 text-xs">
                    {v.newestSnapshotAt ? new Date(v.newestSnapshotAt).toISOString().slice(0, 16).replace('T', ' ') : '—'}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-gray-500 dark:text-gray-400">
                    {v.recurringJobs.length > 0 ? v.recurringJobs.join(', ') : <span className="italic">none</span>}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {v.degraded && (
                      <span className="inline-flex items-center gap-1 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:bg-red-900/40 dark:text-red-300" title="Volume robustness=degraded">
                        <AlertTriangle size={10} /> degraded
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {openVolume && <SystemSnapshotsModal volume={openVolume} onClose={() => setOpenVolume(null)} />}
    </section>
  );
}

export default SystemSnapshotsSection;
