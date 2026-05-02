import { eq } from 'drizzle-orm';
import { mailboxes } from '../../../db/schema.js';
import {
  registerLifecycleHook,
  type HookCtx,
  type HookResult,
  type LifecycleHook,
} from '../registry/index.js';

/**
 * mailboxes-status hook.
 *
 *   - active     → status='active'
 *   - suspended  → status='disabled'
 *   - archived   → DELETE FROM mailboxes WHERE client_id=...
 *                  (per cascades.applyArchived comment: "user
 *                  confirmed these should go on archive — no 90d
 *                  alias retention. Stalwart picks this up via
 *                  the stalwart.* views; bodies stored on
 *                  Stalwart's side are GC'd by its own retention.")
 *   - restored   → status='active'
 *
 * blocking=abort: Stalwart's `stalwart.*` views read this state
 * directly; a stale row keeps a deleted client's mail flowing.
 */
async function runImpl(ctx: HookCtx): Promise<HookResult> {
  switch (ctx.transition) {
    case 'archived':
      await ctx.db.delete(mailboxes).where(eq(mailboxes.clientId, ctx.clientId));
      return { status: 'ok', detail: 'archived: deleted mailboxes' };
    case 'suspended':
      await ctx.db.update(mailboxes)
        .set({ status: 'disabled' })
        .where(eq(mailboxes.clientId, ctx.clientId));
      return { status: 'ok', detail: 'set status=disabled' };
    case 'active':
    case 'restored':
      await ctx.db.update(mailboxes)
        .set({ status: 'active' })
        .where(eq(mailboxes.clientId, ctx.clientId));
      return { status: 'ok', detail: 'set status=active' };
    default:
      // 'deleted' is not in `transitions` so this branch is unreachable
      // unless the subscribed-transitions list is widened by mistake.
      return { status: 'noop', detail: `unhandled transition '${ctx.transition}'` };
  }
}

export const mailboxesStatusHook: LifecycleHook = {
  name: 'mailboxes-status',
  transitions: ['active', 'suspended', 'archived', 'restored'],
  order: 220,
  blocking: 'abort',
  run: runImpl,
};

let _registered = false;
export function registerMailboxesStatusHook(): void {
  if (_registered) return;
  registerLifecycleHook(mailboxesStatusHook);
  _registered = true;
}
