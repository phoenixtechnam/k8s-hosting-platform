import { eq } from 'drizzle-orm';
import { domains } from '../../../db/schema.js';
import {
  registerLifecycleHook,
  type HookCtx,
  type HookResult,
  type LifecycleHook,
} from '../registry/index.js';

/**
 * domains-status hook.
 *
 * Mirrors the inline `ctx.db.update(domains).set({status:...})` call
 * from cascades.applyActive/Suspended/Archived.
 *
 *   - active     → status='active'
 *   - suspended  → status='suspended'
 *   - archived   → status='suspended'  (domain_status enum has no 'archived')
 *
 * blocking=abort because domain status is part of the platform's
 * source-of-truth contract (DNS reconciler reads it). A failure here
 * leaves DB in an inconsistent state with the rest of the cascade.
 */
const HOOK_NAME = 'domains-status';

async function runImpl(ctx: HookCtx): Promise<HookResult> {
  const target =
    ctx.transition === 'active' || ctx.transition === 'restored' ? 'active'
      : 'suspended'; // suspended + archived both → 'suspended'
  await ctx.db.update(domains)
    .set({ status: target })
    .where(eq(domains.clientId, ctx.clientId));
  return { status: 'ok', detail: `set status=${target}` };
}

export const domainsStatusHook: LifecycleHook = {
  name: HOOK_NAME,
  transitions: ['active', 'suspended', 'archived', 'restored'],
  order: 200,
  blocking: 'abort',
  run: runImpl,
};

let _registered = false;
export function registerDomainsStatusHook(): void {
  if (_registered) return;
  registerLifecycleHook(domainsStatusHook);
  _registered = true;
}
