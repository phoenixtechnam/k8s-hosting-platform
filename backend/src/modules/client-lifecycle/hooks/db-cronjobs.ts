import { eq } from 'drizzle-orm';
import { cronJobs } from '../../../db/schema.js';
import {
  registerLifecycleHook,
  type HookCtx,
  type HookResult,
  type LifecycleHook,
} from '../registry/index.js';

/**
 * cronjobs-enable hook.
 *
 *   - active     → enabled=1
 *   - suspended  → enabled=0
 *   - archived   → enabled=0
 *
 * blocking=abort: webcron scheduler reads `enabled` to decide whether
 * to fire scheduled jobs. A miss here can run cronjobs for a suspended
 * client (billing/data-leak risk).
 */
async function runImpl(ctx: HookCtx): Promise<HookResult> {
  const enabled = ctx.transition === 'active' || ctx.transition === 'restored' ? 1 : 0;
  await ctx.db.update(cronJobs)
    .set({ enabled })
    .where(eq(cronJobs.clientId, ctx.clientId));
  return { status: 'ok', detail: `set enabled=${enabled}` };
}

export const cronjobsEnableHook: LifecycleHook = {
  name: 'cronjobs-enable',
  transitions: ['active', 'suspended', 'archived', 'restored'],
  order: 210,
  blocking: 'abort',
  run: runImpl,
};

let _registered = false;
export function registerCronjobsEnableHook(): void {
  if (_registered) return;
  registerLifecycleHook(cronjobsEnableHook);
  _registered = true;
}
