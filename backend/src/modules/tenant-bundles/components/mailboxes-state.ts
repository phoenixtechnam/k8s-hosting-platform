/**
 * tenant_jmap_state persistence (Phase 2 of tenant-backup-v2 / ADR-036).
 *
 * Called by the orchestrator AFTER the restic snapshot for the
 * mailboxes component has been acknowledged. The orchestrator computes
 * the per-mailbox new state from jmap-sync.py's JSON summary line; this
 * helper does the UPSERT into `tenant_jmap_state` so the next
 * incremental run knows where to resume Email/changes from.
 *
 * At-least-once semantics:
 *   - If this UPSERT fails mid-batch, the next run uses the OLD state
 *     and re-pulls some messages. Restic content-dedups so the snapshot
 *     stays compact.
 *   - We do NOT roll the snapshot back on persist failure — restic is
 *     content-addressed, and dropping a snapshot would orphan the data
 *     on the off-site target.
 */

import { sql } from 'drizzle-orm';
import type { Database } from '../../../db/index.js';

export interface JmapStateUpdate {
  readonly address: string;
  readonly jmapId: string;
  readonly newState: string;
  readonly fetched: number;
  readonly skipped: number;
  readonly fullPull: boolean;
}

/**
 * UPSERT one row per mailbox. PK is `(client_id, mailbox_jmap_id)`.
 *
 * Notes on the `error_message` column:
 *   - cleared on every successful sync (fullPull=false, no skipped)
 *   - retained when `fullPull=true` (incremental couldn't be computed)
 *     so the admin "stale mailbox" surface knows the next run already
 *     re-pulled fresh
 *   - retained when `skipped > 0` so the admin sees individual-message
 *     fetch failures
 */
export async function persistJmapStates(
  db: Database,
  clientId: string,
  states: ReadonlyArray<JmapStateUpdate>,
): Promise<void> {
  if (states.length === 0) return;
  for (const s of states) {
    // Per-row UPSERT keeps each one independent — a row that violates
    // (e.g. mailbox_jmap_id too long) doesn't drop the whole batch.
    // The volume per client is small (<50 rows typical).
    const reason: string | null = s.fullPull
      ? `Email/changes returned cannotCalculateChanges; full pull ran (${s.fetched} fetched, ${s.skipped} skipped)`
      : s.skipped > 0
      ? `${s.skipped} message(s) skipped on this run; will retry next run`
      : null;
    await db.execute(sql`
      INSERT INTO tenant_jmap_state (
        client_id, mailbox_jmap_id, mailbox_address,
        last_jmap_state, last_synced_at, last_error
      ) VALUES (
        ${clientId}, ${s.jmapId}, ${s.address},
        ${s.newState}, NOW(), ${reason}
      )
      ON CONFLICT (client_id, mailbox_jmap_id) DO UPDATE SET
        mailbox_address = EXCLUDED.mailbox_address,
        last_jmap_state = EXCLUDED.last_jmap_state,
        last_synced_at  = EXCLUDED.last_synced_at,
        last_error      = EXCLUDED.last_error,
        updated_at      = NOW()
    `);
  }
}
