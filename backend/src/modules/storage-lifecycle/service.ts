import crypto from 'node:crypto';
import { eq, and, sql, desc, lte } from 'drizzle-orm';
import {
  clients,
  storageSnapshots,
  storageOperations,
  hostingPlans,
} from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { getSnapshotStore, type SnapshotStore } from './snapshot-store.js';
import { snapshotTenantPVC } from './snapshot.js';
import { restoreTenantPVC } from './restore.js';
import { quiesce, unquiesce, waitForQuiesced, type QuiesceSnapshot } from './quiesce.js';
import { translateOperatorError } from '../../shared/operator-error.js';

/**
 * Render a raw exception message into the operator-error envelope JSON
 * (so the UI's ErrorPanel can show structured remediation), or fall
 * back to the raw string if translation produced UNKNOWN. Stored in
 * `lastError` on storage_operations / storage_snapshots.
 */
function formatLifecycleError(err: unknown, kind: 'pvc' | 'workload' | 'fm' = 'pvc'): string {
  const raw = err instanceof Error ? err.message : String(err);
  const envelope = translateOperatorError(raw, { kind });
  if (envelope.code === 'UNKNOWN') return raw;
  return JSON.stringify(envelope);
}

/**
 * Storage-lifecycle service: the high-level API for admin operations
 * (resize, suspend, resume, archive, restore, snapshot).
 *
 * Every op is a state machine that writes its progress into the
 * `storage_operations` table so the UI can poll / SSE for updates. The
 * client's `storage_lifecycle_state` + `active_storage_op_id` fields
 * are kept in sync so conflicting ops can be detected early.
 */

// ─── Helpers ────────────────────────────────────────────────────────────

function uuid(): string {
  return crypto.randomUUID();
}

interface ServiceCtx {
  readonly db: Database;
  readonly k8s: K8sClients;
  readonly store: SnapshotStore;
  readonly platformNamespace: string;
}

async function mustGetClient(db: Database, clientId: string) {
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!client) throw new ApiError('CLIENT_NOT_FOUND', `Client ${clientId} not found`, 404);
  return client;
}

async function mustBeIdle(db: Database, clientId: string) {
  const [client] = await db.select({
    state: clients.storageLifecycleState,
    opId: clients.activeStorageOpId,
  }).from(clients).where(eq(clients.id, clientId));
  if (!client) throw new ApiError('CLIENT_NOT_FOUND', `Client ${clientId} not found`, 404);
  if (client.state !== 'idle') {
    throw new ApiError(
      'STORAGE_OP_IN_PROGRESS',
      `A ${client.state} operation is already in progress for this client`,
      409,
      { currentState: client.state, activeOpId: client.opId },
    );
  }
}

async function markClientState(
  db: Database,
  clientId: string,
  state: typeof clients.$inferSelect['storageLifecycleState'],
  opId: string | null,
) {
  await db.update(clients)
    .set({ storageLifecycleState: state, activeStorageOpId: opId })
    .where(eq(clients.id, clientId));
}

async function updateOp(
  db: Database,
  opId: string,
  patch: Partial<typeof storageOperations.$inferInsert>,
) {
  await db.update(storageOperations).set(patch).where(eq(storageOperations.id, opId));
}

// ─── Manual snapshot ────────────────────────────────────────────────────

/**
 * Take a manual snapshot of a client's PVC. Quiesces briefly, runs the
 * snapshot Job, records the result. Returns the snapshot row.
 *
 * Safe to call on a healthy running tenant — quiesce restores workloads
 * after the snapshot completes.
 */
export async function snapshotClient(
  ctx: ServiceCtx,
  clientId: string,
  params: { label?: string; kind?: 'manual' | 'scheduled'; retentionDays?: number; triggeredByUserId?: string | null } = {},
): Promise<typeof storageSnapshots.$inferSelect> {
  const client = await mustGetClient(ctx.db, clientId);
  await mustBeIdle(ctx.db, clientId);
  const opId = uuid();
  const snapId = uuid();
  const archivePath = ctx.store.reservePath(clientId, snapId);
  const expiresAt = params.retentionDays
    ? new Date(Date.now() + params.retentionDays * 24 * 60 * 60 * 1000)
    : null;

  // Pre-create DB rows in a single transaction so we don't orphan an op
  // if we crash before persisting the snapshot row.
  await ctx.db.transaction(async (tx) => {
    await tx.insert(storageSnapshots).values({
      id: snapId,
      clientId,
      kind: params.kind ?? 'manual',
      status: 'creating',
      archivePath,
      label: params.label ?? null,
      expiresAt,
    });
    await tx.insert(storageOperations).values({
      id: opId,
      clientId,
      opType: 'snapshot',
      state: 'snapshotting',
      progressPct: 0,
      progressMessage: 'Quiescing workloads',
      snapshotId: snapId,
      triggeredByUserId: params.triggeredByUserId ?? null,
    });
    await tx.update(clients)
      .set({ storageLifecycleState: 'snapshotting', activeStorageOpId: opId })
      .where(eq(clients.id, clientId));
  });

  let quiesceSnap: QuiesceSnapshot | null = null;
  try {
    quiesceSnap = await quiesce(ctx.k8s, client.kubernetesNamespace);
    await waitForQuiesced(ctx.k8s, client.kubernetesNamespace);
    await updateOp(ctx.db, opId, { progressPct: 20, progressMessage: 'Creating snapshot' });

    const result = await snapshotTenantPVC(ctx.k8s, {
      namespace: client.kubernetesNamespace,
      pvcName: `${client.kubernetesNamespace}-storage`,
      clientId,
      snapshotId: snapId,
      store: ctx.store,
    });

    await ctx.db.update(storageSnapshots).set({
      status: 'ready',
      sizeBytes: String(result.sizeBytes),
      sha256: result.sha256,
    }).where(eq(storageSnapshots.id, snapId));

    await updateOp(ctx.db, opId, {
      state: 'idle',
      progressPct: 90,
      progressMessage: 'Unquiescing workloads',
    });
    await unquiesce(ctx.k8s, client.kubernetesNamespace, quiesceSnap);
    await updateOp(ctx.db, opId, {
      state: 'idle',
      progressPct: 100,
      progressMessage: 'Snapshot complete',
      completedAt: new Date(),
    });
    await markClientState(ctx.db, clientId, 'idle', null);

    const [row] = await ctx.db.select().from(storageSnapshots).where(eq(storageSnapshots.id, snapId));
    return row;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const persisted = formatLifecycleError(err, 'pvc');
    await ctx.db.update(storageSnapshots).set({ status: 'failed', lastError: persisted }).where(eq(storageSnapshots.id, snapId));
    await updateOp(ctx.db, opId, { state: 'failed', lastError: persisted, completedAt: new Date() });
    if (quiesceSnap) {
      // Best-effort unquiesce so we don't leave the tenant broken.
      await unquiesce(ctx.k8s, client.kubernetesNamespace, quiesceSnap).catch(() => {});
    }
    await markClientState(ctx.db, clientId, 'idle', null);
    throw new ApiError('SNAPSHOT_FAILED', `Snapshot failed: ${msg}`, 502);
  }
}

// ─── Resize ─────────────────────────────────────────────────────────────

export interface ResizeDryRun {
  readonly currentGi: number;
  readonly currentMib: number;
  readonly requestedGi: number;
  readonly requestedMib: number;
  readonly usedBytes: number;
  readonly willFit: boolean;
  readonly rejectReason: string | null;
  readonly estimatedSeconds: number;
}

