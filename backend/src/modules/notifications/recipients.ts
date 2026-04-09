/**
 * Phase 3 of client-panel email parity round 2: notification
 * recipient helpers.
 *
 * When a backend event needs to fan out to "the client", we notify
 * every user with the `client_admin` role for that client. The
 * platform's own staff (super_admin etc.) are handled separately via
 * the eol-scanner adminUserId pattern.
 *
 * Keeping this in a tiny dedicated module means call-sites don't each
 * re-implement the same SELECT, and tests can mock a single spot.
 */

import { and, eq } from 'drizzle-orm';
import { users } from '../../db/schema.js';
import type { Database } from '../../db/index.js';

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
