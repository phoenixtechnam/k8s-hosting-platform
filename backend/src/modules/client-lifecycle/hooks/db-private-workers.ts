import { and, eq, inArray } from 'drizzle-orm';
import { privateWorkers } from '../../../db/schema.js';
import { reconcilePrivateWorkersForClient } from '../../private-workers/reconciler.js';
import {
  registerLifecycleHook,
  type HookCtx,
  type HookResult,
  type LifecycleHook,
} from '../registry/index.js';

/**
 * db-private-workers hook.
 *
 *   - suspended → mark all rows status='suspended'. The reconciler
 *     drops them from the active set on the next call, and the frps
 *     Deployment scales to 0 because tearDown sees zero active rows.
 *   - restored  → flip rows that were suspended back to status='active'.
 *     Pending rows stay pending. The reconciler then rebuilds K8s
 *     state.
 *   - archived  → mark all rows status='revoked'; stamp revokedAt+by.
 *     The reconciler tears down all cluster artefacts. Rows survive
 *     so a future un-archive doesn't lose the audit trail.
 *   - deleted   → hard-delete `private_workers` rows for the client.
 *     The audit table cascades via FK. Cluster cleanup is handled by
 *     the cluster-scoped-refs hook on the deleted transition (it tears
 *     down the namespace itself, taking the per-client artefacts with
 *     it). The platform-system tunnel-* artefacts are torn down by a
 *     final reconciler call here so they don't outlive the rows.
 *
 * blocking=abort: any DB write failure here leaves the cluster in a
 * mismatched state vs. the client status — better to halt the
 * transition + retry than to ship a half-applied suspend.
 */
async function runImpl(ctx: HookCtx): Promise<HookResult> {
  switch (ctx.transition) {
    case 'suspended': {
      const result = await ctx.db
        .update(privateWorkers)
        .set({ status: 'suspended' })
        .where(
          and(
            eq(privateWorkers.clientId, ctx.clientId),
            inArray(privateWorkers.status, ['active', 'pending']),
          ),
        );
      // Best-effort cluster sync. Failure here is recorded but doesn't
      // abort because the DB row is the source of truth — the next
      // scheduler tick (or any future write) will retry.
      await tryReconcile(ctx);
      const count = (result as { rowCount?: number }).rowCount ?? 0;
      return { status: 'ok', detail: `suspended ${count} private workers` };
    }
    case 'restored': {
      const result = await ctx.db
        .update(privateWorkers)
        .set({ status: 'active' })
        .where(
          and(
            eq(privateWorkers.clientId, ctx.clientId),
            eq(privateWorkers.status, 'suspended'),
          ),
        );
      await tryReconcile(ctx);
      const count = (result as { rowCount?: number }).rowCount ?? 0;
      return { status: 'ok', detail: `restored ${count} private workers` };
    }
    case 'archived': {
      const now = new Date();
      const result = await ctx.db
        .update(privateWorkers)
        .set({
          status: 'revoked',
          revokedAt: now,
          // Marker so the audit log distinguishes operator-revokes from
          // archive-cascade-revokes. HookCtx doesn't expose the calling
          // actor, so we use a fixed label tied to the transition.
          revokedBy: 'lifecycle:archived',
        })
        .where(
          and(
            eq(privateWorkers.clientId, ctx.clientId),
            inArray(privateWorkers.status, ['active', 'pending', 'suspended']),
          ),
        );
      await tryReconcile(ctx);
      const count = (result as { rowCount?: number }).rowCount ?? 0;
      return { status: 'ok', detail: `revoked ${count} private workers on archive` };
    }
    case 'deleted': {
      // Rows go away; reconcile last so the platform-system tunnel-*
      // artefacts are torn down using the (now-empty) active set.
      await ctx.db
        .delete(privateWorkers)
        .where(eq(privateWorkers.clientId, ctx.clientId));
      await tryReconcile(ctx);
      return { status: 'ok', detail: 'deleted private worker rows' };
    }
    default:
      return { status: 'noop', detail: `unhandled transition '${ctx.transition}'` };
  }
}

async function tryReconcile(ctx: HookCtx): Promise<void> {
  try {
    const outcome = await reconcilePrivateWorkersForClient(
      { db: ctx.db, k8s: ctx.k8s },
      ctx.clientId,
    );
    if (outcome.error && ctx.log) {
      ctx.log('private-workers.reconcile_failed', {
        clientId: ctx.clientId,
        action: outcome.action,
        error: outcome.error,
      });
    }
  } catch (err) {
    if (ctx.log) {
      ctx.log('private-workers.reconcile_threw', {
        clientId: ctx.clientId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export const privateWorkersLifecycleHook: LifecycleHook = {
  name: 'db-private-workers',
  transitions: ['suspended', 'restored', 'archived', 'deleted'],
  // 230 sits between mailboxes (220) and deployments (240) per the
  // ordering requested in the spec.
  order: 230,
  blocking: 'abort',
  run: runImpl,
};

let _registered = false;
export function registerPrivateWorkersLifecycleHook(): void {
  if (_registered) return;
  registerLifecycleHook(privateWorkersLifecycleHook);
  _registered = true;
}
