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
  // Snapshot which PVs claim this namespace BEFORE the namespace is
  // deleted. The tenant SC uses reclaimPolicy=Retain (intentional —
  // protects against accidental data loss), so when the namespace
  // cascade-deletes the PVCs, the underlying PVs flip to Released
  // rather than disappearing. We need to identify them up-front
  // because once `deleteNamespace()` returns, the PVCs are still
  // present (Terminating) and `claimRef` is still on the PV — but
  // the moment the PVC actually goes away, the PV becomes a Released
  // orphan with no easy way to associate it back to a namespace.
  interface PvLite {
    metadata?: { name?: string };
    spec?: { claimRef?: { namespace?: string } };
    status?: { phase?: string };
  }
  const pvCandidates = new Set<string>();
  try {
    const pvsBefore = await ctx.k8s.core.listPersistentVolume({});
    for (const p of ((pvsBefore as { items?: PvLite[] }).items ?? [])) {
      const name = p.metadata?.name;
      if (name && p.spec?.claimRef?.namespace === namespace) {
        pvCandidates.add(name);
      }
    }
  } catch (err) {
    console.warn(`[cascades.applyDeleted] PV pre-snapshot failed: ${(err as Error).message}`);
  }

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

  // Released PV + Longhorn volume cleanup. Runs in the background
  // (no await on the caller) — `deleteNamespace()` returns while the
  // namespace is still Terminating, so we have to poll for the PVCs
  // to actually go away (which transitions PVs Bound → Released)
  // before we can delete them. Without this, every client deletion
  // leaves orphan PVs that fill up storageScheduled until Longhorn
  // refuses new replicas with "insufficient storage".
  //
  // We always kick off the poll — even with an empty pre-snapshot —
  // because PVC binding is async. A test that creates+deletes a
  // client within ~5s sees the cascade fire BEFORE Longhorn has
  // allocated the PV (PVC still Pending, no claimRef on any PV).
  // Pre-snapshot returns empty in that race, but the PV binds
  // moments later and becomes a Released orphan. The poll
  // continually re-discovers PVs by claimRef.namespace so a
  // late-binding PV still gets cleaned up.
  void cleanupReleasedPvs(ctx, namespace, pvCandidates).catch((err) => {
    console.warn(`[cascades.applyDeleted] PV cleanup failed: ${(err as Error).message}`);
  });
}

/**
 * Background poll: wait up to 60s for each candidate PV to transition
 * to Released (or disappear), then delete the PV + the matching
 * Longhorn volume CR. Runs detached from the request lifecycle —
 * `applyDeleted` returns immediately after kicking this off.
 */
async function cleanupReleasedPvs(
  ctx: CascadeCtx,
  namespace: string,
  candidates: Set<string>,
): Promise<void> {
  interface PvLite {
    metadata?: { name?: string };
    spec?: { claimRef?: { namespace?: string } };
    status?: { phase?: string };
  }
  const handled = new Set<string>();
  // The tracking set grows during the poll — late-binding PVs (PVC
  // was Pending when applyDeleted ran) get added the moment Longhorn
  // populates claimRef.namespace.
  const tracked = new Set<string>(candidates);
  const startedAt = Date.now();

  // Always poll for the full 60s window — a fast create+delete may
  // see candidates=∅ at start, then the PV appears mid-loop. We need
  // to keep watching until either every tracked PV is handled OR the
  // window closes.
  while (Date.now() - startedAt < 60_000) {
    const pvsNow = await ctx.k8s.core.listPersistentVolume({}).catch(() => null);
    if (!pvsNow) {
      await new Promise((r) => setTimeout(r, 2_000));
      continue;
    }
    const items = (pvsNow as { items?: PvLite[] }).items ?? [];
    const stillPresent = new Set<string>();
    for (const p of items) {
      const name = p.metadata?.name;
      if (!name) continue;
      stillPresent.add(name);
      // Discover late-binding PVs whose claimRef points at our
      // soon-to-be-deleted namespace.
      if (p.spec?.claimRef?.namespace === namespace) tracked.add(name);
      if (!tracked.has(name) || handled.has(name)) continue;
      if (p.status?.phase === 'Released') handled.add(name);
    }
    // Tolerate a candidate that disappeared on its own (Delete reclaim).
    for (const c of tracked) {
      if (!stillPresent.has(c)) handled.add(c);
    }
    // Exit early once we've seen at least one PV and all are handled.
    if (tracked.size > 0 && handled.size >= tracked.size) break;
    await new Promise((r) => setTimeout(r, 2_000));
  }

  let cleaned = 0;
  for (const pvName of handled) {
    try {
      await ctx.k8s.core.deletePersistentVolume({ name: pvName });
      cleaned++;
    } catch (err) {
      const status = (err as { statusCode?: number; code?: number }).statusCode
        ?? (err as { code?: number }).code;
      if (status !== 404) {
        console.warn(`[cascades.applyDeleted] failed to delete Released PV ${pvName}: ${(err as Error).message}`);
      }
    }
    // Cascade to Longhorn volume CR (CSI volume name == PV name).
    // PV deletion alone leaves a "detached" longhorn.io/volume that
    // still counts against storageScheduled.
    try {
      await ctx.k8s.custom.deleteNamespacedCustomObject({
        group: 'longhorn.io', version: 'v1beta2',
        namespace: 'longhorn-system', plural: 'volumes', name: pvName,
      } as unknown as Parameters<typeof ctx.k8s.custom.deleteNamespacedCustomObject>[0]);
    } catch (err) {
      const status = (err as { statusCode?: number; code?: number }).statusCode
        ?? (err as { code?: number }).code;
      if (status !== 404) {
        console.warn(`[cascades.applyDeleted] failed to delete Longhorn volume ${pvName}: ${(err as Error).message}`);
      }
    }
  }

  if (cleaned > 0) {
    console.log(`[cascades.applyDeleted] cleaned up ${cleaned} Released PV(s) + Longhorn volume(s) for namespace ${namespace}`);
  }
  if (tracked.size > handled.size) {
    console.warn(`[cascades.applyDeleted] ${tracked.size - handled.size} PV(s) for ${namespace} did not reach Released within 60s — leaving for manual cleanup`);
  }
}
