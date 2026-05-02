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
}

/**
 * Run a transition through the registry. Errors from the dispatcher
 * are swallowed so a registry write failure cannot corrupt the
 * outer cascade — the orphan scanner + retry scheduler are the
 * safety nets if the in-band call fails.
 */
async function dispatchTransition(
  ctx: CascadeCtx,
  clientId: string,
  namespace: string,
  transition: Transition,
  fromStatus: string | null,
  toStatus: string,
): Promise<void> {
  try {
    await runTransition(ctx.db, ctx.k8s, {
      clientId, namespace, transition, fromStatus, toStatus,
    });
  } catch (err) {
    console.warn(
      `[cascades.dispatchTransition] registry write failed for client ${clientId} ${transition}: ${(err as Error).message}`,
    );
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
): Promise<void> {
  await dispatchTransition(ctx, clientId, namespace, 'active', null, 'active');
}

// ─── active → suspended ──────────────────────────────────────────────────

/**
 * Suspend cascades: scale workloads to 0 (storage-lifecycle quiesce
 * does the scaling — this function is called AFTER quiesce returns),
 * patch ingresses to platform-suspended, disable mail, disable
 * webcron, mark domains suspended.
 *
 * This function DOES NOT scale workloads down by itself. Callers from
 * the storage-lifecycle path already ran `quiesce()` which knows the
 * pre-suspend replica counts.
 */
export async function applySuspended(
  ctx: CascadeCtx,
  clientId: string,
  namespace: string,
): Promise<void> {
  await dispatchTransition(ctx, clientId, namespace, 'suspended', null, 'suspended');
}

// ─── * → archived ────────────────────────────────────────────────────────

/**
 * Archive cascades: delete mailboxes + aliases, delete domains (they
 * no longer resolve), keep client row + PVC-snapshot for restore.
 *
 * Called by storage-lifecycle archiveClient() AFTER the archive
 * snapshot + PVC delete. Kubernetes resources (deployments, cronjobs,
 * services) are already deleted by storage-lifecycle before we get
 * here — we just clean up the DB side.
 */
export async function applyArchived(
  ctx: CascadeCtx,
  clientId: string,
  namespace: string,
): Promise<void> {
  await dispatchTransition(ctx, clientId, namespace, 'archived', null, 'archived');
}

// ─── * → deleted (hard remove) ──────────────────────────────────────────

/**
 * Delete cascades: hard-remove EVERYTHING owned by this client.
 * Sequence:
 *   1. Open a transitions row + run the registry's `deleted` hooks
 *      (pv-cleanup-released, dns-zone-cleanup, backups-v2-bundle-
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
): Promise<void> {
  // Step 1: dispatch hooks while domains/backup_jobs rows still exist.
  await dispatchTransition(ctx, clientId, namespace, 'deleted', null, 'deleted');

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
}
