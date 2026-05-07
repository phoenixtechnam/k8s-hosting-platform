import { eq } from 'drizzle-orm';
import { clients } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { runTransition, type Transition } from './registry/index.js';

/**
 * Client-lifecycle cascades.
 *
 * Every state transition (active, suspended, archived, deleted) goes
 * through ONE of these functions so we have a single place to reason
 * about what each state means for every resource type the platform
 * manages.
 *
 * All functions are idempotent: re-running `applySuspended` on an
 * already-suspended client is a no-op. That's critical because the
 * storage-lifecycle ops, the subscription-expiry cron, and the admin
 * API all call into here and can race.
 *
 * Storage lifecycle (snapshots, PVC delete) is intentionally NOT here:
 * those operations live in storage-lifecycle/service.ts and invoke
 * these cascades at the right moments.
 *
 * Phase 6: every state-mutation step previously inlined here is now
 * a registered LifecycleHook. These wrappers exist solely to
 * dispatch the transition through the registry so the hook runs +
 * audit trail land. The actual work is in
 * `client-lifecycle/hooks/*.ts`.
 */

export interface CascadeCtx {
  readonly db: Database;
  readonly k8s: K8sClients;
  /**
   * The admin / client_admin user that initiated the action. Threaded
   * through to `runTransition` so the Task Tracker chip lights up on
   * the initiator's session. Optional — cron-driven cascades pass null
   * (those tasks are scope='system' and only land in notifications on
   * failure, never in the chip).
   */
  readonly triggeredByUserId?: string | null;
  /**
   * When set, the per-client task row registered by the dispatcher
   * carries this parent_task_id. Bulk ops pass the parent task id
   * here so the chip can fold N children under one parent row.
   */
  readonly parentTaskId?: string | null;
}

/**
 * Run a transition through the registry. Errors from the dispatcher
 * are swallowed so a registry write failure cannot corrupt the
 * outer cascade — the orphan scanner + retry scheduler are the
 * safety nets if the in-band call fails.
 *
 * Returns the transitionId so callers (PATCH /clients/:id route, bulk
 * ops, storage-lifecycle orchestrators) can include it in their
 * response. The UI uses it to open the progress modal immediately
 * with a stable id instead of latching by (kind + since-timestamp)
 * after a 1-2 s race.
 */
async function dispatchTransition(
  ctx: CascadeCtx,
  clientId: string,
  namespace: string,
  transition: Transition,
  fromStatus: string | null,
  toStatus: string,
): Promise<string | null> {
  try {
    const result = await runTransition(ctx.db, ctx.k8s, {
      clientId, namespace, transition, fromStatus, toStatus,
      triggeredByUserId: ctx.triggeredByUserId ?? null,
      parentTaskId: ctx.parentTaskId ?? null,
    });
    return result.transitionId;
  } catch (err) {
    console.warn(
      `[cascades.dispatchTransition] registry write failed for client ${clientId} ${transition}: ${(err as Error).message}`,
    );
    return null;
  }
}

// ─── suspended → active ─────────────────────────────────────────────────

/**
 * Reverse the suspend cascades: re-enable mail, webcron, domains, and
 * restore the ingress backends. Does NOT scale workloads back up —
 * that's the storage-lifecycle resume op's responsibility (it needs
 * to know the pre-suspend replica counts from the QuiesceSnapshot).
 *
 * Hooks fired (in topo order):
 *   domains-status, cronjobs-enable, mailboxes-status,
 *   email-aliases-enable, deployments-status, clients-status-stamp,
 *   ingress-resume, ingress-reconcile.
 */
export async function applyActive(
  ctx: CascadeCtx,
  clientId: string,
  namespace: string,
): Promise<string | null> {
  return dispatchTransition(ctx, clientId, namespace, 'active', null, 'active');
}

export async function applyRestored(
  ctx: CascadeCtx,
  clientId: string,
  namespace: string,
): Promise<string | null> {
  return dispatchTransition(ctx, clientId, namespace, 'restored', null, 'active');
}

export async function applySuspended(
  ctx: CascadeCtx,
  clientId: string,
  namespace: string,
): Promise<string | null> {
  return dispatchTransition(ctx, clientId, namespace, 'suspended', null, 'suspended');
}

export async function applyArchived(
  ctx: CascadeCtx,
  clientId: string,
  namespace: string,
): Promise<string | null> {
  return dispatchTransition(ctx, clientId, namespace, 'archived', null, 'archived');
}

// ─── active → suspended ──────────────────────────────────────────────────

// ─── * → deleted (hard remove) ──────────────────────────────────────────

/**
 * Delete cascades: hard-remove EVERYTHING owned by this client.
 * Sequence:
 *   1. Open a transitions row + run the registry's `deleted` hooks
 *      (pv-cleanup-released, dns-zone-cleanup, tenant-bundles-bundle-
 *      cleanup, etc.). This happens BEFORE the FK cascade so the
 *      hooks can read domains/backup_jobs rows.
 *   2. Drop the k8s namespace — brings pods, PVCs, ingress, services,
 *      configmaps, secrets with it.
 *   3. Drop the client row — FK cascades reap domains, deployments,
 *      mailboxes, sftp_users, backups, etc. `audit_logs` and
 *      `client_lifecycle_transitions` intentionally retain
 *      `client_id` as a tombstone.
 *
 * Storage-lifecycle snapshots for this client are purged by the
 * caller (storage-lifecycle/service.ts handles snapshot store
 * cleanup) before we hit applyDeleted.
 */
export async function applyDeleted(
  ctx: CascadeCtx,
  clientId: string,
  namespace: string,
): Promise<string | null> {
  // Step 1: dispatch hooks while domains/backup_jobs rows still exist.
  const transitionId = await dispatchTransition(ctx, clientId, namespace, 'deleted', null, 'deleted');

  // Step 2: drop the k8s namespace. `clients.kubernetes_namespace` is
  // notNull in schema, so no truthy guard — an empty string would
  // indicate a seed bug upstream and should surface as an error.
  try {
    await ctx.k8s.core.deleteNamespace({ name: namespace });
  } catch (err) {
    const status = (err as { statusCode?: number; code?: number; body?: { code?: number } }).statusCode
      ?? (err as { code?: number }).code
      ?? (err as { body?: { code?: number } }).body?.code;
    if (status !== 404) {
      console.warn(`[cascades.applyDeleted] deleteNamespace ${namespace} failed: ${(err as Error).message}`);
    }
  }

  // Step 3: drop the client row. FK cascades take care of children.
  await ctx.db.delete(clients).where(eq(clients.id, clientId));
  return transitionId;
}
