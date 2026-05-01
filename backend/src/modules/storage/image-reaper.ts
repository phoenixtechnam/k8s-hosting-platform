/**
 * Image Reaper — Phase 1 eager image cleanup after deployment deletion.
 *
 * Public API:
 *   scheduleReap(db, k8s, input)  — fire-and-forget after graceMs delay
 *   reapImageNow(db, k8s, input)  — synchronous reap with in-use safety check
 *
 * Safety contract:
 *   Before issuing any `crictl rmi` call the reaper checks whether any live
 *   pod still references the image via getInUseImages(). Deployment deletion
 *   is async (the workload pod may still be Terminating), so the grace period
 *   (default 5 min) lets the pod vanish before we attempt removal.
 *
 * Persistence:
 *   Every reap attempt (success, skip, or error) is recorded in the
 *   image_reap_log table (migration 0064) so operators can audit what was
 *   removed and why.
 *
 * Multi-replica note:
 *   scheduleReap uses setTimeout — "at-most-once-per-replica". With N replicas
 *   all scheduling the same image, N reap pods may run concurrently. crictl rmi
 *   is idempotent on missing images so duplicate reaps are safe but wasteful.
 *   A proper distributed lock (BullMQ, advisory lock) is deferred for Phase 2.
 */

import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { Database } from '../../db/index.js';
import { imageReapLog } from '../../db/schema.js';
import { getInUseImages, runPurgeOnNode } from './service.js';

export interface ReapInput {
  /** Canonical image ref — with tag or digest (e.g. `ghcr.io/foo/bar:v1.2.3`). */
  image: string;
  triggeredBy: 'deployment_delete' | 'manual_purge' | 'pressure_watcher';
  /** deployment_id | actor_id | node_name — context for the audit log */
  triggerRef?: string;
  /** Delay before reaping. Defaults to 5 minutes to let terminating pods vanish. */
  graceMs?: number;
}

export interface ReapResult {
  reclaimedBytes: number;
  nodes: string[];
  /** true when the image is still in use or already absent from all nodes */
  skipped: boolean;
  reason?: string;
}

const DEFAULT_GRACE_MS = 5 * 60 * 1000;

/**
 * Schedule a reap after graceMs milliseconds — fire-and-forget.
 * Errors inside the reap are logged via imageReapLog but are not thrown.
 */
export function scheduleReap(db: Database, k8s: K8sClients, input: ReapInput): void {
  const grace = input.graceMs ?? DEFAULT_GRACE_MS;
  setTimeout(() => {
    reapImageNow(db, k8s, input).catch(() => {
      // reapImageNow already logs failures via imageReapLog — nothing more to do
    });
  }, grace);
}

/**
 * Reap `input.image` from every node that still holds a copy, unless any
 * running pod still references the image (in which case the reap is skipped
 * and the skip is logged).
 *
 * Idempotent: if the image is already gone from all nodes the function returns
 * immediately with `{ skipped: true, reason: 'not_present' }`.
 */
export async function reapImageNow(
  db: Database,
  k8s: K8sClients,
  input: ReapInput,
): Promise<ReapResult> {
  const { image, triggeredBy, triggerRef } = input;

  // ── 1. In-use guard ────────────────────────────────────────────────────────
  const inUseSet = await getInUseImages(k8s);
  if (inUseSet.has(image)) {
    await insertLog(db, { imageName: image, triggeredBy, triggerRef, succeeded: false, error: 'image still in use — skipped' });
    return { reclaimedBytes: 0, nodes: [], skipped: true, reason: 'in_use' };
  }

  // ── 2. Find which nodes have the image ────────────────────────────────────
  let nodeList: readonly { metadata?: { name?: string }; status?: { images?: readonly { names?: readonly string[] | null; sizeBytes?: number }[] } }[] = [];
  try {
    const raw = await k8s.core.listNode();
    nodeList = (raw as { items?: typeof nodeList }).items ?? [];
  } catch {
    await insertLog(db, { imageName: image, triggeredBy, triggerRef, succeeded: false, error: 'k8s listNode failed' });
    return { reclaimedBytes: 0, nodes: [], skipped: false, reason: 'k8s_error' };
  }

  const nodePresences: { node: string; sizeBytes: number }[] = [];
  for (const node of nodeList) {
    const nodeName = node.metadata?.name ?? 'unknown';
    const images = node.status?.images ?? [];
    for (const img of images) {
      const names = img.names ?? [];
      const matches = names.some(n =>
        n === image ||
        n.replace(/^docker\.io\/library\//, '') === image.replace(/^docker\.io\/library\//, ''),
      );
      if (matches) {
        nodePresences.push({ node: nodeName, sizeBytes: img.sizeBytes ?? 0 });
        break;
      }
    }
  }

  if (nodePresences.length === 0) {
    // Already gone — idempotent success
    await insertLog(db, { imageName: image, triggeredBy, triggerRef, succeeded: true, bytesReclaimed: 0, nodesReclaimed: [] });
    return { reclaimedBytes: 0, nodes: [], skipped: true, reason: 'not_present' };
  }

  // ── 3. Reap on each node ───────────────────────────────────────────────────
  const reclaimedNodes: string[] = [];
  let totalBytes = 0;
  const errors: string[] = [];

  for (const presence of nodePresences) {
    const result = await runPurgeOnNode(k8s, presence.node, [{
      crictlName: image,
      displayName: image,
      sizeBytes: presence.sizeBytes,
    }]);
    if (result.removedDisplayNames.length > 0) {
      reclaimedNodes.push(presence.node);
      totalBytes += result.freedBytes;
    }
    if (result.podError) errors.push(result.podError);
    if (result.failedDisplayNames.length > 0) {
      errors.push(`failed on ${presence.node}: ${result.failedDisplayNames.join(', ')}`);
    }
  }

  const succeeded = reclaimedNodes.length > 0;
  await insertLog(db, {
    imageName: image,
    triggeredBy,
    triggerRef,
    succeeded,
    bytesReclaimed: totalBytes,
    nodesReclaimed: reclaimedNodes,
    error: errors.length > 0 ? errors.join('; ') : undefined,
  });

  return { reclaimedBytes: totalBytes, nodes: reclaimedNodes, skipped: false };
}

// ── Internal helpers ─────────────────────────────────────────────────────────

async function insertLog(
  db: Database,
  row: {
    imageName: string;
    triggeredBy: 'deployment_delete' | 'manual_purge' | 'pressure_watcher';
    triggerRef?: string;
    succeeded: boolean;
    bytesReclaimed?: number;
    nodesReclaimed?: string[];
    error?: string;
  },
): Promise<void> {
  try {
    await db.insert(imageReapLog).values({
      imageName: row.imageName,
      triggeredBy: row.triggeredBy,
      triggerRef: row.triggerRef ?? null,
      succeeded: row.succeeded,
      bytesReclaimed: row.bytesReclaimed ?? 0,
      nodesReclaimed: row.nodesReclaimed ?? [],
      error: row.error ?? null,
    });
  } catch {
    // Non-fatal: logging failure must not break the caller
  }
}