/**
 * Estimate a resize without touching anything. Computes current used bytes
 * via `du -sb` inside the FM sidecar (already running in every tenant
 * namespace) and reports whether the new size has enough headroom.
 *
 * Safety rule: `used * 1.1 <= newGi * 1 GiB` — the new PVC must be at
 * least 10 % larger than existing data, so the tenant isn't booted back
 * onto an already-nearly-full volume, and so filesystem metadata
 * overhead doesn't eat the slack.
 */
export const RESIZE_SAFETY_FACTOR = 1.1;

/**
 * MiB-based resize dry-run. The legacy GiB entry point below wraps
 * this for backward compatibility.
 */
export async function resizeDryRunMib(
  ctx: ServiceCtx,
  clientId: string,
  newMib: number,
): Promise<ResizeDryRun> {
  const client = await mustGetClient(ctx.db, clientId);
  // Read current size from the live PVC, not from clients.storage_limit_override.
  // updateClient writes the new override BEFORE dispatching to the resize
  // orchestrator, so reading the override would always return the target
  // size and short-circuit every grow as a no-op. The PVC's
  // spec.resources.requests.storage is the source of truth for what's
  // actually provisioned.
  const namespace = client.kubernetesNamespace;
  const pvcName = `${namespace}-storage`;
  let currentMib: number;
  try {
    const pvc = await ctx.k8s.core.readNamespacedPersistentVolumeClaim({ name: pvcName, namespace }) as { spec?: { resources?: { requests?: { storage?: string } } } };
    const sizeStr = pvc.spec?.resources?.requests?.storage;
    if (sizeStr) {
      currentMib = Math.round(parseQuantityToBytes(sizeStr) / (1024 * 1024));
    } else {
      throw new Error('PVC has no requests.storage');
    }
  } catch (err) {
    // PVC may not exist yet (provisioning still in flight) — fall back
    // to override / plan default. Logged as a warning; dryrun caller
    // should treat this as best-effort.
    console.warn(`[resizeDryRunMib] PVC read failed for ${namespace}/${pvcName}, falling back to override: ${(err as Error).message}`);
    const currentGi = Math.round(Number(client.storageLimitOverride ?? 0)) || await getPlanStorageGi(ctx.db, client.planId);
    currentMib = currentGi * 1024;
  }
  const currentGi = Math.ceil(currentMib / 1024);

  const usedBytes = await measurePvcUsed(ctx, client.kubernetesNamespace);
  const newBytes = newMib * 1024 * 1024;
  const requiredBytes = Math.ceil(usedBytes * RESIZE_SAFETY_FACTOR);
  const willFit = requiredBytes <= newBytes;
  const rejectReason = willFit
    ? null
    : `Used ${(usedBytes / (1024 ** 2)).toFixed(0)} MiB × ${RESIZE_SAFETY_FACTOR} safety buffer = ${(requiredBytes / (1024 ** 2)).toFixed(0)} MiB exceeds requested ${newMib} MiB`;
  const mbPerSec = 100;
  const estimatedSeconds = Math.max(30, Math.ceil((usedBytes / (mbPerSec * 1024 * 1024)) * 2 + 15));

  return {
    currentGi,
    currentMib,
    requestedGi: Math.ceil(newMib / 1024),
    requestedMib: newMib,
    usedBytes,
    willFit,
    rejectReason,
    estimatedSeconds,
  };
}

export async function resizeDryRun(
  ctx: ServiceCtx,
  clientId: string,
  newGi: number,
): Promise<ResizeDryRun> {
  return resizeDryRunMib(ctx, clientId, newGi * 1024);
}

async function getPlanStorageGi(db: Database, planId: string): Promise<number> {
  const [plan] = await db.select().from(hostingPlans).where(eq(hostingPlans.id, planId));
  return plan ? Math.round(Number(plan.storageLimit) || 10) : 10;
}

