/**
 * Phase 1 of client-panel email parity round 2: plan-based mailbox
 * limit helpers.
 *
 * The platform caps the total number of mailboxes a client can
 * create via their hosting plan (hosting_plans.max_mailboxes),
 * with an optional per-client override
 * (clients.max_mailboxes_override).
 *
 *   null or <= 0 override → inherit from plan
 *   numeric override > 0  → use override (may be higher or lower)
 *
 * `getClientMailboxCount` sums mailboxes across ALL the client's
 * email domains — not per-domain — so a client with 3 domains and
 * 10 mailboxes each hits the 25 cap at total=25, not per-domain.
 */

import { eq, sql } from 'drizzle-orm';
import { clients, hostingPlans, mailboxes } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import type { Database } from '../../db/index.js';

export type MailboxLimitSource = 'plan' | 'client_override';

export interface EffectiveMailboxLimit {
  readonly limit: number;
  readonly source: MailboxLimitSource;
}

export interface ComputeLimitInput {
  readonly planLimit: number;
  readonly override: number | null;
}

/**
 * Pure function — decide the effective mailbox limit given the
 * plan limit and an optional per-client override. Zero, negative,
 * and null overrides fall through to the plan limit.
 */
export function computeClientMailboxLimit(input: ComputeLimitInput): EffectiveMailboxLimit {
  if (typeof input.override === 'number' && input.override > 0) {
    return { limit: input.override, source: 'client_override' };
  }
  return { limit: input.planLimit, source: 'plan' };
}

/**
 * Count mailboxes for a client across ALL their email domains.
 * Uses a direct filter on mailboxes.client_id (denormalized into
 * the mailboxes table at creation time) so we avoid joining
 * through email_domains.
 */
export async function getClientMailboxCount(
  db: Database,
  clientId: string,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(mailboxes)
    .where(eq(mailboxes.clientId, clientId));
  return Number(row?.count ?? 0);
}

/**
 * Fetch the plan + override for a client and compute the
 * effective limit. Throws CLIENT_NOT_FOUND if the client row
 * doesn't exist.
 */
export async function getClientMailboxLimit(
  db: Database,
  clientId: string,
): Promise<EffectiveMailboxLimit> {
  const [row] = await db
    .select({
      planLimit: hostingPlans.maxMailboxes,
      override: clients.maxMailboxesOverride,
    })
    .from(clients)
    .innerJoin(hostingPlans, eq(clients.planId, hostingPlans.id))
    .where(eq(clients.id, clientId));
  if (!row) {
    throw new ApiError('CLIENT_NOT_FOUND', `Client '${clientId}' not found`, 404);
  }
  return computeClientMailboxLimit({
    planLimit: row.planLimit,
    override: row.override,
  });
}
