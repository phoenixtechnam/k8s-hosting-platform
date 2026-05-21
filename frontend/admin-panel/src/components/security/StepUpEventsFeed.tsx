/**
 * StepUpEventsFeed — filtered view of audit-log rows with
 * resourceType='step_up'. These are the only audit events for
 * password / passkey step-up challenges (success + failed), which
 * are the highest-signal anomaly source we collect (a brute-force
 * attempt against the step-up endpoint shows up here before any
 * compromise materialises).
 *
 * Read-only — drill-down is "View all in Audit Logs" link.
 */
import { Link } from 'react-router-dom';
import { CheckCircle2, XCircle, ExternalLink } from 'lucide-react';
import { useAuditLogs } from '@/hooks/use-audit-logs';

export default function StepUpEventsFeed() {
  const { data, isLoading, error } = useAuditLogs({ resource_type: 'step_up', limit: 50 });
  const items = data?.data ?? [];

  return (
    <div
      className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 space-y-3"
      data-testid="step-up-events-feed"
    >
      <div className="flex items-center justify-between">
        <p className="text-xs text-gray-500 dark:text-gray-400">
          <code>step_up.password.*</code> and <code>step_up.passkey.*</code> — last 50.
        </p>
        <Link
          to="/monitoring/audit-logs?resource_type=step_up"
          className="text-xs text-brand-600 dark:text-brand-400 hover:underline inline-flex items-center gap-1"
        >
          View all in Audit Logs <ExternalLink size={10} />
        </Link>
      </div>

      {isLoading && <div className="text-xs text-gray-500 dark:text-gray-400">Loading…</div>}
      {error && (
        <div className="text-xs text-red-600 dark:text-red-400">
          Load failed: {error instanceof Error ? error.message : String(error)}
        </div>
      )}
      {!isLoading && items.length === 0 && (
        <div className="text-xs text-gray-500 dark:text-gray-400 italic">
          No step-up events recorded.
        </div>
      )}

      {items.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs" data-testid="step-up-events-table">
            <thead>
              <tr className="text-left text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                <th className="py-2 pr-3">When</th>
                <th className="py-2 pr-3">Action</th>
                <th className="py-2 pr-3">Actor</th>
                <th className="py-2 pr-3">IP</th>
                <th className="py-2 pr-3">Result</th>
              </tr>
            </thead>
            <tbody>
              {items.map((e) => {
                const failed = e.actionType.endsWith('.failed');
                return (
                  <tr
                    key={e.id}
                    className="border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/50"
                  >
                    <td className="py-2 pr-3 text-gray-600 dark:text-gray-400 whitespace-nowrap">
                      {new Date(e.createdAt).toLocaleString()}
                    </td>
                    <td className="py-2 pr-3 font-mono text-gray-700 dark:text-gray-300">{e.actionType}</td>
                    <td className="py-2 pr-3 text-gray-700 dark:text-gray-300">{e.actorId}</td>
                    <td className="py-2 pr-3 font-mono text-gray-600 dark:text-gray-400">{e.ipAddress ?? '—'}</td>
                    <td className="py-2 pr-3">
                      {failed ? (
                        <span className="inline-flex items-center gap-1 text-red-700 dark:text-red-300">
                          <XCircle size={12} /> failed
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-green-700 dark:text-green-300">
                          <CheckCircle2 size={12} /> success
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
