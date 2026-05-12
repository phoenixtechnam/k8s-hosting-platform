import { AlertTriangle, Info, Pin } from 'lucide-react';
import { useResourceBreakdown } from '@/hooks/use-deployments';

interface ResourceBreakdownProps {
  readonly clientId: string;
  readonly deploymentId: string;
}

/**
 * ADR-037 surface: shows how the deployment-level CPU/memory budget is
 * split across the app's components. Renders as a compact table:
 *
 *   web    weight 50    450m CPU    450Mi memory
 *   db     weight 35    330m CPU    332Mi memory
 *   ...
 *
 * Pinned components (Jobs, hard-coded resources) render with a pin icon
 * and a tooltip explaining they don't share the budget.
 */
export function ResourceBreakdown({ clientId, deploymentId }: ResourceBreakdownProps) {
  const { data, isLoading, isError, error } = useResourceBreakdown(clientId, deploymentId);

  if (isLoading) {
    return <div className="text-xs text-gray-400 dark:text-gray-500">Loading breakdown…</div>;
  }

  if (isError) {
    const msg = error instanceof Error ? error.message : 'Failed to load breakdown';
    return <div className="text-xs text-red-500 dark:text-red-400">{msg}</div>;
  }

  if (!data?.data) return null;

  const breakdown = data.data;

  if (breakdown.components.length <= 1) {
    // Single-component apps don't need a breakdown — the deployment total
    // IS the component's allocation. Hide the panel entirely.
    return null;
  }

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 p-3">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-xs font-semibold text-gray-700 dark:text-gray-300">
          Per-component allocation
        </h4>
        <span
          className="text-[10px] text-gray-400 dark:text-gray-500"
          title="CPU bursts beyond the baseline when neighbours are idle; memory is guaranteed at the declared value."
        >
          CPU burstable · Memory guaranteed
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-gray-500 dark:text-gray-400">
              <th className="pb-1 pr-2 font-normal">Component</th>
              <th className="pb-1 px-2 font-normal text-right">Weight</th>
              <th className="pb-1 px-2 font-normal text-right">CPU baseline</th>
              <th className="pb-1 pl-2 font-normal text-right">Memory</th>
            </tr>
          </thead>
          <tbody>
            {breakdown.components.map((c) => (
              <tr
                key={c.name}
                className="border-t border-gray-200 dark:border-gray-700/50 text-gray-700 dark:text-gray-300"
              >
                <td className="py-1 pr-2 font-mono flex items-center gap-1">
                  {c.pinned && (
                    <Pin
                      size={10}
                      className="text-gray-400"
                    />
                  )}
                  <span title={c.pinned ? 'Hard-pinned — does not share the deployment budget' : undefined}>
                    {c.name}
                  </span>
                </td>
                <td className="py-1 px-2 text-right text-gray-500 dark:text-gray-400">
                  {c.pinned ? '—' : (c.weight ?? 'even')}
                </td>
                <td className="py-1 px-2 text-right font-mono">{c.cpu}</td>
                <td className="py-1 pl-2 text-right font-mono">{c.memory}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 font-medium">
              <td className="pt-1 pr-2">Total</td>
              <td className="pt-1 px-2"></td>
              <td className="pt-1 px-2 text-right font-mono">{breakdown.total.cpu}</td>
              <td className="pt-1 pl-2 text-right font-mono">{breakdown.total.memory}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {breakdown.warnings.length > 0 && (
        <div className="mt-2 flex items-start gap-1.5 rounded-md bg-amber-50 dark:bg-amber-900/20 px-2 py-1.5">
          <AlertTriangle
            size={12}
            className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400"
          />
          <ul className="space-y-0.5 text-[11px] text-amber-700 dark:text-amber-300">
            {breakdown.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <p className="mt-2 flex items-start gap-1 text-[10px] text-gray-400 dark:text-gray-500">
        <Info size={10} className="mt-0.5 shrink-0" />
        <span>
          Components share the deployment&apos;s CPU/memory budget by weight, with a per-component minimum floor.
          CPU may burst above the baseline; memory is guaranteed at the declared value.
        </span>
      </p>
    </div>
  );
}
