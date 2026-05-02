import { eq } from 'drizzle-orm';
import { emailAliases } from '../../../db/schema.js';
import {
  registerLifecycleHook,
  type HookCtx,
  type HookResult,
  type LifecycleHook,
} from '../registry/index.js';

/**
 * email-aliases-enable hook.
 *
 *   - active     → enabled=1
 *   - suspended  → enabled=0
 *   - archived   → DELETE FROM email_aliases WHERE client_id=...
 *                  (matches mailboxes hook: archived clients lose
 *                  forward records along with mailboxes)
 *   - restored   → enabled=1  (rows restored by storage-lifecycle
 *                  restore op are the responsibility of that op;
 *                  this hook only flips the enabled flag)
 *
 * blocking=abort: same Stalwart view dependency as mailboxes-status.
 */
async function runImpl(ctx: HookCtx): Promise<HookResult> {
  switch (ctx.transition) {
    case 'archived':
      await ctx.db.delete(emailAliases).where(eq(emailAliases.clientId, ctx.clientId));
      return { status: 'ok', detail: 'archived: deleted email_aliases' };
    case 'suspended':
      await ctx.db.update(emailAliases)
        .set({ enabled: 0 })
        .where(eq(emailAliases.clientId, ctx.clientId));
      return { status: 'ok', detail: 'set enabled=0' };
    case 'active':
    case 'restored':
      await ctx.db.update(emailAliases)
        .set({ enabled: 1 })
        .where(eq(emailAliases.clientId, ctx.clientId));
      return { status: 'ok', detail: 'set enabled=1' };
    default:
      return { status: 'noop', detail: `unhandled transition '${ctx.transition}'` };
  }
}

export const emailAliasesEnableHook: LifecycleHook = {
  name: 'email-aliases-enable',
  transitions: ['active', 'suspended', 'archived', 'restored'],
  order: 230,
  blocking: 'abort',
  run: runImpl,
};

let _registered = false;
export function registerEmailAliasesEnableHook(): void {
  if (_registered) return;
  registerLifecycleHook(emailAliasesEnableHook);
  _registered = true;
}
