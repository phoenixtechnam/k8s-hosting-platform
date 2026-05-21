/**
 * Identity & Sessions — Security Hub → Identity (2026-05-21).
 *
 * Combines four operator surfaces that previously didn't exist (or
 * existed but were unreachable):
 *
 *   1. Admin Users — the existing CRUD table, now embedded
 *   2. Active Sessions — refresh-token list with per-row revoke +
 *      bulk revoke for the user selected above (Phase 3a)
 *   3. Step-Up Events — filtered audit-log feed of
 *      step_up.{password,passkey}.{success,failed} events (Phase 3b)
 *   4. Node-Terminal Sessions — cross-node list of active terminal
 *      sessions with terminate-from-elsewhere (Phase 3c)
 *
 * The user-selection model: clicking a row in the Admin Users table
 * sets a `selectedUserId` that drives the Active Sessions panel. The
 * Step-Up + Node-Terminal panels are global views (no user filter)
 * because their primary use is incident-detection across all users.
 */
import { useMemo, useState } from 'react';
import { Activity, Monitor, UserCog } from 'lucide-react';
import AdminUsers from '@/pages/AdminUsers';
import ActiveSessionsPanel from '@/components/security/ActiveSessionsPanel';
import StepUpEventsFeed from '@/components/security/StepUpEventsFeed';
import NodeTerminalSessionsPanel from '@/components/security/NodeTerminalSessionsPanel';
import { useAdminUsers } from '@/hooks/use-admin-users';
import { useAuth } from '@/hooks/use-auth';

export default function IdentityAndSessionsPage() {
  const { data: usersResp } = useAdminUsers();
  const { user: me } = useAuth();
  const users = useMemo(() => usersResp?.data ?? [], [usersResp]);

  // Default selection: the current operator's own row so the first
  // thing the page shows is their own sessions. Falls back to the
  // first row in the list when self-selection isn't possible (e.g.
  // tenant-panel super_admin viewing).
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const effectiveSelectedId =
    selectedUserId
    ?? (me?.id && users.some((u) => u.id === me.id) ? me.id : null)
    ?? (users[0]?.id ?? null);
  const selectedUser = users.find((u) => u.id === effectiveSelectedId) ?? null;
  const isSelf = !!(me?.id && selectedUser?.id === me.id);

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <div className="flex items-center gap-3">
          <UserCog size={24} className="text-brand-600 dark:text-brand-400" />
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
            Identity &amp; Sessions
          </h1>
        </div>
        <p className="text-sm text-gray-600 dark:text-gray-400 max-w-3xl">
          Admin users with MFA / last-IP at a glance, plus refresh-token sessions, step-up
          challenges, and active node-terminal sessions. Use Active Sessions to revoke a
          stolen-laptop scenario; use Step-Up Events to spot brute-force attempts before
          they succeed.
        </p>
      </header>

      <section>
        <h2 className="sr-only">Admin users</h2>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
          Click a user row below to load their active sessions in the panel beneath.
          {selectedUser && (
            <>
              {' '}Currently selected: <code>{selectedUser.email}</code>
              {isSelf && <span className="ml-1 italic">(you)</span>}
            </>
          )}
        </p>
        <AdminUsers onSelectUser={setSelectedUserId} />
      </section>

      {effectiveSelectedId && selectedUser && (
        <section>
          <h2 className="sr-only">Active sessions</h2>
          <ActiveSessionsPanel
            userId={effectiveSelectedId}
            userEmail={selectedUser.email}
            isSelf={isSelf}
            callerRole={me?.role ?? null}
          />
        </section>
      )}

      <section>
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2 flex items-center gap-2">
          <Activity size={14} className="text-brand-500" />
          Step-Up Events (last 50)
        </h2>
        <StepUpEventsFeed />
      </section>

      <section>
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2 flex items-center gap-2">
          <Monitor size={14} className="text-brand-500" />
          Active Node-Terminal Sessions
        </h2>
        <NodeTerminalSessionsPanel />
      </section>
    </div>
  );
}
