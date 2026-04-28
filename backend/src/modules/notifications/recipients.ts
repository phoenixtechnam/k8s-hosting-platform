/**
 * Notification recipient resolution.
 *
 * Two-axis design (channel = HOW, scope = WHO). This module owns the
 * scope resolution; channels live in ./channels/. A typed discriminated
 * union (RecipientScope) lets event helpers describe their audience
 * without each helper re-implementing the SELECT statement.
 *
 * Adding a new scope kind: extend RecipientScope, add a case in
 * resolveRecipients, write a test in recipients.test.ts.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { users } from '../../db/schema.js';
import type { Database } from '../../db/index.js';

/**
 * Roles that have access to the admin panel. Admin-scope notifications
 * default to the highest-privilege subset (super_admin + admin) —
 * support and read-only roles can opt in via `RecipientScope.kind =
 * 'admin_role'` with an explicit role list when finer targeting is
 * needed (e.g. billing alerts only to billing role).
 */
// Match the DB role_name enum exactly (underscore, not hyphen — confirmed
// against backend/src/db/seed.ts and schema.ts). Type-checking against this
// list ensures resolveRecipients calls compile only with valid DB values.
export type AdminRole = 'super_admin' | 'admin' | 'billing' | 'support' | 'read_only';

const DEFAULT_ADMIN_ROLES: ReadonlyArray<AdminRole> = ['super_admin', 'admin'];

/**
 * Discriminated union describing WHO should receive a notification.
 *
 *   admin        — every panel='admin' user with role super_admin or admin
 *   admin_role   — every panel='admin' user whose role is in the given list
 *   client       — every client_admin user of the given client
 *   user         — exactly one user
 */
export type RecipientScope =
  | { readonly kind: 'admin' }
  | { readonly kind: 'admin_role'; readonly roles: ReadonlyArray<AdminRole> }
  | { readonly kind: 'client'; readonly clientId: string }
  | { readonly kind: 'user'; readonly userId: string };

/**
 * Resolve a RecipientScope to a concrete list of distinct user IDs.
 * Returns an empty array when the scope matches no users (callers
 * decide whether that's fatal or a silent skip).
 */
export async function resolveRecipients(
  db: Database,
  scope: RecipientScope,
): Promise<readonly string[]> {
  switch (scope.kind) {
    case 'admin':
      return getAdminRecipients(db, DEFAULT_ADMIN_ROLES);
    case 'admin_role':
      return getAdminRecipients(db, scope.roles);
    case 'client':
      return getClientNotificationRecipients(db, scope.clientId);
    case 'user':
      return [scope.userId];
  }
}

/**
 * Return the distinct user IDs for all client_admin users of a given
 * client. Used by notifyUser fan-out for any "the client needs to
 * know" event (mailbox limit reached, DKIM rotated, IMAPSync done,
 * email bootstrapped, etc.).
 *
 * Returns an empty array rather than throwing when the client has no
 * admins — callers should decide whether to fall back to platform
 * admins or silently skip.
 */
export async function getClientNotificationRecipients(
  db: Database,
  clientId: string,
): Promise<readonly string[]> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.clientId, clientId), eq(users.roleName, 'client_admin')));

  const seen = new Set<string>();
  for (const row of rows) {
    if (row.id) seen.add(row.id);
  }
  return Array.from(seen);
}

/**
 * Return the distinct user IDs for every admin-panel user whose role
 * is in the provided list. Used by event helpers that need to alert
 * platform staff (DR backup failures, certificate expiry warnings,
 * cluster-health degradation).
 *
 * The roles parameter is required (no implicit default) so that
 * call-sites are explicit about which admin tiers they're paging.
 */
export async function getAdminRecipients(
  db: Database,
  roles: ReadonlyArray<AdminRole>,
): Promise<readonly string[]> {
  if (roles.length === 0) return [];
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.panel, 'admin'), inArray(users.roleName, roles as AdminRole[])));

  const seen = new Set<string>();
  for (const row of rows) {
    if (row.id) seen.add(row.id);
  }
  return Array.from(seen);
}
