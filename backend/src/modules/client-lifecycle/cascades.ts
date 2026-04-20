import { eq } from 'drizzle-orm';
import {
  clients,
  domains,
  deployments,
  cronJobs,
  mailboxes,
  emailAliases,
} from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import {
  suspendNamespaceIngresses,
  resumeNamespaceIngresses,
} from './ingress-suspend.js';

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
 */

export interface CascadeCtx {
  readonly db: Database;
  readonly k8s: K8sClients;
}

// ─── suspended → active ─────────────────────────────────────────────────

/**
 * Reverse the suspend cascades: re-enable mail, webcron, domains, and
 * restore the ingress backends. Does NOT scale workloads back up —
 * that's the storage-lifecycle resume op's responsibility (it needs
 * to know the pre-suspend replica counts from the QuiesceSnapshot).
 */
export async function applyActive(
  ctx: CascadeCtx,
  clientId: string,
  namespace: string,
): Promise<void> {
  // DB cascades — the four tables are independent so fire in parallel.
  // `allSettled` (not `all`) so one table failing (e.g. a FK constraint
  // edge case) doesn't abort the rest — the reconciler picks up the
  // remainder on the next cycle. Per-failure logging surfaces which
  // cascade needs attention.
  const results = await Promise.allSettled([
    ctx.db.update(domains).set({ status: 'active' }).where(eq(domains.clientId, clientId)),
    ctx.db.update(cronJobs).set({ enabled: 1 }).where(eq(cronJobs.clientId, clientId)),
    ctx.db.update(mailboxes).set({ status: 'active' }).where(eq(mailboxes.clientId, clientId)),
    ctx.db.update(emailAliases).set({ enabled: 1 }).where(eq(emailAliases.clientId, clientId)),
  ]);
  const labels = ['domains', 'cronJobs', 'mailboxes', 'emailAliases'];
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.warn(`[cascades.applyActive] ${labels[i]} update failed for client ${clientId}: ${(r.reason as Error).message}`);
    }
  });

  // K8s: first remove the suspend markers, then tell the ingress
  // reconciler to rebuild from `ingress_routes` — this handles both
  // the redirect-annotation suspend (new) and any historical ingress
  // swap (in case we're resuming a client that was suspended under
  // an older code path).
  try {
    await resumeNamespaceIngresses(ctx.k8s, namespace);
  } catch (err) {
    console.warn(`[cascades.applyActive] resumeNamespaceIngresses failed for ${namespace}: ${(err as Error).message}`);
  }
  try {
    const { reconcileIngress } = await import('../domains/k8s-ingress.js');
    await reconcileIngress(ctx.db, ctx.k8s, clientId, namespace);
  } catch (err) {
    console.warn(`[cascades.applyActive] reconcileIngress failed for ${namespace}: ${(err as Error).message}`);
  }

  // Clear suspendedAt/archivedAt on active so the auto-archive clock
  // resets cleanly if the client is re-suspended later.
  await ctx.db.update(clients)
    .set({ status: 'active', suspendedAt: null, archivedAt: null })
    .where(eq(clients.id, clientId));
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
  // See applyActive for the allSettled rationale.
  const results = await Promise.allSettled([
    ctx.db.update(domains).set({ status: 'suspended' }).where(eq(domains.clientId, clientId)),
    ctx.db.update(deployments).set({ status: 'stopped' }).where(eq(deployments.clientId, clientId)),
    ctx.db.update(cronJobs).set({ enabled: 0 }).where(eq(cronJobs.clientId, clientId)),
    ctx.db.update(mailboxes).set({ status: 'disabled' }).where(eq(mailboxes.clientId, clientId)),
    ctx.db.update(emailAliases).set({ enabled: 0 }).where(eq(emailAliases.clientId, clientId)),
  ]);
  const labels = ['domains', 'deployments', 'cronJobs', 'mailboxes', 'emailAliases'];
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.warn(`[cascades.applySuspended] ${labels[i]} update failed for client ${clientId}: ${(r.reason as Error).message}`);
    }
  });

  // K8s: swap tenant ingresses to platform-suspended.
  try {
    await suspendNamespaceIngresses(ctx.k8s, namespace);
  } catch (err) {
    console.warn(`[cascades.applySuspended] suspendNamespaceIngresses failed for ${namespace}: ${(err as Error).message}`);
  }

  // Stamp suspendedAt unconditionally — auto-archive cron compares this
  // to its threshold. Idempotent: re-suspending an already-suspended
  // client bumps the timestamp, which is the right semantic (fresh
  // suspension, restart the clock).
  await ctx.db.update(clients)
    .set({ status: 'suspended', suspendedAt: new Date() })
    .where(eq(clients.id, clientId));
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
  _namespace: string,
): Promise<void> {
  // Delete mailboxes + aliases — the user confirmed these should go on
  // archive (no 90d alias retention). Stalwart picks this up via the
  // `stalwart.*` views; bodies stored on Stalwart's side are GC'd by
  // its own retention.
  await ctx.db.delete(mailboxes).where(eq(mailboxes.clientId, clientId));
  await ctx.db.delete(emailAliases).where(eq(emailAliases.clientId, clientId));

  // Domains and DNS: mark domains archived (status=suspended — no
  // "archived" state on domain_status enum) and let the DNS reconciler
  // stop publishing records. The actual DNS zone in PowerDNS is owned
  // by the DNS module which will pick up the status change.
  await ctx.db.update(domains).set({ status: 'suspended' }).where(eq(domains.clientId, clientId));
  await ctx.db.update(deployments).set({ status: 'stopped' }).where(eq(deployments.clientId, clientId));
  await ctx.db.update(cronJobs).set({ enabled: 0 }).where(eq(cronJobs.clientId, clientId));

  await ctx.db.update(clients)
    .set({ status: 'archived', archivedAt: new Date() })
    .where(eq(clients.id, clientId));
}

// ─── * → deleted (hard remove) ──────────────────────────────────────────

/**
 * Delete cascades: hard-remove EVERYTHING owned by this client.
 * The namespace cascade-delete handles most k8s resources; DB rows
 * with `ON DELETE CASCADE` (domains, deployments, mailboxes, backups,
 * sftp_users, etc.) go away with the client row.
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
  // Drop the k8s namespace — brings pods, PVC, ingress, services,
  // configmaps, secrets with it. `clients.kubernetes_namespace` is
  // notNull in schema, so no truthy guard — an empty string would
  // indicate a seed-bug upstream and should surface as an error.
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

  // DB: rely on FK cascades. `clients.id` is referenced by domains,
  // deployments, mailboxes, email_aliases, sftp_users, backups, etc.
  // with ON DELETE CASCADE so this one statement reaps the lot.
  // `audit_logs` intentionally keeps client_id as a tombstone (no
  // cascade) so the deletion event stays auditable.
  await ctx.db.delete(clients).where(eq(clients.id, clientId));
}
