/**
 * system-tenant-guard hook (ADR-040).
 *
 * Runs FIRST on every `suspended` / `archived` / `deleted` transition.
 * If the target tenant is the SYSTEM row (is_system=true), returns
 * `{ status: 'failed' }` with `blocking: 'abort'` — the dispatcher
 * halts the transition before any side-effecting hook runs.
 *
 * This is defense-in-depth on top of the service-layer guards in
 * tenants/service.ts + bulk.ts. If a future code path adds a new
 * way to dispatch a transition (a webhook integration, a new bulk
 * route, a CLI tool calling the registry directly) and forgets the
 * service-layer guard, this hook still keeps SYSTEM safe.
 *
 * Design notes:
 *   - `order: 1` — lowest among all registered hooks (the next-lowest
 *     is `domains-status` at 200), so this runs before any cleanup or
 *     external-system cascade.
 *   - `maxAttempts: 1` — the row either is or isn't SYSTEM; there's
 *     no transient failure mode. Avoid burning retry budget.
 *   - `blocking: 'abort'` — halts the transition; final state =
 *     `failed_blocking`. The Settings → Lifecycle Hooks UI surfaces
 *     this row with a clear "SYSTEM tenant protected" reason.
 *   - `after: []` — no predecessors. This is the first thing to run.
 *   - NOT registered for `active` or `restored` — SYSTEM stays in
 *     `active` permanently, so those transitions are no-ops on
 *     SYSTEM (and the cron schedulers that auto-trigger them already
 *     have SQL-level `is_system=false` filters).
 */

import { eq } from 'drizzle-orm';
import { tenants } from '../../../db/schema.js';
import {
  registerLifecycleHook,
  type HookCtx,
  type HookResult,
  type LifecycleHook,
} from '../registry/index.js';

async function runImpl(ctx: HookCtx): Promise<HookResult> {
  const [row] = await ctx.db.select({ isSystem: tenants.isSystem })
    .from(tenants)
    .where(eq(tenants.id, ctx.tenantId))
    .limit(1);

  // No row found — the FK cascade has already removed the tenant
  // (happens on the `deleted` transition's late-running hooks). Not
  // SYSTEM by definition. Pass through.
  if (!row) {
    return { status: 'noop', detail: 'tenant row not found (already deleted)' };
  }

  if (!row.isSystem) {
    return { status: 'noop', detail: 'not a SYSTEM tenant' };
  }

  // SYSTEM row → reject the destructive transition.
  return {
    status: 'failed',
    detail: `SYSTEM tenant cannot transition to ${ctx.transition}`,
    envelope: {
      title: 'SYSTEM tenant is protected',
      detail: `Cannot ${ctx.transition} the SYSTEM tenant — it owns the platform apex domain and the platform's reserved mailbox space (ADR-040).`,
      remediation: [
        'This tenant is by design indelible. No action needed.',
        'To stop using a transactional mailbox owned by SYSTEM, remove the mailbox from Email Management instead.',
      ],
    },
  };
}

export const systemTenantGuardHook: LifecycleHook = {
  name: 'system-tenant-guard',
  transitions: ['suspended', 'archived', 'deleted'],
  // Run before everything else — lower than `domains-status` (200),
  // `db-cronjobs` (210), and the rest of the cascade.
  order: 1,
  blocking: 'abort',
  // No retry: the SYSTEM flag is set or not, never transient.
  maxAttempts: 1,
  after: [],
  run: runImpl,
};

let _registered = false;
export function registerSystemTenantGuardHook(): void {
  if (_registered) return;
  registerLifecycleHook(systemTenantGuardHook);
  _registered = true;
}
