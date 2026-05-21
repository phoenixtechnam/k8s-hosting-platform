/**
 * NodeTerminalSessionsPanel — cross-node active terminal sessions
 * with terminate-from-elsewhere. Backend endpoints already exist:
 *   GET    /admin/node-terminal/sessions
 *   DELETE /admin/nodes/:nodeName/terminal/sessions/:sessionId
 *
 * The terminate button kills the session on whichever pod is hosting
 * it — operator doesn't need to know which node-terminal modal in
 * which browser opened it. Useful for stale-session cleanup after
 * a Pod restart / replica rebalance.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2, RefreshCw, Terminal } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';

interface NodeTerminalSession {
  readonly sessionId: string;
  readonly nodeName: string;
  readonly podName: string;
  readonly userId: string;
  readonly userEmail: string;
  readonly ownerReplica: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastActivityAt: string;
}

interface ListResp {
  readonly data: ReadonlyArray<NodeTerminalSession>;
}

const QUERY_KEY = ['node-terminal-sessions'] as const;

export default function NodeTerminalSessionsPanel() {
  const qc = useQueryClient();
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async (): Promise<ReadonlyArray<NodeTerminalSession>> => {
      const body = await apiFetch<ListResp>('/api/v1/admin/node-terminal/sessions');
      return body.data;
    },
    refetchInterval: 15_000,
  });

  const terminate = useMutation({
    mutationFn: (s: NodeTerminalSession) =>
      apiFetch(
        `/api/v1/admin/nodes/${encodeURIComponent(s.nodeName)}/terminal/sessions/${encodeURIComponent(s.sessionId)}`,
        { method: 'DELETE' },
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: QUERY_KEY }),
  });

  const sessions = data ?? [];

  const onTerminate = (s: NodeTerminalSession): void => {
    if (!confirm(
      `Terminate terminal session for ${s.userEmail} on ${s.nodeName} (pod ${s.podName})?\n\nThis closes the session immediately; the operator may need to reopen if they were mid-task.`,
    )) return;
    terminate.mutate(s, {
      onError: (err) => alert(`Terminate failed: ${err instanceof Error ? err.message : String(err)}`),
    });
  };

  return (
    <div
      className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 space-y-3"
      data-testid="node-terminal-sessions-panel"
    >
      <div className="flex items-center justify-between">
        <p className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-2">
          <Terminal size={12} />
          Live across the cluster — node-terminal sessions ({sessions.length}).
        </p>
        <button
          type="button"
          onClick={() => refetch()}
          disabled={isFetching}
          className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-200"
          title="Refresh"
        >
          <RefreshCw size={14} className={isFetching ? 'animate-spin' : ''} />
        </button>
      </div>

      {isLoading && <div className="text-xs text-gray-500 dark:text-gray-400">Loading…</div>}
      {error && (
        <div className="text-xs text-red-600 dark:text-red-400">
          Load failed: {error instanceof Error ? error.message : String(error)}
        </div>
      )}
      {!isLoading && sessions.length === 0 && (
        <div className="text-xs text-gray-500 dark:text-gray-400 italic">
          No active node-terminal sessions.
        </div>
      )}

      {sessions.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                <th className="py-2 pr-3">User</th>
                <th className="py-2 pr-3">Node</th>
                <th className="py-2 pr-3">Pod</th>
                <th className="py-2 pr-3">Owner replica</th>
                <th className="py-2 pr-3">Opened</th>
                <th className="py-2 pr-3">Last activity</th>
                <th className="py-2 pr-3 text-right"></th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr
                  key={s.sessionId}
                  className="border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/50"
                >
                  <td className="py-2 pr-3 text-gray-700 dark:text-gray-300">{s.userEmail}</td>
                  <td className="py-2 pr-3 font-mono text-gray-700 dark:text-gray-300">{s.nodeName}</td>
                  <td className="py-2 pr-3 font-mono text-gray-600 dark:text-gray-400 max-w-xs truncate" title={s.podName}>
                    {s.podName}
                  </td>
                  <td className="py-2 pr-3 font-mono text-gray-600 dark:text-gray-400">{s.ownerReplica}</td>
                  <td className="py-2 pr-3 text-gray-600 dark:text-gray-400">
                    {new Date(s.createdAt).toLocaleString()}
                  </td>
                  <td className="py-2 pr-3 text-gray-600 dark:text-gray-400">
                    {new Date(s.lastActivityAt).toLocaleString()}
                  </td>
                  <td className="py-2 pr-3 text-right">
                    <button
                      type="button"
                      onClick={() => onTerminate(s)}
                      disabled={terminate.isPending}
                      className="inline-flex items-center gap-1 rounded border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/30 px-2 py-1 text-[11px] text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/50 disabled:opacity-50"
                      data-testid={`terminate-${s.sessionId}`}
                    >
                      <Trash2 size={10} /> Terminate
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
