import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { clients } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

interface PerClientResult {
  readonly id: string;
  /** Transition row id when the cascade was dispatched. null on error/skip. */
  readonly transitionId: string | null;
  readonly error?: string;
}

interface BulkResult {
  readonly bulkOpId: string;
  readonly succeeded: readonly PerClientResult[];
  readonly failed: readonly PerClientResult[];
}

/**
 * Bulk status change. Each per-client transition is dispatched through
 * the lifecycle registry so all the hooks fire (domains-status,
 * cronjobs-enable, mailboxes-status, ingress-suspend/resume,
 * clients-status-stamp). Per-row failures are aggregated; one bad row
 * does not abort the batch.
 *
 * The bulkOpId is stamped onto each transition's `detail.bulkOpId`
 * so the UI can poll one query that fans out across all per-client
 * transitions for progress display.
 */
export async function bulkUpdateClientStatus(
  db: Database,
  clientIds: readonly string[],
  action: 'suspend' | 'reactivate',
  k8sClients?: K8sClients,
  triggeredByUserId?: string | null,
): Promise<BulkResult> {
  const bulkOpId = randomUUID();
  const succeeded: PerClientResult[] = [];
  const failed: PerClientResult[] = [];

  // Create the parent task for the chip — children carry parent_task_id
  // so the snapshot endpoint can fold them under this row.
  const parentTaskId = await createBulkParentTask(
    db,
    bulkOpId,
    action === 'suspend' ? 'client.suspend.bulk' : 'client.reactivate.bulk',
    `${action} ${clientIds.length} clients`,
    clientIds.length,
    triggeredByUserId ?? null,
  );

  for (const id of clientIds) {
    try {
      const [client] = await db.select()
        .from(clients)
        .where(eq(clients.id, id));

      if (!client) {
        failed.push({ id, transitionId: null, error: `Client '${id}' not found` });
        continue;
      }

      // Dispatch through the cascade so hooks fire; skip k8s-only cascades
      // when k8s isn't available (unit-test / DB-only deploy).
      if (action === 'suspend') {
        const { applySuspended } = await import('../client-lifecycle/cascades.js');
        const { runTransition } = await import('../client-lifecycle/registry/index.js');
        if (k8sClients) {
          await applySuspended(
            { db, k8s: k8sClients, triggeredByUserId, parentTaskId },
            id,
            client.kubernetesNamespace,
          );
        } else {
          // No k8s — registry-only dispatch with namespace-only metadata.
          await runTransition(db, {} as never, {
            clientId: id, namespace: client.kubernetesNamespace,
            transition: 'suspended', toStatus: 'suspended',
            triggeredByUserId: triggeredByUserId ?? null,
            parentTaskId,
            detail: { bulkOpId },
          });
        }
      } else {
        const { applyActive } = await import('../client-lifecycle/cascades.js');
        const { runTransition } = await import('../client-lifecycle/registry/index.js');
        if (k8sClients) {
          await applyActive(
            { db, k8s: k8sClients, triggeredByUserId, parentTaskId },
            id,
            client.kubernetesNamespace,
          );
        } else {
          await runTransition(db, {} as never, {
            clientId: id, namespace: client.kubernetesNamespace,
            transition: 'active', toStatus: 'active',
            triggeredByUserId: triggeredByUserId ?? null,
            parentTaskId,
            detail: { bulkOpId },
          });
        }
      }

      // Stamp bulkOpId onto the most-recent transition row for this
      // client so the UI can fan out queries by bulkOpId.
      const { tagBulkOpOnLatestTransition } = await import('../client-lifecycle/bulk-tag.js');
      const txId = await tagBulkOpOnLatestTransition(db, id, bulkOpId);

      succeeded.push({ id, transitionId: txId });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      failed.push({ id, transitionId: null, error: message });
    }

    // Update parent progress as children complete.
    if (parentTaskId) {
      const total = clientIds.length;
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
 * Bulk hard-delete. Each per-client delete is dispatched through
 * `applyDeleted` so the orphan-prevention hooks (pv-cleanup-released,
 * dns-zone-cleanup, tenant-bundles-bundle-cleanup, etc.) fire.
 *
 * Pre-A2 this skipped `applyDeleted` entirely and called
 * `deleteNamespace` + `db.delete(clients)` inline — every external
 * cleanup leaked. Critical bug, fixed by routing through the same
 * cascade the per-client DELETE endpoint uses.
 */
export async function bulkDeleteClients(
  db: Database,
  clientIds: readonly string[],
  k8sClients?: K8sClients,
  triggeredByUserId?: string | null,
): Promise<BulkResult> {
  const bulkOpId = randomUUID();
  const succeeded: PerClientResult[] = [];
  const failed: PerClientResult[] = [];

  const parentTaskId = await createBulkParentTask(
    db,
    bulkOpId,
    'client.delete.bulk',
    `delete ${clientIds.length} clients`,
    clientIds.length,
    triggeredByUserId ?? null,
  );

  for (const id of clientIds) {
    try {
      const [client] = await db.select()
        .from(clients)
        .where(eq(clients.id, id));

      if (!client) {
        failed.push({ id, transitionId: null, error: `Client '${id}' not found` });
        continue;
      }

      if (k8sClients) {
        const { applyDeleted } = await import('../client-lifecycle/cascades.js');
        await applyDeleted(
          { db, k8s: k8sClients, triggeredByUserId, parentTaskId },
          id,
          client.kubernetesNamespace,
        );
      } else {
        // Without k8s, fall through to a DB-only delete (unit-test path).
        await db.delete(clients).where(eq(clients.id, id));
      }

      const { tagBulkOpOnLatestTransition } = await import('../client-lifecycle/bulk-tag.js');
      const txId = await tagBulkOpOnLatestTransition(db, id, bulkOpId);

      succeeded.push({ id, transitionId: txId });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      failed.push({ id, transitionId: null, error: message });
    }

    if (parentTaskId) {
      const total = clientIds.length;
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
  kind: 'client.suspend.bulk' | 'client.reactivate.bulk' | 'client.delete.bulk',
  labelText: string,
  clientCount: number,
  userId: string | null,
): Promise<string | null> {
  if (!userId) return null;
  try {
    const { start: startTask } = await import('../tasks/service.js');
    const { toSafeText } = await import('@k8s-hosting/api-contracts');
    const action: 'suspend' | 'reactivate' | 'delete' =
      kind === 'client.suspend.bulk' ? 'suspend'
      : kind === 'client.reactivate.bulk' ? 'reactivate'
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
        modalProps: { bulkOpId, action, clientCount },
      },
      progressPct: 0,
      details: { bulkOpId, clientCount },
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
      error: failedCount > 0 ? `${failedCount} client(s) failed — see children for detail` : null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[bulk] task tracker finalize failed for parent ${parentTaskId}: ${msg}`);
  }
}
