import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { tenants } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

interface PerTenantResult {
  readonly id: string;
  /** Transition row id when the cascade was dispatched. null on error/skip. */
  readonly transitionId: string | null;
  readonly error?: string;
}

interface BulkResult {
  readonly bulkOpId: string;
  readonly succeeded: readonly PerTenantResult[];
  readonly failed: readonly PerTenantResult[];
}

/**
 * Bulk status change. Each per-tenant transition is dispatched through
 * the lifecycle registry so all the hooks fire (domains-status,
 * cronjobs-enable, mailboxes-status, ingress-suspend/resume,
 * tenants-status-stamp). Per-row failures are aggregated; one bad row
 * does not abort the batch.
 *
 * The bulkOpId is stamped onto each transition's `detail.bulkOpId`
 * so the UI can poll one query that fans out across all per-tenant
 * transitions for progress display.
 */
export async function bulkUpdateTenantStatus(
  db: Database,
  tenantIds: readonly string[],
  action: 'suspend' | 'reactivate',
  k8sTenants?: K8sClients,
  triggeredByUserId?: string | null,
): Promise<BulkResult> {
  const bulkOpId = randomUUID();
  const succeeded: PerTenantResult[] = [];
  const failed: PerTenantResult[] = [];

  // Create the parent task for the chip — children carry parent_task_id
  // so the snapshot endpoint can fold them under this row.
  const parentTaskId = await createBulkParentTask(
    db,
    bulkOpId,
    action === 'suspend' ? 'tenant.suspend.bulk' : 'tenant.reactivate.bulk',
    `${action} ${tenantIds.length} tenants`,
    tenantIds.length,
    triggeredByUserId ?? null,
  );

  for (const id of tenantIds) {
    try {
      const [tenant] = await db.select()
        .from(tenants)
        .where(eq(tenants.id, id));

      if (!tenant) {
        failed.push({ id, transitionId: null, error: `Client '${id}' not found` });
        continue;
      }

      // SYSTEM tenant protection (ADR-040). Bulk suspend hits this
      // guard; reactivate is allowed (it's a no-op when already active
      // and the lifecycle hook for `active` is unguarded — SYSTEM
      // never leaves active in the first place).
      if (tenant.isSystem && action === 'suspend') {
        failed.push({
          id,
          transitionId: null,
          error: `Cannot suspend SYSTEM tenant (platform-protected, ADR-040)`,
        });
        continue;
      }

      // Dispatch through the cascade so hooks fire; skip k8s-only cascades
      // when k8s isn't available (unit-test / DB-only deploy).
      if (action === 'suspend') {
        const { applySuspended } = await import('../tenant-lifecycle/cascades.js');
        const { runTransition } = await import('../tenant-lifecycle/registry/index.js');
        if (k8sTenants) {
          await applySuspended(
            { db, k8s: k8sTenants, triggeredByUserId, parentTaskId },
            id,
            tenant.kubernetesNamespace,
          );
        } else {
          // No k8s — registry-only dispatch with namespace-only metadata.
          await runTransition(db, {} as never, {
            tenantId: id, namespace: tenant.kubernetesNamespace,
            transition: 'suspended', toStatus: 'suspended',
            triggeredByUserId: triggeredByUserId ?? null,
            parentTaskId,
            detail: { bulkOpId },
          });
        }
      } else {
        const { applyActive } = await import('../tenant-lifecycle/cascades.js');
        const { runTransition } = await import('../tenant-lifecycle/registry/index.js');
        if (k8sTenants) {
          await applyActive(
            { db, k8s: k8sTenants, triggeredByUserId, parentTaskId },
            id,
            tenant.kubernetesNamespace,
          );
        } else {
          await runTransition(db, {} as never, {
            tenantId: id, namespace: tenant.kubernetesNamespace,
            transition: 'active', toStatus: 'active',
            triggeredByUserId: triggeredByUserId ?? null,
            parentTaskId,
            detail: { bulkOpId },
          });
        }
      }

      // Stamp bulkOpId onto the most-recent transition row for this
      // tenant so the UI can fan out queries by bulkOpId.
      const { tagBulkOpOnLatestTransition } = await import('../tenant-lifecycle/bulk-tag.js');
      const txId = await tagBulkOpOnLatestTransition(db, id, bulkOpId);

      succeeded.push({ id, transitionId: txId });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      failed.push({ id, transitionId: null, error: message });
    }

    // Update parent progress as children complete.
    if (parentTaskId) {
      const total = tenantIds.length;
      const done = succeeded.length + failed.length;
      const pct = total === 0 ? 100 : Math.round((done / total) * 100);
      try {
        const { progress } = await import('../tasks/service.js');
        const { toSafeText } = await import('@k8s-hosting/api-contracts');
        await progress(db, parentTaskId, {
          pct,
          text: toSafeText(`${done}/${total} processed`),
        });
      } catch { /* non-fatal */ }
    }
  }

  if (parentTaskId) {
    await finalizeBulkParentTask(db, parentTaskId, succeeded.length, failed.length);
  }

  return { bulkOpId, succeeded, failed };
}

