import { eq } from 'drizzle-orm';
import { clients } from '../../../db/schema.js';
import {
  registerLifecycleHook,
  type HookCtx,
  type HookResult,
  type LifecycleHook,
} from '../registry/index.js';

/**
 * clients-status-stamp hook.
 *
 *   - active     → status='active', suspendedAt=null, archivedAt=null
 *                  (clearing both timestamps so re-suspending later
 *                   restarts the auto-archive clock cleanly — matches
 *                   cascades.applyActive comment)
 *   - suspended  → status='suspended', suspendedAt=now()
 *   - archived   → status='archived', archivedAt=now()
 *   - restored   → status='active', suspendedAt=null, archivedAt=null
 *   - deleted    → noop (the FK cascade in cascades.applyDeleted
 *                  removes the client row; no point updating it)
 *
 * Highest order in the DB hook block (250) so when a higher-priority
 * hook fails (abort), the client.status itself doesn't flip — keeping
 * the row queryable for operator triage.
 *
 * blocking=abort: the row's status is the SOURCE OF TRUTH for the
 * entire panel UI. Failing here would leave a client visually in the
 * wrong state.
 */
async function runImpl(ctx: HookCtx): Promise<HookResult> {
  // `deleted` is intentionally NOT in this hook's `transitions` set —
  // the FK cascade in cascades.applyDeleted removes the client row,
  // so a stamp would either no-op (if the row is gone) or throw a 0-
  // rows-affected error. Recording a noop in the audit trail adds no
  // value over the dispatcher's transition row.
  // Defense-in-depth: if a future refactor accidentally adds 'deleted'
  // to the transitions list, return noop instead of falling through
  // to the archived branch.
  if (ctx.transition === 'deleted') {
    return { status: 'noop', detail: 'FK cascade owns the client row on delete' };
  }
  if (ctx.transition === 'active' || ctx.transition === 'restored') {
    await ctx.db.update(clients)
      .set({ status: 'active', suspendedAt: null, archivedAt: null })
      .where(eq(clients.id, ctx.clientId));
    return { status: 'ok', detail: 'set status=active, cleared timestamps' };
  }
  if (ctx.transition === 'suspended') {
    await ctx.db.update(clients)
      .set({ status: 'suspended', suspendedAt: new Date() })
      .where(eq(clients.id, ctx.clientId));
    return { status: 'ok', detail: 'set status=suspended, suspendedAt=now' };
  }
  // archived
  await ctx.db.update(clients)
    .set({ status: 'archived', archivedAt: new Date() })
    .where(eq(clients.id, ctx.clientId));
  return { status: 'ok', detail: 'set status=archived, archivedAt=now' };
}

export const clientsStatusStampHook: LifecycleHook = {
  name: 'clients-status-stamp',
  // Excludes 'deleted' — the FK cascade removes the row before the
  // hook would run, AND the predecessors named in `after` are NOT
  // subscribed to 'deleted' which would throw UNKNOWN_AFTER from
  // topoSortForTransition.
  transitions: ['active', 'suspended', 'archived', 'restored'],
  order: 250,
  blocking: 'abort',
  // Run last among the abort-blocking DB hooks so a failure mid-
  // transition leaves the client.status in its pre-transition value.
  // Note: ingress hooks (300/310) run AFTER this stamp because they
  // are blocking=continue — an ingress failure won't roll the stamp
  // back, intentional per the design spec (failed_partial badge).
  after: ['domains-status', 'cronjobs-enable', 'mailboxes-status', 'email-aliases-enable', 'deployments-status'],
  run: runImpl,
};

let _registered = false;
export function registerClientsStatusStampHook(): void {
  if (_registered) return;
  registerLifecycleHook(clientsStatusStampHook);
  _registered = true;
}