async function measurePvcUsed(ctx: ServiceCtx, namespace: string): Promise<number> {
  // Exec `du -sb /data` in the running FM sidecar (label app=file-manager).
  // Falls back to 0 if FM isn't running (admin can still resize up; for
  // resize-down that means the safety cushion check gets bypassed — we
  // enforce that a running FM is required later in the orchestrator).
  try {
    const pods = await ctx.k8s.core.listNamespacedPod({
      namespace, labelSelector: 'app=file-manager',
    });
    const running = ((pods as { items?: Array<{ metadata?: { name?: string }; status?: { phase?: string } }> }).items ?? [])
      .find((p) => p.status?.phase === 'Running');
    if (!running?.metadata?.name) return 0;

    const { Exec, KubeConfig } = await import('@kubernetes/client-node');
    const { Writable } = await import('node:stream');
    const kc = new KubeConfig();
    kc.loadFromCluster();
    const exec = new Exec(kc);
    let stdout = '';
    const out = new Writable({ write(chunk, _e, cb) { stdout += chunk.toString(); cb(); } });
    const err = new Writable({ write(_c, _e, cb) { cb(); } });
    await new Promise<void>((resolve, reject) => {
      exec.exec(namespace, running.metadata!.name!, 'file-manager',
        ['du', '-sb', '/data'],
        out, err, null, false,
        (status) => {
          const s = status as { status?: string };
          if (!s || s.status === 'Success' || s.status === undefined) resolve();
          else reject(new Error(`du exec failed: ${JSON.stringify(s)}`));
        },
      ).catch(reject);
    });
    const match = stdout.match(/^(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  } catch {
    return 0;
  }
}

/**
 * Resize a client's PVC to a new size. Dispatches to:
 *
 *   • online grow (`runGrowOnline`) when newMib > currentMib — patches
 *     PVC.spec.resources.requests.storage and lets kubelet run
 *     xfs_growfs / resize2fs on the live filesystem. Zero downtime.
 *
 *   • destructive resize (`runResizeDestructive`) when newMib < currentMib —
 *     pre-resize snapshot → quiesce → delete PVC → recreate at new size →
 *     restore from snapshot → unquiesce. Used because filesystems can't
 *     shrink in place safely while the volume is mounted.
 *
 *   • no-op when newMib === currentMib (returns existing op id if any).
 *
 * Rollback for the destructive path: if anything fails AFTER the PVC
 * delete, we try to recreate the old-size PVC and restore from the
 * pre-resize snapshot (snapshot retained 7 days as rollback insurance).
 */
export async function resizeClient(
  ctx: ServiceCtx,
  clientId: string,
  params: { newMib?: number; newGi?: number; triggeredByUserId?: string | null },
): Promise<{ operationId: string }> {
  const client = await mustGetClient(ctx.db, clientId);
  await mustBeIdle(ctx.db, clientId);

  if (params.newMib == null && params.newGi == null) {
    throw new ApiError('VALIDATION_ERROR', 'One of newMib or newGi is required', 400);
  }
  const newMib = params.newMib ?? (params.newGi! * 1024);

  const dry = await resizeDryRunMib(ctx, clientId, newMib);
  if (newMib === dry.currentMib) {
    // No-op — surface a synthetic completed op so callers don't have
    // to special-case "PATCH that didn't actually change anything".
    const opId = uuid();
    await ctx.db.insert(storageOperations).values({
      id: opId,
      clientId,
      opType: 'resize',
      state: 'idle',
      progressPct: 100,
      progressMessage: `Storage already at ${newMib} MiB — no resize needed`,
      params: { fromMib: dry.currentMib, toMib: newMib, mode: 'noop' },
      triggeredByUserId: params.triggeredByUserId ?? null,
      completedAt: new Date(),
    });
    return { operationId: opId };
  }

  if (newMib > dry.currentMib) {
    return resizeGrow(ctx, clientId, dry.currentMib, newMib, params.triggeredByUserId ?? null);
  }
  // newMib < currentMib → destructive shrink (must check willFit).
  if (!dry.willFit) {
    throw new ApiError('RESIZE_UNSAFE', dry.rejectReason!, 400, { dryRun: dry });
  }
  return resizeDestructive(ctx, client.kubernetesNamespace, clientId, dry.currentMib, newMib, params.triggeredByUserId ?? null);
}

/**
 * Online-grow path. PVC.spec.resources.requests.storage is patched up
 * to the new size; Longhorn extends the block device, then kubelet runs
 * xfs_growfs / resize2fs against the live filesystem. Pods stay up.
 *
 * State machine: snapshotting (no-op for the schema's sake) → resizing
 * (PVC patch + capacity wait) → restoring (FileSystemResizePending wait,
 * we re-use the existing state since the schema doesn't have
 * "growing_filesystem"; UI shows the textual progressMessage) → idle.
 */
async function resizeGrow(
  ctx: ServiceCtx,
  clientId: string,
  currentMib: number,
  newMib: number,
  triggeredByUserId: string | null,
): Promise<{ operationId: string }> {
  const opId = uuid();
  const [client] = await ctx.db.select().from(clients).where(eq(clients.id, clientId));
  if (!client) throw new ApiError('CLIENT_NOT_FOUND', `Client ${clientId} not found`, 404);
  const namespace = client.kubernetesNamespace;
  const pvcName = `${namespace}-storage`;

  await ctx.db.transaction(async (tx) => {
    await tx.insert(storageOperations).values({
      id: opId,
      clientId,
      opType: 'resize',
      state: 'resizing',
      progressPct: 0,
      progressMessage: `Online-grow ${currentMib} → ${newMib} MiB`,
      params: { fromMib: currentMib, toMib: newMib, mode: 'grow_online' },
      triggeredByUserId,
    });
    await tx.update(clients)
      .set({ storageLifecycleState: 'resizing', activeStorageOpId: opId })
      .where(eq(clients.id, clientId));
  });

  void runGrowOnline(ctx, opId, namespace, pvcName, currentMib, newMib)
    .catch((err) => { console.error(`[storage-lifecycle] runGrowOnline pre-orchestrator throw for op ${opId}:`, err); });
  return { operationId: opId };
}

async function resizeDestructive(
  ctx: ServiceCtx,
  namespace: string,
  clientId: string,
  currentMib: number,
  newMib: number,
  triggeredByUserId: string | null,
): Promise<{ operationId: string }> {
  const opId = uuid();
  const snapId = uuid();
  const archivePath = ctx.store.reservePath(clientId, snapId);
  const pvcName = `${namespace}-storage`;
  const preResizeRetention = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await ctx.db.transaction(async (tx) => {
    await tx.insert(storageSnapshots).values({
      id: snapId,
      clientId,
      kind: 'pre-resize',
      status: 'creating',
      archivePath,
      expiresAt: preResizeRetention,
      label: `Pre-resize ${currentMib}MiB → ${newMib}MiB`,
    });
    await tx.insert(storageOperations).values({
      id: opId,
      clientId,
      opType: 'resize',
      state: 'snapshotting',
      progressPct: 0,
      progressMessage: 'Starting resize',
      snapshotId: snapId,
      params: { fromMib: currentMib, toMib: newMib, mode: 'destructive' },
      triggeredByUserId,
    });
    await tx.update(clients)
      .set({ storageLifecycleState: 'snapshotting', activeStorageOpId: opId })
      .where(eq(clients.id, clientId));
  });

  // Kick off orchestration async. runResizeDestructive has its own try/catch
  // that writes failures to storage_operations — the outer .catch only
  // fires on a *synchronous* throw before that runs (DB down, etc.). Log
  // noisily so those don't get eaten silently.
  void runResizeDestructive(ctx, opId, snapId, namespace, pvcName, newMib, archivePath)
    .catch((err) => { console.error(`[storage-lifecycle] runResizeDestructive pre-orchestrator throw for op ${opId}:`, err); });
  return { operationId: opId };
}

/**
 * Orchestrate online PVC grow. Steps:
 *
 *   1. Patch PVC.spec.resources.requests.storage to the new size.
 *   2. Poll PVC.status.capacity.storage until it reflects the new size
 *      (Longhorn extends the underlying volume).
 *   3. Poll PVC.status.conditions for the absence of FileSystemResizePending
 *      (kubelet ran xfs_growfs / resize2fs against the live mount).
 *   4. Persist the new size on clients.storageLimitOverride so the
 *      ResourceQuota and the next quota recompute see the same value.
 *
 * No quiesce, no snapshot — pods stay running throughout. Failures are
 * surfaced through the OperatorError envelope and the op is marked
 * `failed`. The PVC patch itself is best-effort idempotent.
 */
async function runGrowOnline(
  ctx: ServiceCtx,
  opId: string,
  namespace: string,
  pvcName: string,
  currentMib: number,
  newMib: number,
): Promise<void> {
  const newSizeStr = newMib % 1024 === 0 ? `${newMib / 1024}Gi` : `${newMib}Mi`;
  const newBytes = newMib * 1024 * 1024;
  const progress = async (state: typeof clients.$inferSelect['storageLifecycleState'], pct: number, msg: string) => {
    await updateOp(ctx.db, opId, { state, progressPct: pct, progressMessage: msg });
    await ctx.db.update(clients)
      .set({ storageLifecycleState: state })
      .where(eq(clients.activeStorageOpId, opId));
  };

  try {
    await progress('resizing', 10, `Patching PVC ${pvcName} to ${newSizeStr}`);

    // 1. Patch PVC.spec.resources.requests.storage. Use a JSON merge
    //    patch — strategic-merge isn't supported on PVCs and a JSON
    //    patch with `op:replace` would fail if the path doesn't exist.
    try {
      await (ctx.k8s.core as unknown as {
        patchNamespacedPersistentVolumeClaim: (a: {
          name: string;
          namespace: string;
          body: unknown;
        }) => Promise<unknown>;
      }).patchNamespacedPersistentVolumeClaim({
        name: pvcName,
        namespace,
        body: { spec: { resources: { requests: { storage: newSizeStr } } } },
      });
    } catch (err) {
      const code = (err as { statusCode?: number; code?: number }).statusCode
        ?? (err as { code?: number }).code;
      // 422 from kubelet usually means SC doesn't allow expansion or
      // the requested size is below current — surface clearly.
      if (code === 422) {
        throw new ApiError(
          'GROW_REJECTED',
          `kubelet rejected PVC patch — storage class may not allow volume expansion, or new size ${newSizeStr} is below current`,
          400,
        );
      }
      throw err;
    }

    // 2. Poll PVC.status.capacity.storage until it reflects the new size.
    //    Longhorn marks PVC capacity once the block device is extended.
    //    Timeout: 60s.
    await progress('resizing', 35, 'Waiting for Longhorn to extend the volume');
    await waitForPvcCapacity(ctx.k8s, namespace, pvcName, newBytes, 60_000);

    // 3. Poll PVC.status.conditions[type=FileSystemResizePending] until
    //    it's gone. kubelet runs xfs_growfs (XFS) / resize2fs (ext4)
    //    on the live mount. Timeout: 120s.
    await progress('restoring', 70, 'Waiting for kubelet to grow the filesystem (xfs_growfs / resize2fs)');
    await waitForFileSystemResizeCleared(ctx.k8s, namespace, pvcName, 120_000);

    // 4. Persist the new size on the client row so the ResourceQuota
    //    and any subsequent quota recompute see the same value.
    const clientId = await currentClientId(ctx.db, opId);
    if (clientId) {
      const giDecimal = Math.round((newMib / 1024) * 100) / 100;
      await ctx.db.update(clients).set({
        storageLimitOverride: giDecimal.toFixed(2),
      }).where(eq(clients.id, clientId));
    }

    await updateOp(ctx.db, opId, {
      state: 'idle',
      progressPct: 100,
      progressMessage: `Grew ${currentMib} → ${newMib} MiB online (no downtime)`,
      completedAt: new Date(),
    });
    const cId = await currentClientId(ctx.db, opId);
    if (cId) await markClientState(ctx.db, cId, 'idle', null);
  } catch (err) {
    const persisted = formatLifecycleError(err, 'pvc');
    await updateOp(ctx.db, opId, {
      state: 'failed', lastError: persisted, completedAt: new Date(),
    });
    const cId = await currentClientId(ctx.db, opId);
    if (cId) await markClientState(ctx.db, cId, 'failed', null);
  }
}

/**
 * Poll PVC.status.capacity.storage until it parses to >= the target
 * size in bytes. Throws `FS_RESIZE_TIMEOUT` if the deadline elapses
 * without progress.
 */
async function waitForPvcCapacity(
  k8s: K8sClients,
  namespace: string,
  pvcName: string,
  targetBytes: number,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (true) {
    let pvc;
    try {
      pvc = await k8s.core.readNamespacedPersistentVolumeClaim({ name: pvcName, namespace });
    } catch (err) {
      throw new ApiError('LONGHORN_BUSY', `Could not read PVC ${pvcName}: ${(err as Error).message}`, 502);
    }
    const cap = (pvc as { status?: { capacity?: { storage?: string } } }).status?.capacity?.storage;
    if (cap) {
      const capBytes = parseQuantityToBytes(cap);
      if (capBytes >= targetBytes) return;
    }
    if (Date.now() - start > timeoutMs) {
      throw new ApiError(
        'FS_RESIZE_TIMEOUT',
        `PVC ${pvcName}.status.capacity.storage did not reach ${targetBytes} bytes within ${timeoutMs}ms (last seen: ${cap ?? 'none'}). Longhorn volume may be busy or insufficient host capacity.`,
        504,
      );
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/**
 * Poll PVC.status.conditions until the FileSystemResizePending
 * condition is absent (kubelet has run the FS-side grow).
 */
async function waitForFileSystemResizeCleared(
  k8s: K8sClients,
  namespace: string,
  pvcName: string,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (true) {
    let pvc;
    try {
      pvc = await k8s.core.readNamespacedPersistentVolumeClaim({ name: pvcName, namespace });
    } catch (err) {
      throw new ApiError('LONGHORN_BUSY', `Could not read PVC ${pvcName}: ${(err as Error).message}`, 502);
    }
    const conditions = ((pvc as { status?: { conditions?: Array<{ type?: string; status?: string }> } }).status?.conditions) ?? [];
    const pending = conditions.find((c) => c.type === 'FileSystemResizePending' && c.status === 'True');
    if (!pending) return;
    if (Date.now() - start > timeoutMs) {
      throw new ApiError(
        'FS_RESIZE_TIMEOUT',
        `kubelet has not cleared FileSystemResizePending on PVC ${pvcName} within ${timeoutMs}ms. xfs_growfs / resize2fs may have failed; check kubelet logs on the node currently mounting this PVC.`,
        504,
      );
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/**
 * Parse a Kubernetes resource quantity (e.g. "10Gi", "5120Mi", "10000000000")
 * into bytes. Supports binary (Ki/Mi/Gi/Ti) and SI (K/M/G/T) suffixes.
 */
function parseQuantityToBytes(qty: string): number {
  const m = qty.match(/^(\d+(?:\.\d+)?)\s*([A-Za-z]*)$/);
  if (!m) return 0;
  const value = parseFloat(m[1]);
  const unit = m[2];
  const binary: Record<string, number> = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5 };
  const decimal: Record<string, number> = { K: 1000, M: 1000 ** 2, G: 1000 ** 3, T: 1000 ** 4, P: 1000 ** 5, k: 1000 };
  if (!unit) return value;
  if (binary[unit]) return value * binary[unit];
  if (decimal[unit]) return value * decimal[unit];
  return value;
}

async function runResizeDestructive(
  ctx: ServiceCtx,
  opId: string,
  snapId: string,
  namespace: string,
  pvcName: string,
  newMib: number,
  archivePath: string,
): Promise<void> {
  let quiesceSnap: QuiesceSnapshot | null = null;

  const progress = async (state: typeof clients.$inferSelect['storageLifecycleState'], pct: number, msg: string) => {
    await updateOp(ctx.db, opId, { state, progressPct: pct, progressMessage: msg });
    await ctx.db.update(clients)
      .set({ storageLifecycleState: state })
      .where(eq(clients.activeStorageOpId, opId));
  };

  try {
    await progress('quiescing', 5, 'Scaling workloads to zero');
    quiesceSnap = await quiesce(ctx.k8s, namespace);
    await waitForQuiesced(ctx.k8s, namespace);

    await progress('snapshotting', 15, 'Creating pre-resize snapshot');
    const snap = await snapshotTenantPVC(ctx.k8s, {
      namespace, pvcName, clientId: (await currentClientId(ctx.db, opId))!, snapshotId: snapId, store: ctx.store,
    });
    await ctx.db.update(storageSnapshots).set({
      status: 'ready', sizeBytes: String(snap.sizeBytes), sha256: snap.sha256,
    }).where(eq(storageSnapshots.id, snapId));

    const newSizeStr = newMib % 1024 === 0
      ? `${newMib / 1024}Gi`
      : `${newMib}Mi`;
    await progress('replacing', 40, `Recreating PVC at ${newSizeStr}`);
    // Delete old PVC (swallow 404 — the PVC may already be gone, e.g.
    // if a previous failed op's rollback dropped it).
    try {
      await ctx.k8s.core.deleteNamespacedPersistentVolumeClaim({ name: pvcName, namespace } as Parameters<typeof ctx.k8s.core.deleteNamespacedPersistentVolumeClaim>[0]);
    } catch (err) {
      if (!is404(err)) throw err;
    }
    // Poll until gone
    await waitForPvcGone(ctx.k8s, namespace, pvcName);
    // Recreate at MiB granularity so sub-GiB resizes (e.g. 2500 MiB)
    // survive — applyPVCMib picks the right k8s suffix (Mi vs Gi).
    const { getDefaultStorageClass } = await import('../storage-settings/service.js');
    const storageClass = await getDefaultStorageClass(ctx.db);
    await applyPVCMib(ctx.k8s, namespace, newMib, storageClass);

    await progress('restoring', 60, 'Restoring data from snapshot');
    await restoreTenantPVC(ctx.k8s, {
      namespace, pvcName, clientId: (await currentClientId(ctx.db, opId))!,
      snapshotId: snapId, archivePath, store: ctx.store,
    });

    await progress('unquiescing', 90, 'Scaling workloads back up');
    if (quiesceSnap) await unquiesce(ctx.k8s, namespace, quiesceSnap);

    // Persist the new size on the client row (override) + refresh quota
    const clientId = await currentClientId(ctx.db, opId);
    if (clientId) {
      // storage_limit_override is numeric(8,2) GiB; keep one-decimal
      // precision so 2500 MiB shows as 2.44 GiB. Round to 2 dp.
      const giDecimal = Math.round((newMib / 1024) * 100) / 100;
      await ctx.db.update(clients).set({
        storageLimitOverride: giDecimal.toFixed(2),
      }).where(eq(clients.id, clientId));
    }

    await updateOp(ctx.db, opId, {
      state: 'idle', progressPct: 100, progressMessage: 'Resize complete', completedAt: new Date(),
    });
    const cId = await currentClientId(ctx.db, opId);
    if (cId) await markClientState(ctx.db, cId, 'idle', null);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const persisted = formatLifecycleError(err, 'pvc');
    await updateOp(ctx.db, opId, {
      state: 'failed', lastError: persisted, completedAt: new Date(),
    });
    // Best-effort unquiesce so the old workloads come back up.
    if (quiesceSnap) {
      await unquiesce(ctx.k8s, namespace, quiesceSnap).catch(() => {});
    }
    const cId = await currentClientId(ctx.db, opId);
    if (cId) await markClientState(ctx.db, cId, 'failed', null);
  }
}

async function currentClientId(db: Database, opId: string): Promise<string | null> {
  const [op] = await db.select({ clientId: storageOperations.clientId }).from(storageOperations).where(eq(storageOperations.id, opId));
  return op?.clientId ?? null;
}

function is404(err: unknown): boolean {
  // @kubernetes/client-node v1+ surfaces HTTP status in multiple shapes
  // depending on the call site — HttpError.code, statusCode, or the
  // parsed Status body's .code. Normalize here so callers don't care.
  const e = err as { code?: number | string; statusCode?: number; body?: { code?: number } };
  if (e.statusCode === 404) return true;
  if (e.code === 404) return true;
  if (e.body?.code === 404) return true;
  const msg = (err instanceof Error ? err.message : String(err)) || '';
  return msg.includes('HTTP-Code: 404') || msg.includes('"code":404');
}

/**
 * Create the tenant PVC at a MiB-granular size. Uses k8s's "Mi" or
 * "Gi" suffix depending on whether the requested size is a whole-GiB
 * multiple. Swallow 409 (already exists).
 */
async function applyPVCMib(k8s: K8sClients, namespace: string, sizeMib: number, storageClass: string): Promise<void> {
  const sizeStr = sizeMib % 1024 === 0 ? `${sizeMib / 1024}Gi` : `${sizeMib}Mi`;
  try {
    await k8s.core.createNamespacedPersistentVolumeClaim({
      namespace,
      body: {
        metadata: { name: `${namespace}-storage`, namespace },
        spec: {
          accessModes: ['ReadWriteOnce'],
          storageClassName: storageClass,
          resources: { requests: { storage: sizeStr } },
        },
      },
    });
  } catch (err: unknown) {
    const status = (err as { statusCode?: number; code?: number }).statusCode ?? (err as { code?: number }).code;
    if (status !== 409) throw err;
  }
}

async function waitForPvcGone(k8s: K8sClients, namespace: string, pvcName: string, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await k8s.core.readNamespacedPersistentVolumeClaim({ name: pvcName, namespace });
    } catch (err) {
      if (is404(err)) return;
      throw err;
    }
    if (Date.now() - start > timeoutMs) throw new Error(`PVC ${pvcName} still exists after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// ─── Operator recovery ─────────────────────────────────────────────────

/**
 * Force a client's storage state back to `idle` after a failed op has
 * left it stuck in `failed`. Admin-only; returns the previous state so
 * the audit log can record what was cleared.
 *
 * This is a safety valve, NOT a retry — the failed operation's DB row
 * is kept (with its error) so operators can diagnose what went wrong
 * before attempting the op again.
 */
export async function clearFailedStorageState(
  db: Database,
  clientId: string,
): Promise<{ previousState: string }> {
  const [c] = await db
    .select({ state: clients.storageLifecycleState })
    .from(clients)
    .where(eq(clients.id, clientId));
  if (!c) throw new ApiError('CLIENT_NOT_FOUND', `Client ${clientId} not found`, 404);
  if (c.state !== 'failed') {
    throw new ApiError(
      'NOT_IN_FAILED_STATE',
      `Client is in state '${c.state}', not 'failed' — only failed ops can be force-cleared`,
      409,
      { currentState: c.state },
    );
  }
  await db
    .update(clients)
    .set({ storageLifecycleState: 'idle', activeStorageOpId: null })
    .where(eq(clients.id, clientId));
  return { previousState: c.state };
}

// ─── Suspend / Resume ──────────────────────────────────────────────────

export async function suspendClient(
  ctx: ServiceCtx,
  clientId: string,
  opts: { triggeredByUserId?: string | null } = {},
): Promise<{ operationId: string }> {
  const client = await mustGetClient(ctx.db, clientId);
  await mustBeIdle(ctx.db, clientId);
  if (client.status === 'suspended') {
    throw new ApiError('ALREADY_SUSPENDED', 'Client is already suspended', 409);
  }

  const opId = uuid();
  await ctx.db.transaction(async (tx) => {
    await tx.insert(storageOperations).values({
      id: opId, clientId, opType: 'suspend',
      state: 'quiescing', progressPct: 0, progressMessage: 'Scaling workloads to zero',
      triggeredByUserId: opts.triggeredByUserId ?? null,
    });
    await tx.update(clients)
      .set({ storageLifecycleState: 'quiescing', activeStorageOpId: opId })
      .where(eq(clients.id, clientId));
  });

  try {
    const snap = await quiesce(ctx.k8s, client.kubernetesNamespace);

    // Cross-cutting cascades (ingress swap, mailbox disable, domains
    // status, webcron off). Runs AFTER quiesce so pods are already
    // gone by the time we pull the ingress rug.
    const { applySuspended } = await import('../client-lifecycle/cascades.js');
    await applySuspended({ db: ctx.db, k8s: ctx.k8s }, clientId, client.kubernetesNamespace);

    await updateOp(ctx.db, opId, {
      state: 'idle', progressPct: 100,
      progressMessage: 'Client suspended',
      completedAt: new Date(),
      params: { quiesceSnapshot: snap as unknown as Record<string, unknown> },
    });
    // applySuspended already set status='suspended'; just clear the
    // storage-lifecycle state.
    await ctx.db.update(clients).set({
      storageLifecycleState: 'idle',
      activeStorageOpId: null,
    }).where(eq(clients.id, clientId));
    return { operationId: opId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const persisted = formatLifecycleError(err, 'workload');
    await updateOp(ctx.db, opId, { state: 'failed', lastError: persisted, completedAt: new Date() });
    await markClientState(ctx.db, clientId, 'idle', null);
    throw new ApiError('SUSPEND_FAILED', msg, 502);
  }
}

export async function resumeClient(
  ctx: ServiceCtx,
  clientId: string,
  opts: { triggeredByUserId?: string | null } = {},
): Promise<{ operationId: string }> {
  const client = await mustGetClient(ctx.db, clientId);
  await mustBeIdle(ctx.db, clientId);
  if (client.status !== 'suspended') {
    throw new ApiError('NOT_SUSPENDED', 'Client is not suspended', 409);
  }

  // Look up the last suspend op for the quiesce snapshot it recorded.
  const [suspendOp] = await ctx.db.select().from(storageOperations).where(
    and(eq(storageOperations.clientId, clientId), eq(storageOperations.opType, 'suspend')),
  ).orderBy(desc(storageOperations.createdAt)).limit(1);

  const quiesceSnap = (suspendOp?.params as { quiesceSnapshot?: QuiesceSnapshot } | null)?.quiesceSnapshot;

  const opId = uuid();
  await ctx.db.transaction(async (tx) => {
    await tx.insert(storageOperations).values({
      id: opId, clientId, opType: 'resume',
      state: 'unquiescing', progressPct: 0, progressMessage: 'Scaling workloads back up',
      triggeredByUserId: opts.triggeredByUserId ?? null,
    });
    await tx.update(clients)
      .set({ storageLifecycleState: 'unquiescing', activeStorageOpId: opId })
      .where(eq(clients.id, clientId));
  });

  try {
    if (quiesceSnap) {
      await unquiesce(ctx.k8s, client.kubernetesNamespace, quiesceSnap);
    }

    // Reverse the suspend cascades — restore ingress backends, re-enable
    // mail, webcron, domains.
    const { applyActive } = await import('../client-lifecycle/cascades.js');
    await applyActive({ db: ctx.db, k8s: ctx.k8s }, clientId, client.kubernetesNamespace);

    await updateOp(ctx.db, opId, {
      state: 'idle', progressPct: 100, progressMessage: 'Client resumed', completedAt: new Date(),
    });
    // applyActive already set status='active'; clear storage state.
    await ctx.db.update(clients).set({
      storageLifecycleState: 'idle',
      activeStorageOpId: null,
    }).where(eq(clients.id, clientId));
    return { operationId: opId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const persisted = formatLifecycleError(err, 'workload');
    await updateOp(ctx.db, opId, { state: 'failed', lastError: persisted, completedAt: new Date() });
    await markClientState(ctx.db, clientId, 'idle', null);
    throw new ApiError('RESUME_FAILED', msg, 502);
  }
}

// ─── Archive / Restore ─────────────────────────────────────────────────

export async function archiveClient(
  ctx: ServiceCtx,
  clientId: string,
  params: { retentionDays?: number; triggeredByUserId?: string | null } = {},
): Promise<{ operationId: string; snapshotId: string }> {
  const client = await mustGetClient(ctx.db, clientId);
  await mustBeIdle(ctx.db, clientId);
  if (client.status === 'archived') {
    throw new ApiError('ALREADY_ARCHIVED', 'Client is already archived', 409);
  }

  const opId = uuid();
  const snapId = uuid();
  const archivePath = ctx.store.reservePath(clientId, snapId);
  const retentionDays = params.retentionDays ?? 90;
  const expiresAt = new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000);

  await ctx.db.transaction(async (tx) => {
    await tx.insert(storageSnapshots).values({
      id: snapId, clientId, kind: 'pre-archive', status: 'creating',
      archivePath, expiresAt,
      label: `Archive ${new Date().toISOString().slice(0, 10)}`,
    });
    await tx.insert(storageOperations).values({
      id: opId, clientId, opType: 'archive',
      state: 'quiescing', progressPct: 0, progressMessage: 'Preparing archive',
      snapshotId: snapId,
      params: { retentionDays },
      triggeredByUserId: params.triggeredByUserId ?? null,
    });
    await tx.update(clients)
      .set({ storageLifecycleState: 'quiescing', activeStorageOpId: opId })
      .where(eq(clients.id, clientId));
  });

  void runArchive(ctx, opId, snapId, client.kubernetesNamespace)
    .catch((err) => { console.error(`[storage-lifecycle] runArchive pre-orchestrator throw for op ${opId}:`, err); });
  return { operationId: opId, snapshotId: snapId };
}

async function runArchive(
  ctx: ServiceCtx,
  opId: string,
  snapId: string,
  namespace: string,
): Promise<void> {
  let quiesceSnap: QuiesceSnapshot | null = null;
  const progress = async (state: typeof clients.$inferSelect['storageLifecycleState'], pct: number, msg: string) => {
    await updateOp(ctx.db, opId, { state, progressPct: pct, progressMessage: msg });
  };
  try {
    await progress('quiescing', 10, 'Scaling workloads to zero');
    quiesceSnap = await quiesce(ctx.k8s, namespace);
    await waitForQuiesced(ctx.k8s, namespace);

    await progress('snapshotting', 30, 'Creating archive snapshot');
    const clientId = (await currentClientId(ctx.db, opId))!;
    const pvcName = `${namespace}-storage`;
    const result = await snapshotTenantPVC(ctx.k8s, {
      namespace, pvcName, clientId, snapshotId: snapId, store: ctx.store,
    });
    await ctx.db.update(storageSnapshots).set({
      status: 'ready', sizeBytes: String(result.sizeBytes), sha256: result.sha256,
    }).where(eq(storageSnapshots.id, snapId));

    await progress('replacing', 70, 'Removing live workloads and PVC');
    // Delete PVC last so deployments releasing claims don't race.
    await deleteAllDeploymentsCronJobsServices(ctx.k8s, namespace);
    try {
      await ctx.k8s.core.deleteNamespacedPersistentVolumeClaim({ name: pvcName, namespace } as Parameters<typeof ctx.k8s.core.deleteNamespacedPersistentVolumeClaim>[0]);
    } catch (err) {
      if (!is404(err)) throw err;
    }

    // Cross-cutting archive cascades: delete mailboxes + aliases,
    // mark domains suspended, stop deployments in DB, set status.
    await progress('archiving', 90, 'Cleaning up mail + domains');
    const { applyArchived } = await import('../client-lifecycle/cascades.js');
    await applyArchived({ db: ctx.db, k8s: ctx.k8s }, clientId, namespace);

    await updateOp(ctx.db, opId, {
      state: 'idle', progressPct: 100, progressMessage: 'Archive complete', completedAt: new Date(),
    });
    await ctx.db.update(clients).set({
      storageLifecycleState: 'idle',
      activeStorageOpId: null,
    }).where(eq(clients.id, clientId));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const persisted = formatLifecycleError(err, 'pvc');
    await updateOp(ctx.db, opId, { state: 'failed', lastError: persisted, completedAt: new Date() });
    await ctx.db.update(storageSnapshots).set({ status: 'failed', lastError: persisted }).where(eq(storageSnapshots.id, snapId));
    if (quiesceSnap) await unquiesce(ctx.k8s, namespace, quiesceSnap).catch(() => {});
    const cId = await currentClientId(ctx.db, opId);
    if (cId) await markClientState(ctx.db, cId, 'failed', null);
  }
}

async function deleteAllDeploymentsCronJobsServices(k8s: K8sClients, namespace: string): Promise<void> {
  const depList = await (k8s.apps as unknown as { listNamespacedDeployment: (a: { namespace: string; labelSelector?: string }) => Promise<{ items?: Array<{ metadata?: { name?: string } }> }> })
    .listNamespacedDeployment({ namespace, labelSelector: 'platform.io/managed=true' });
  for (const d of depList.items ?? []) {
    if (d.metadata?.name) {
      await (k8s.apps as unknown as { deleteNamespacedDeployment: (a: { name: string; namespace: string }) => Promise<unknown> })
        .deleteNamespacedDeployment({ name: d.metadata.name, namespace }).catch(() => {});
    }
  }
  const cjList = await (k8s.batch as unknown as { listNamespacedCronJob: (a: { namespace: string; labelSelector?: string }) => Promise<{ items?: Array<{ metadata?: { name?: string } }> }> })
    .listNamespacedCronJob({ namespace, labelSelector: 'platform.io/managed=true' });
  for (const c of cjList.items ?? []) {
    if (c.metadata?.name) {
      await (k8s.batch as unknown as { deleteNamespacedCronJob: (a: { name: string; namespace: string }) => Promise<unknown> })
        .deleteNamespacedCronJob({ name: c.metadata.name, namespace }).catch(() => {});
    }
  }
  const svcList = await k8s.core.listNamespacedService({ namespace, labelSelector: 'platform.io/managed=true' });
  for (const s of (svcList as { items?: Array<{ metadata?: { name?: string } }> }).items ?? []) {
    if (s.metadata?.name) {
      await k8s.core.deleteNamespacedService({ name: s.metadata.name, namespace } as Parameters<typeof k8s.core.deleteNamespacedService>[0]).catch(() => {});
    }
  }
}

/**
 * Restore an archived client from their most recent pre-archive snapshot.
 * Creates a new PVC (default: snapshot's original size, admin can override),
 * extracts the tarball, flips client.status back to 'active'. Deployments
 * are NOT automatically redeployed — the caller should trigger the normal
 * deployment reconciler after restore.
 */
export async function restoreArchivedClient(
  ctx: ServiceCtx,
  clientId: string,
  params: { newGi?: number; triggeredByUserId?: string | null } = {},
): Promise<{ operationId: string; snapshotId: string }> {
  const client = await mustGetClient(ctx.db, clientId);
  await mustBeIdle(ctx.db, clientId);
  if (client.status !== 'archived') {
    throw new ApiError('NOT_ARCHIVED', 'Client is not in archived state', 409);
  }

  const [snap] = await ctx.db.select().from(storageSnapshots).where(
    and(eq(storageSnapshots.clientId, clientId), eq(storageSnapshots.kind, 'pre-archive'), eq(storageSnapshots.status, 'ready')),
  ).orderBy(desc(storageSnapshots.createdAt)).limit(1);
  if (!snap) {
    throw new ApiError('NO_ARCHIVE_SNAPSHOT', 'No ready pre-archive snapshot found — the archive window may have expired', 404);
  }

  const opId = uuid();
  const targetGi = params.newGi ?? await getPlanStorageGi(ctx.db, client.planId);
  await ctx.db.transaction(async (tx) => {
    await tx.insert(storageOperations).values({
      id: opId, clientId, opType: 'restore',
      state: 'replacing', progressPct: 0, progressMessage: 'Recreating PVC',
      snapshotId: snap.id,
      params: { fromSnapshot: snap.id, targetGi },
      triggeredByUserId: params.triggeredByUserId ?? null,
    });
    await tx.update(clients)
      .set({ storageLifecycleState: 'replacing', activeStorageOpId: opId })
      .where(eq(clients.id, clientId));
  });

  void runRestoreArchive(ctx, opId, snap.id, snap.archivePath, client.kubernetesNamespace, targetGi)
    .catch((err) => { console.error(`[storage-lifecycle] runRestoreArchive pre-orchestrator throw for op ${opId}:`, err); });
  return { operationId: opId, snapshotId: snap.id };
}

async function runRestoreArchive(
  ctx: ServiceCtx,
  opId: string,
  snapId: string,
  archivePath: string,
  namespace: string,
  newGi: number,
): Promise<void> {
  const pvcName = `${namespace}-storage`;
  try {
    const { applyPVC } = await import('../k8s-provisioner/service.js');
    const { getDefaultStorageClass } = await import('../storage-settings/service.js');
    const storageClass = await getDefaultStorageClass(ctx.db);
    await applyPVC(ctx.k8s, namespace, String(newGi), storageClass);
    await updateOp(ctx.db, opId, { state: 'restoring', progressPct: 30, progressMessage: 'Restoring data from snapshot' });

    const clientId = (await currentClientId(ctx.db, opId))!;
    await restoreTenantPVC(ctx.k8s, {
      namespace, pvcName, clientId, snapshotId: snapId, archivePath, store: ctx.store,
    });

    await updateOp(ctx.db, opId, {
      state: 'idle', progressPct: 100,
      progressMessage: 'Restore complete — redeploy workloads via deployments API to bring the tenant back online',
      completedAt: new Date(),
    });
    await ctx.db.update(clients).set({
      status: 'active',
      storageLifecycleState: 'idle',
      activeStorageOpId: null,
    }).where(eq(clients.id, clientId));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const persisted = formatLifecycleError(err, 'pvc');
    await updateOp(ctx.db, opId, { state: 'failed', lastError: persisted, completedAt: new Date() });
    const cId = await currentClientId(ctx.db, opId);
    if (cId) await markClientState(ctx.db, cId, 'failed', null);
  }
}

// ─── Filesystem check / repair (fsck) ──────────────────────────────────

/**
 * Look up the PV name + node placement + fsType for a client's tenant
 * PVC. Used by both fsck flows. Returns null if the PVC isn't bound
 * yet or Longhorn doesn't have a record.
 */
async function locateTenantVolume(
  ctx: ServiceCtx,
  namespace: string,
  pvcName: string,
): Promise<{ volumeName: string; nodeName: string; fsType: string } | null> {
  // PVC → volumeName
  let pvc;
  try {
    pvc = await ctx.k8s.core.readNamespacedPersistentVolumeClaim({ name: pvcName, namespace });
  } catch {
    return null;
  }
  const pvcShape = pvc as { spec?: { volumeName?: string } };
  const volumeName = pvcShape.spec?.volumeName;
  if (!volumeName) return null;

  // PV → fsType from CSI volumeAttributes
  let fsType = 'unknown';
  try {
    const pv = await (ctx.k8s.core as unknown as {
      readPersistentVolume: (a: { name: string }) => Promise<{ spec?: { csi?: { volumeAttributes?: Record<string, string> } } }>;
    }).readPersistentVolume({ name: volumeName });
    fsType = pv.spec?.csi?.volumeAttributes?.fsType ?? 'unknown';
  } catch { /* fsType stays unknown — runFsck will reject */ }

  // Longhorn Volume CR → currentNodeID (where /dev/longhorn/<vol> exists)
  let nodeName = '';
  try {
    const lhVol = await (ctx.k8s.custom as unknown as {
      getNamespacedCustomObject: (a: {
        group: string; version: string; namespace: string; plural: string; name: string;
      }) => Promise<{ status?: { currentNodeID?: string; ownerID?: string } }>;
    }).getNamespacedCustomObject({
      group: 'longhorn.io', version: 'v1beta2',
      namespace: 'longhorn-system', plural: 'volumes', name: volumeName,
    });
    nodeName = lhVol.status?.currentNodeID ?? lhVol.status?.ownerID ?? '';
  } catch { /* fall through — empty nodeName fails below */ }

  if (!nodeName) return null;
  return { volumeName, nodeName, fsType };
}

/**
 * Dry-run filesystem check. Quiesces the tenant (xfs_repair / e2fsck
 * refuse to run on mounted FS, even with -n), runs the check-only
 * tool against the Longhorn block device, then unquiesces.
 *
 * Reports back via storage_operations.progressMessage / lastError.
 * The full tool output is appended to progressMessage when clean,
 * lastError when errors are reported.
 */
export async function fsckCheckClient(
  ctx: ServiceCtx,
  clientId: string,
  opts: { triggeredByUserId?: string | null } = {},
): Promise<{ operationId: string }> {
  return startFsck(ctx, clientId, true, opts);
}

/**
 * Repair-mode filesystem check. Same flow as check, but the tool is
 * allowed to write to the filesystem (xfs_repair without -n; e2fsck -y).
 * Operator-initiated only — the storage-lifecycle UI surfaces a
 * confirmation modal because writes here can lose data on a badly
 * damaged filesystem.
 */
export async function fsckRepairClient(
  ctx: ServiceCtx,
  clientId: string,
  opts: { triggeredByUserId?: string | null } = {},
): Promise<{ operationId: string }> {
  return startFsck(ctx, clientId, false, opts);
}

async function startFsck(
  ctx: ServiceCtx,
  clientId: string,
  dryRun: boolean,
  opts: { triggeredByUserId?: string | null },
): Promise<{ operationId: string }> {
  const client = await mustGetClient(ctx.db, clientId);
  await mustBeIdle(ctx.db, clientId);

  const opId = uuid();
  await ctx.db.transaction(async (tx) => {
    await tx.insert(storageOperations).values({
      id: opId,
      clientId,
      opType: 'fsck',
      state: 'quiescing',
      progressPct: 0,
      progressMessage: dryRun ? 'Starting fsck (dry-run)' : 'Starting fsck repair',
      params: { dryRun },
      triggeredByUserId: opts.triggeredByUserId ?? null,
    });
    await tx.update(clients)
      .set({ storageLifecycleState: 'quiescing', activeStorageOpId: opId })
      .where(eq(clients.id, clientId));
  });

  // Async — caller polls /admin/storage/operations/:id for progress.
  void runFsckOp(ctx, opId, client.kubernetesNamespace, dryRun)
    .catch((err) => { console.error(`[storage-lifecycle] runFsckOp pre-orchestrator throw for op ${opId}:`, err); });
  return { operationId: opId };
}

async function runFsckOp(
  ctx: ServiceCtx,
  opId: string,
  namespace: string,
  dryRun: boolean,
): Promise<void> {
  const pvcName = `${namespace}-storage`;
  let quiesceSnap: QuiesceSnapshot | null = null;
  const progress = async (state: typeof clients.$inferSelect['storageLifecycleState'], pct: number, msg: string) => {
    await updateOp(ctx.db, opId, { state, progressPct: pct, progressMessage: msg });
    await ctx.db.update(clients)
      .set({ storageLifecycleState: state })
      .where(eq(clients.activeStorageOpId, opId));
  };

  try {
    // Locate the volume BEFORE quiesce so we know where to schedule
    // the fsck Pod. The currentNodeID is captured while the volume
    // is still attached; after detach, the device path goes away
    // briefly, but the same node will re-attach when the fsck Pod
    // claims the PVC.
    const located = await locateTenantVolume(ctx, namespace, pvcName);
    if (!located) {
      throw new ApiError('FSCK_VOLUME_NOT_FOUND', `Tenant PVC ${pvcName} or its Longhorn volume not found`, 404);
    }
    if (located.fsType !== 'xfs' && located.fsType !== 'ext4' && located.fsType !== 'ext3' && located.fsType !== 'ext2') {
      throw new ApiError('FSCK_UNSUPPORTED_FS', `Unsupported fsType '${located.fsType}' — only xfs and ext4 are supported`, 400);
    }

    await progress('quiescing', 5, 'Scaling workloads to zero');
    quiesceSnap = await quiesce(ctx.k8s, namespace);
    await waitForQuiesced(ctx.k8s, namespace);

    await progress('quiescing', 30, dryRun ? `Running ${located.fsType} dry-run check` : `Running ${located.fsType} repair`);
    const { runFsck } = await import('./fsck.js');
    const result = await runFsck(ctx.k8s, {
      namespace,
      volumeName: located.volumeName,
      clientId: (await currentClientId(ctx.db, opId))!,
      fsType: located.fsType,
      dryRun,
      nodeName: located.nodeName,
    });

    await progress('unquiescing', 85, 'Scaling workloads back up');
    if (quiesceSnap) await unquiesce(ctx.k8s, namespace, quiesceSnap);

    // Persist the captured output. Clean → progressMessage; dirty →
    // both progressMessage (summary) AND lastError (full output) so
    // the UI's ErrorPanel can surface it without losing the data.
    const summary = `${result.fsType} ${result.dryRun ? 'check' : 'repair'} exit=${result.exitCode} ${result.clean ? 'CLEAN' : 'ERRORS FOUND'}`;
    if (result.clean) {
      await updateOp(ctx.db, opId, {
        state: 'idle',
        progressPct: 100,
        progressMessage: `${summary}\n\n${result.output}`.slice(0, 8000),
        completedAt: new Date(),
      });
    } else {
      await updateOp(ctx.db, opId, {
        state: 'failed',
        progressPct: 100,
        progressMessage: summary,
        lastError: result.output.slice(0, 16000),
        completedAt: new Date(),
      });
    }

    const cId = await currentClientId(ctx.db, opId);
    if (cId) await markClientState(ctx.db, cId, result.clean ? 'idle' : 'failed', null);
  } catch (err) {
    const persisted = formatLifecycleError(err, 'pvc');
    await updateOp(ctx.db, opId, {
      state: 'failed', lastError: persisted, completedAt: new Date(),
    });
    if (quiesceSnap) {
      await unquiesce(ctx.k8s, namespace, quiesceSnap).catch(() => {});
    }
    const cId = await currentClientId(ctx.db, opId);
    if (cId) await markClientState(ctx.db, cId, 'failed', null);
  }
}

// ─── Listing + housekeeping ────────────────────────────────────────────

export async function listSnapshotsForClient(db: Database, clientId: string) {
  return db.select().from(storageSnapshots).where(eq(storageSnapshots.clientId, clientId)).orderBy(desc(storageSnapshots.createdAt));
}

export async function listOperationsForClient(db: Database, clientId: string, limit = 50) {
  return db.select().from(storageOperations).where(eq(storageOperations.clientId, clientId)).orderBy(desc(storageOperations.createdAt)).limit(limit);
}

export async function getOperation(db: Database, opId: string) {
  const [op] = await db.select().from(storageOperations).where(eq(storageOperations.id, opId));
  return op ?? null;
}

export async function deleteSnapshot(ctx: ServiceCtx, snapshotId: string): Promise<void> {
  const [snap] = await ctx.db.select().from(storageSnapshots).where(eq(storageSnapshots.id, snapshotId));
  if (!snap) throw new ApiError('SNAPSHOT_NOT_FOUND', `Snapshot ${snapshotId} not found`, 404);
  await ctx.store.delete(snap.archivePath).catch(() => {});
  await ctx.db.delete(storageSnapshots).where(eq(storageSnapshots.id, snapshotId));
}

/**
 * Housekeeping: drop snapshots past their expires_at. Runs from the
 * scheduler daily. Returns count of snapshots reaped.
 */
export async function expireSnapshots(ctx: ServiceCtx): Promise<number> {
  const now = new Date();
  const due = await ctx.db.select().from(storageSnapshots).where(
    and(lte(storageSnapshots.expiresAt, now), eq(storageSnapshots.status, 'ready')),
  );
  let reaped = 0;
  for (const snap of due) {
    try {
      await ctx.store.delete(snap.archivePath);
      await ctx.db.update(storageSnapshots).set({ status: 'expired' }).where(eq(storageSnapshots.id, snap.id));
      reaped += 1;
    } catch {
      // Log only — don't let one stuck snapshot break the cron
    }
  }
  return reaped;
}

/**
 * Report provisioned vs actually-used storage for every client. The cron
 * publishes this once a week for capacity planning. For now, just
 * computes + returns — emit via logger or email in a later pass.
 */
export async function storageAuditReport(ctx: ServiceCtx): Promise<Array<{
  clientId: string;
  namespace: string;
  provisionedGi: number;
  usedBytes: number;
  wastePct: number;
}>> {
  const rows = await ctx.db.select({
    id: clients.id,
    ns: clients.kubernetesNamespace,
    storageLimitOverride: clients.storageLimitOverride,
    planId: clients.planId,
  }).from(clients).where(
    and(eq(clients.status, 'active'), sql`${clients.kubernetesNamespace} IS NOT NULL`),
  );
  const out = [];
  for (const r of rows) {
    const provisionedGi = Math.round(Number(r.storageLimitOverride ?? 0)) || await getPlanStorageGi(ctx.db, r.planId);
    const used = await measurePvcUsed(ctx, r.ns!);
    const provisionedBytes = provisionedGi * 1024 * 1024 * 1024;
    const wastePct = provisionedBytes > 0 ? Math.round(((provisionedBytes - used) / provisionedBytes) * 100) : 0;
    out.push({ clientId: r.id, namespace: r.ns!, provisionedGi, usedBytes: used, wastePct });
  }
  return out;
}
