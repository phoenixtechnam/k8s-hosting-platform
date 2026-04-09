/**
 * Phase 3 T5.3 — mailbox quota threshold notifications.
 *
 * Runs after each mail-stats reconciler cycle (every 15 min by
 * default). Walks all mailboxes whose used_mb crosses 80%, 90%,
 * or 100% of their quota and fires exactly one notification per
 * (mailbox, threshold) pair.
 *
 * Dedupe via mailbox_quota_events. The (mailbox_id, threshold)
 * primary key + ON CONFLICT DO NOTHING insert is the dedupe
 * mechanism — concurrent reconciler instances are safe because
 * exactly one INSERT will succeed.
 *
 * Hysteresis: when usage drops below (threshold - 5)% the event
 * row is cleared, so a flapping mailbox doesn't re-fire on every
 * cycle.
 */

import { sql } from 'drizzle-orm';
import { notifyUser } from '../notifications/service.js';
import type { Database } from '../../db/index.js';

const THRESHOLDS = [80, 90, 100] as const;
type Threshold = (typeof THRESHOLDS)[number];

interface MailboxRow extends Record<string, unknown> {
  mailbox_id: string;
  client_id: string;
  full_address: string;
  quota_mb: number;
  used_mb: number;
  recipient_user_ids: readonly string[];
}

interface ClearableRow extends Record<string, unknown> {
  mailbox_id: string;
  threshold: number;
  used_mb: number;
  quota_mb: number;
}

function thresholdsCrossed(usedMb: number, quotaMb: number): readonly Threshold[] {
  if (quotaMb <= 0) return [];
  const pct = (usedMb / quotaMb) * 100;
  const crossed: Threshold[] = [];
  for (const t of THRESHOLDS) {
    if (pct >= t) crossed.push(t);
  }
  return crossed;
}

function buildMessage(address: string, threshold: Threshold, usedMb: number, quotaMb: number): string {
  return `Mailbox ${address} has used ${usedMb} MB of its ${quotaMb} MB quota (${threshold}% or above). Please clear messages or request a quota increase.`;
}

function buildTitle(threshold: Threshold): string {
  if (threshold === 100) return 'Mailbox quota: 100% full';
  return `Mailbox quota: ${threshold}% reached`;
}

function notificationType(threshold: Threshold): 'warning' | 'error' {
  return threshold === 100 ? 'error' : 'warning';
}

/**
 * Walk all mailboxes ≥ 75% of quota and fire notifications for any
 * newly-crossed thresholds. Returns counts for logging.
 */
export async function checkQuotaThresholds(
  db: Database,
): Promise<{ fired: number; cleared: number; skipped: number }> {
  // Find candidate mailboxes (≥ 75 % so the 80 hysteresis works
  // cleanly). Include the recipient user list via a correlated
  // aggregate over mailbox_access.
  const candidates = await db.execute<MailboxRow>(sql`
    SELECT
      m.id          AS mailbox_id,
      m.client_id   AS client_id,
      m.full_address AS full_address,
      m.quota_mb    AS quota_mb,
      m.used_mb     AS used_mb,
      COALESCE(
        ARRAY(
          SELECT ma.user_id
            FROM mailbox_access ma
           WHERE ma.mailbox_id = m.id
        ),
        ARRAY[]::varchar[]
      ) AS recipient_user_ids
    FROM mailboxes m
    WHERE m.status = 'active'
      AND m.quota_mb > 0
      AND (m.used_mb::numeric / m.quota_mb::numeric) * 100 >= 75
  `);

  let fired = 0;
  let skipped = 0;

  for (const row of candidates.rows ?? []) {
    if (!row.recipient_user_ids || row.recipient_user_ids.length === 0) {
      // Nobody to notify — log it as skipped so the operator can
      // investigate. (We could also default to the platform admin
      // here; left as a follow-up.)
      skipped += 1;
      continue;
    }

    for (const threshold of thresholdsCrossed(row.used_mb, row.quota_mb)) {
      // Try to claim the (mailbox_id, threshold) row. The dedupe
      // semantics are:
      //
      //   1. No existing row              → INSERT, return row, fire
      //   2. Existing row, cleared_at NULL → conflict, RETURNING
      //      gives nothing → skip (already firing this cycle)
      //   3. Existing row, cleared_at NOT NULL (re-arm) → UPDATE
      //      sets cleared_at back to NULL, bumps first_seen_at,
      //      RETURNING gives the row → fire
      //
      // The WHERE clause on the DO UPDATE ensures only the re-arm
      // case writes; the still-firing case stays no-op.
      // RETURNING xmax = 0 lets us tell INSERT from UPDATE so we
      // can fire on both. (Postgres-specific.)
      const inserted = await db.execute<{ mailbox_id: string }>(sql`
        INSERT INTO mailbox_quota_events (mailbox_id, threshold)
        VALUES (${row.mailbox_id}, ${threshold})
        ON CONFLICT (mailbox_id, threshold) DO UPDATE
          SET first_seen_at = NOW(),
              cleared_at = NULL,
              notification_id = NULL
          WHERE mailbox_quota_events.cleared_at IS NOT NULL
        RETURNING mailbox_id
      `);

      if ((inserted.rows ?? []).length === 0) {
        // Already firing this threshold (cleared_at IS NULL) — skip.
        continue;
      }

      // Fan out to all recipients via notifyUser, which also fires
      // an email through sendNotificationEmail when
      // OIDC_ENCRYPTION_KEY is configured (see notifications/service.ts).
      // notifyUser is already fire-and-forget and swallows errors,
      // so one flaky SMTP send cannot starve the loop.
      for (const userId of row.recipient_user_ids) {
        await notifyUser(db, userId, {
          type: notificationType(threshold),
          title: buildTitle(threshold),
          message: buildMessage(row.full_address, threshold, row.used_mb, row.quota_mb),
          resourceType: 'mailbox',
          resourceId: row.mailbox_id,
        });
        fired += 1;
      }
    }
  }

  // Clear (re-arm) events whose mailbox usage has dropped below
  // (threshold - 5)% — hysteresis to prevent flapping.
  //
  // Two-step: first set cleared_at on the matching open events
  // (preserves audit history of when the threshold was first hit
  // and when it was cleared), then delete rows that have been
  // cleared for more than 30 days so the table doesn't grow
  // unbounded over the lifetime of the platform.
  const clearResult = await db.execute<{ mailbox_id: string }>(sql`
    UPDATE mailbox_quota_events e
       SET cleared_at = NOW()
      FROM mailboxes m
     WHERE m.id = e.mailbox_id
       AND e.cleared_at IS NULL
       AND m.quota_mb > 0
       AND (m.used_mb::numeric / m.quota_mb::numeric) * 100 < (e.threshold - 5)
    RETURNING e.mailbox_id
  `);
  const cleared = (clearResult.rows ?? []).length;

  // Garbage-collect rows that have been cleared for > 30 days.
  // The dedupe logic only cares about NULL cleared_at, so old
  // rows are pure noise. Wrapped in its own try so a GC failure
  // doesn't break the main quota path.
  try {
    await db.execute(sql`
      DELETE FROM mailbox_quota_events
       WHERE cleared_at IS NOT NULL
         AND cleared_at < NOW() - INTERVAL '30 days'
    `);
  } catch (err) {
    console.warn(
      '[mail-stats:quota] gc of cleared events failed:',
      err instanceof Error ? err.message : String(err),
    );
  }

  return { fired, cleared, skipped };
}
