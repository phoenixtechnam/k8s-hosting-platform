/**
 * ActiveSessionsPanel — list of active refresh-token sessions for a
 * single user with per-row revoke + bulk revoke.
 *
 * Self-lockout protection: the panel calls /auth/me/sessions to learn
 * the caller's OWN currentSessionId. When the selected user is the
 * caller AND a row matches currentSessionId, the row's [Revoke]
 * button is replaced with a "current — cannot revoke" badge. This
 * prevents the operator from killing the session in the open tab.
 * Bulk revoke surfaces a confirm-dialog count that EXCLUDES the
 * current session and warns the operator before proceeding.
 */
import { useState } from 'react';
import { Trash2, AlertTriangle, Monitor, RefreshCw } from 'lucide-react';
import {
  useBulkRevokeSessions,
  useMeSessions,
  useRevokeSession,
  useUserSessions,
  type ActiveSession,
} from '@/hooks/use-admin-sessions';

export interface ActiveSessionsPanelProps {
  readonly userId: string;
  readonly userEmail: string;
  /** When true, this user is the current operator — enables the
   *  self-lockout guard against revoking the current session. */
  readonly isSelf: boolean;
  /** Caller's role. Revoke buttons are only rendered for
   *  `super_admin` because the backend enforces that role on the
   *  DELETE routes — an `admin`-role operator pressing Revoke would
   *  get a 403. Hide the affordance instead of surfacing a failure. */
  readonly callerRole: string | null;
}

export default function ActiveSessionsPanel({
  userId,
  userEmail,
  isSelf,
  callerRole,
}: ActiveSessionsPanelProps) {
  const canRevoke = callerRole === 'super_admin';
  const { data: sessions, isLoading, error, refetch, isFetching } = useUserSessions(userId);
  const { data: meSessions } = useMeSessions();
  const revokeOne = useRevokeSession(userId);
  const revokeAll = useBulkRevokeSessions(userId);
  const [confirmBulk, setConfirmBulk] = useState(false);

  const currentSessionId = isSelf ? meSessions?.currentSessionId ?? null : null;

  const sessionCount = sessions?.length ?? 0;
  const revocableCount = sessions?.filter((s) => s.id !== currentSessionId).length ?? 0;

  const onRevoke = (s: ActiveSession): void => {
    if (!confirm(`Revoke session from ${s.ipAddress ?? 'unknown IP'} (last used ${s.lastUsedAt ?? 'never'})?`)) {
      return;
    }
    revokeOne.mutate(s.id, {
      onError: (err) => alert(`Revoke failed: ${err instanceof Error ? err.message : String(err)}`),
    });
  };

  const onBulkRevoke = (): void => {
    if (revocableCount === 0) return;
    const message = isSelf
      ? `Revoke ${revocableCount} other session(s) for ${userEmail}? Your current session in this tab will be preserved.`
      : `Revoke ALL ${sessionCount} active session(s) for ${userEmail}? They will be signed out everywhere.`;
    if (!confirm(message)) return;
    revokeAll.mutate(undefined, {
      onError: (err) => alert(`Bulk revoke failed: ${err instanceof Error ? err.message : String(err)}`),
      onSuccess: () => setConfirmBulk(false),
    });
  };

  return (
    <div
      className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 space-y-3"
      data-testid="active-sessions-panel"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
            <Monitor size={16} className="text-brand-500" />
            Active sessions for <code className="text-xs">{userEmail}</code>
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            One row per active refresh token. Revoking signs that browser/device out
            on its next request — within ~30 minutes (the access-JWT TTL) the user is fully evicted.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => refetch()}
            disabled={isFetching}
            className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-200"
            title="Refresh"
          >
            <RefreshCw size={14} className={isFetching ? 'animate-spin' : ''} />
          </button>
          {sessionCount > 0 && canRevoke && (
            <button
              type="button"
              onClick={onBulkRevoke}
              disabled={revokeAll.isPending || revocableCount === 0}
              className="inline-flex items-center gap-1 rounded-md border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/30 px-2 py-1 text-xs text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/50 disabled:opacity-50"
              data-testid="bulk-revoke-sessions"
            >
              <Trash2 size={12} />
              Revoke {isSelf ? `${revocableCount} other` : `all ${sessionCount}`}
            </button>
          )}
        </div>
      </div>

      {isLoading && <div className="text-xs text-gray-500 dark:text-gray-400">Loading…</div>}
      {error && (
        <div className="text-xs text-red-600 dark:text-red-400">
          Load failed: {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      {sessions && sessions.length === 0 && (
        <div className="text-xs text-gray-500 dark:text-gray-400 italic">No active sessions.</div>
      )}

      {sessions && sessions.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs" data-testid="active-sessions-table">
            <thead>
              <tr className="text-left text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                <th className="py-2 pr-3">Issued</th>
                <th className="py-2 pr-3">Last used</th>
                <th className="py-2 pr-3">Expires</th>
                <th className="py-2 pr-3">IP</th>
                <th className="py-2 pr-3">Panel</th>
                <th className="py-2 pr-3">User agent</th>
                <th className="py-2 pr-3 text-right"></th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => {
                const isCurrent = s.id === currentSessionId;
                return (
                  <tr
                    key={s.id}
                    className="border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/50"
                    data-testid={`session-row-${s.id}`}
                  >
                    <td className="py-2 pr-3 text-gray-700 dark:text-gray-300 whitespace-nowrap">
                      {new Date(s.issuedAt).toLocaleString()}
                    </td>
                    <td className="py-2 pr-3 text-gray-700 dark:text-gray-300 whitespace-nowrap">
                      {s.lastUsedAt ? new Date(s.lastUsedAt).toLocaleString() : <span className="opacity-50">—</span>}
                    </td>
                    <td className="py-2 pr-3 text-gray-700 dark:text-gray-300 whitespace-nowrap">
                      {new Date(s.expiresAt).toLocaleString()}
                    </td>
                    <td className="py-2 pr-3 font-mono text-gray-700 dark:text-gray-300">{s.ipAddress ?? '—'}</td>
                    <td className="py-2 pr-3">
                      <span className="inline-block rounded bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 text-[10px] text-gray-700 dark:text-gray-300">
                        {s.panel}
                      </span>
                    </td>
                    <td className="py-2 pr-3 text-gray-600 dark:text-gray-400 max-w-xs truncate" title={s.userAgent ?? ''}>
                      {s.userAgent ?? '—'}
                    </td>
                    <td className="py-2 pr-3 text-right">
                      {isCurrent ? (
                        <span className="inline-flex items-center gap-1 text-[10px] text-amber-700 dark:text-amber-300 italic">
                          <AlertTriangle size={10} /> current (this tab)
                        </span>
                      ) : canRevoke ? (
                        <button
                          type="button"
                          onClick={() => onRevoke(s)}
                          disabled={revokeOne.isPending}
                          className="inline-flex items-center gap-1 rounded border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/30 px-2 py-1 text-[11px] text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/50 disabled:opacity-50"
                          data-testid={`revoke-session-${s.id}`}
                        >
                          <Trash2 size={10} /> Revoke
                        </button>
                      ) : (
                        <span className="text-[10px] text-gray-400 dark:text-gray-500 italic" title="Requires super_admin role">
                          read-only
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