/**
 * Bulk hard-delete. Each per-tenant delete is dispatched through
 * `applyDeleted` so the orphan-prevention hooks (pv-cleanup-released,
 * dns-zone-cleanup, tenant-bundles-bundle-cleanup, etc.) fire.
 *
 * Pre-A2 this skipped `applyDeleted` entirely and called
 * `deleteNamespace` + `db.delete(tenants)` inline — every external
 * cleanup leaked. Critical bug, fixed by routing through the same
 * cascade the per-tenant DELETE endpoint uses.
 */
export async function bulkDeleteTenants(
  db: Database,
  tenantIds: readonly string[],
  k8sTenants?: K8sClients,
  triggeredByUserId?: string | null,
): Promise<BulkResult> {
  const bulkOpId = randomUUID();
  const succeeded: PerTenantResult[] = [];
  const failed: PerTenantResult[] = [];

  const parentTaskId = await createBulkParentTask(
    db,
    bulkOpId,
    'tenant.delete.bulk',
    `delete ${tenantIds.length} tenants`,
    tenantIds.length,
    triggeredByUserId ?? null,
  );

  for (const id of tenantIds) {
    try {
      const [tenant] = await db.select()
        .from(tenants)
        .where(eq(tenants.id, id));

      if (!tenant) {
        failed.push({ id, transitionId: null, error: `Client '${id}' not found` });
        continue;
      }

      // SYSTEM tenant protection (ADR-040). Bulk delete must skip
      // SYSTEM with an operator-visible reason so the chip popover
      // shows why one row in the batch was refused.
      if (tenant.isSystem) {
        failed.push({
          id,
          transitionId: null,
          error: `Cannot delete SYSTEM tenant (platform-protected, ADR-040)`,
        });
        continue;
      }

      if (k8sTenants) {
        const { applyDeleted } = await import('../tenant-lifecycle/cascades.js');
        await applyDeleted(
          { db, k8s: k8sTenants, triggeredByUserId, parentTaskId },
          id,
          tenant.kubernetesNamespace,
        );
      } else {
        // Without k8s, fall through to a DB-only delete (unit-test path).
        await db.delete(tenants).where(eq(tenants.id, id));
      }

      const { tagBulkOpOnLatestTransition } = await import('../tenant-lifecycle/bulk-tag.js');
      const txId = await tagBulkOpOnLatestTransition(db, id, bulkOpId);

      succeeded.push({ id, transitionId: txId });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      failed.push({ id, transitionId: null, error: message });
    }

    if (parentTaskId) {
      const total = tenantIds.length;
      const done = succeeded.length + failed.length;
      const pct = total === 0 ? 100 : Math.round((done / total) * 100);
      try {
        const { progress } = await import('../tasks/service.js');
        const { toSafeText } = await import('@k8s-hosting/api-contracts');
        await progress(db, parentTaskId, {
          pct,
          text: toSafeText(`${done}/${total} processed`),
        });
      } catch { /* non-fatal */ }
    }
  }

  if (parentTaskId) {
    await finalizeBulkParentTask(db, parentTaskId, succeeded.length, failed.length);
  }

  return { bulkOpId, succeeded, failed };
}

// ─── Task Tracker fan-out helpers ─────────────────────────────────────────

async function createBulkParentTask(
  db: Database,
  bulkOpId: string,
  kind: 'tenant.suspend.bulk' | 'tenant.reactivate.bulk' | 'tenant.delete.bulk',
  labelText: string,
  tenantCount: number,
  userId: string | null,
): Promise<string | null> {
  if (!userId) return null;
  try {
    const { start: startTask } = await import('../tasks/service.js');
    const { toSafeText } = await import('@k8s-hosting/api-contracts');
    const action: 'suspend' | 'reactivate' | 'delete' =
      kind === 'tenant.suspend.bulk' ? 'suspend'
      : kind === 'tenant.reactivate.bulk' ? 'reactivate'
      : 'delete';
    const { id } = await startTask(db, {
      kind,
      refId: bulkOpId,
      scope: 'admin',
      userId,
      label: toSafeText(labelText),
      target: {
        type: 'modal',
        modal: 'bulk',
        modalProps: { bulkOpId, action, tenantCount },
      },
      progressPct: 0,
      details: { bulkOpId, tenantCount },
    });
    return id;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[bulk] task tracker enroll failed for bulk ${bulkOpId}: ${msg}`);
    return null;
  }
}

async function finalizeBulkParentTask(
  db: Database,
  parentTaskId: string,
  succeededCount: number,
  failedCount: number,
): Promise<void> {
  try {
    const { finish } = await import('../tasks/service.js');
    const { toSafeText } = await import('@k8s-hosting/api-contracts');
    const total = succeededCount + failedCount;
    const status: 'succeeded' | 'failed' =
      failedCount === 0 ? 'succeeded'
      : succeededCount === 0 ? 'failed'
      : 'failed'; // partial → failed (chip turns red, popover shows children)
    await finish(db, parentTaskId, {
      status,
      text: toSafeText(`${succeededCount}/${total} succeeded`),
      error: failedCount > 0 ? `${failedCount} tenant(s) failed — see children for detail` : null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[bulk] task tracker finalize failed for parent ${parentTaskId}: ${msg}`);
  }
}
