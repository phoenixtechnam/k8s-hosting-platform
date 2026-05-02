import { eq } from 'drizzle-orm';
import { deployments } from '../../../db/schema.js';
import {
  registerLifecycleHook,
  type HookCtx,
  type HookResult,
  type LifecycleHook,
} from '../registry/index.js';

/**
 * deployments-status hook.
 *
 *   - suspended → status='stopped'
 *   - archived  → status='stopped'
 *   - active    → noop (storage-lifecycle resume op writes the
 *                 actual replica counts back; cascades.applyActive
 *                 has no inline DB write for deployments because
 *                 the resume orchestrator owns the row)
 *   - restored  → noop (same reason as active)
 *
 * blocking=abort: deployment status drives the Workloads UI + Flux
 * reconciler decisions; a stale 'running' row for a suspended client
 * will trip alarm thresholds.
 */
async function runImpl(ctx: HookCtx): Promise<HookResult> {
  if (ctx.transition === 'active' || ctx.transition === 'restored' || ctx.transition === 'deleted') {
    return { status: 'noop', detail: 'storage-lifecycle owns deployment status on resume/restore' };
  }
  await ctx.db.update(deployments)
    .set({ status: 'stopped' })
    .where(eq(deployments.clientId, ctx.clientId));
  return { status: 'ok', detail: 'set status=stopped' };
}

export const deploymentsStatusHook: LifecycleHook = {
  name: 'deployments-status',
  // Subscribed to all five so the audit trail records who declined
  // (noop) vs who actually wrote.
  transitions: ['active', 'suspended', 'archived', 'restored', 'deleted'],
  order: 240,
  blocking: 'abort',
  run: runImpl,
};

let _registered = false;
export function registerDeploymentsStatusHook(): void {
  if (_registered) return;
  registerLifecycleHook(deploymentsStatusHook);
  _registered = true;
}
