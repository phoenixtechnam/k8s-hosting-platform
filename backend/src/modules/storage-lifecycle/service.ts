import crypto from 'node:crypto';
import { eq, and, sql, desc, lte } from 'drizzle-orm';
import {
  tenants,
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
import { tenantStoragePvcLabelsFromNamespace } from '../../lib/canonical-labels.js';
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
 * tenant's `storage_lifecycle_state` + `active_storage_op_id` fields
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
  /**
   * Phase 3 of the snapshot-storage overhaul: when the store was
   * resolved via the per-class assignment table, this carries the
   * `backup_configurations.id` for forensic stamping on the
   * `storage_snapshots.target_id` column. Null when the legacy
   * single-active-target fallback resolved the store.
   */
  readonly targetId?: string | null;
  /**
   * Phase 3: the snapshot class this ctx was built for. Defaults to
   * 'tenant_snapshot' at the routes layer for tenant-PVC operations.
   * Stamped on `storage_snapshots.snapshot_class` at row creation.
   */
  readonly snapshotClass?: import('@k8s-hosting/api-contracts').SnapshotClass;
}

async function mustGetTenant(db: Database, tenantId: string) {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
  if (!tenant) throw new ApiError('CLIENT_NOT_FOUND', `Client ${tenantId} not found`, 404);
  return tenant;
}

async function mustBeIdle(db: Database, tenantId: string) {
  const [tenant] = await db.select({
    state: tenants.storageLifecycleState,
    opId: tenants.activeStorageOpId,
  }).from(tenants).where(eq(tenants.id, tenantId));
  if (!tenant) throw new ApiError('CLIENT_NOT_FOUND', `Client ${tenantId} not found`, 404);
  if (tenant.state !== 'idle') {
    throw new ApiError(
      'STORAGE_OP_IN_PROGRESS',
      `A ${tenant.state} operation is already in progress for this tenant`,
      409,
      { currentState: tenant.state, activeOpId: tenant.opId },
    );
  }
}

async function markTenantState(
  db: Database,
  tenantId: string,
  state: typeof tenants.$inferSelect['storageLifecycleState'],
  opId: string | null,
) {
  await db.update(tenants)
    .set({ storageLifecycleState: state, activeStorageOpId: opId })
    .where(eq(tenants.id, tenantId));
}

async function updateOp(
  db: Database,
  opId: string,
  patch: Partial<typeof storageOperations.$inferInsert>,
) {
  await db.update(storageOperations).set(patch).where(eq(storageOperations.id, opId));
  // Mirror to the Task Tracker chip — best-effort, never throws.
  await mirrorOpToTaskTracker(db, opId).catch((err) => {
    console.warn(`[storage-lifecycle] task tracker mirror failed for ${opId}: ${err instanceof Error ? err.message : String(err)}`);
  });
}

/**
 * Sync a `storage_operations` row into the Task Tracker chip via the
 * tasks helper. Idempotent on `(kind='storage.<opType>', ref_id=opId)`,
 * so multiple `updateOp` calls within the same operation just refresh
 * the existing task row's progress / status.
 *
 * Cron-driven snapshot/scheduled ops have triggered_by_user_id=null —
 * we skip those (scope='system' tasks never appear in any chip per the
 * UX agreement; failures land in notifications instead).
 */
async function mirrorOpToTaskTracker(db: Database, opId: string): Promise<void> {
  const [op] = await db
    .select({
      id: storageOperations.id,
      tenantId: storageOperations.tenantId,
      opType: storageOperations.opType,
      state: storageOperations.state,
      progressPct: storageOperations.progressPct,
      progressMessage: storageOperations.progressMessage,
      lastError: storageOperations.lastError,
      triggeredByUserId: storageOperations.triggeredByUserId,
    })
    .from(storageOperations)
    .where(eq(storageOperations.id, opId))
    .limit(1);
  if (!op || !op.triggeredByUserId) return;

  // The op's `state` is the storage-lifecycle FSM (snapshotting, growing,
  // shrinking, restoring, suspending, resuming, idle, failed). Map to
  // the task's three terminal-or-running statuses.
  const isTerminal = op.state === 'idle' || op.state === 'failed';
  const taskStatus: 'running' | 'succeeded' | 'failed' =
    !isTerminal ? 'running'
    : op.state === 'failed' ? 'failed'
    : 'succeeded';

  const kind = `storage.${op.opType}`;
  const labelText = `${op.opType} storage (${op.tenantId.slice(0, 8)})`;
  // Phase 3: route to the OperationProgressModal so clicking the chip
  // re-opens the live progress view instead of just navigating to the
  // storage tab. The admin-panel registry maps `modal: 'operation'` to
  // <OperationProgressModal /> which takes `operationId` (the
  // storageOperations.id) + an optional title.
  const target = {
    type: 'modal' as const,
    modal: 'operation',
    modalProps: {
      operationId: op.id,
      title: `${op.opType.replace(/_/g, ' ')} — ${op.tenantId.slice(0, 8)}`,
    },
  };

  const { start: startTask, finishByRef } = await import('../tasks/service.js');
  const { toSafeText } = await import('@k8s-hosting/api-contracts');

  if (taskStatus === 'running') {
    await startTask(db, {
      kind,
      refId: op.id,
      scope: 'admin',
      userId: op.triggeredByUserId,
      tenantId: op.tenantId,
      label: toSafeText(labelText),
      target,
      progressPct: op.progressPct ?? null,
      progressText: op.progressMessage ? toSafeText(op.progressMessage) : null,
      details: { opType: op.opType, state: op.state },
    });
    return;
  }

  // Terminal — also runs through start() once if the row didn't exist
  // yet (e.g. an op that completed in a single tick before any updateOp
  // call mirrored the running state).
  await startTask(db, {
    kind,
    refId: op.id,
    scope: 'admin',
    userId: op.triggeredByUserId,
    tenantId: op.tenantId,
    label: toSafeText(labelText),
    target,
    progressPct: op.progressPct ?? null,
    progressText: op.progressMessage ? toSafeText(op.progressMessage) : null,
    details: { opType: op.opType, state: op.state },
  });
  await finishByRef(db, kind, op.id, {
    status: taskStatus,
    text: op.progressMessage ? toSafeText(op.progressMessage) : null,
    error: taskStatus === 'failed' ? (op.lastError ?? 'Storage operation failed') : null,
  });
}

// ─── Manual snapshot ────────────────────────────────────────────────────

/**
 * Take a manual snapshot of a tenant's PVC. Quiesces briefly, runs the
 * snapshot Job, records the result. Returns the snapshot row.
 *
 * Safe to call on a healthy running tenant — quiesce restores workloads
 * after the snapshot completes.
 */
export async function snapshotTenant(
  ctx: ServiceCtx,
  tenantId: string,
  params: { label?: string; kind?: 'manual' | 'scheduled' | 'pre-restore'; retentionDays?: number; triggeredByUserId?: string | null } = {},
): Promise<typeof storageSnapshots.$inferSelect> {
  const tenant = await mustGetTenant(ctx.db, tenantId);
  await mustBeIdle(ctx.db, tenantId);
  // Phase 6: pre-flight quota check. Manual + pre-restore snapshots
  // count against the tenant's plan cap; the system-initiated paths
  // (resize/archive) skip this via their own service entry points
  // which don't call snapshotTenant.
  const { enforceSnapshotQuota } = await import('./snapshot-quota.js');
  await enforceSnapshotQuota(ctx.db, tenantId);
  const opId = uuid();
  const snapId = uuid();
  const archivePath = ctx.store.reservePath(tenantId, snapId);
  const expiresAt = params.retentionDays
    ? new Date(Date.now() + params.retentionDays * 24 * 60 * 60 * 1000)
    : null;

  // Pre-create DB rows in a single transaction so we don't orphan an op
  // if we crash before persisting the snapshot row.
  //
  // Phase 3: stamp snapshot_class + target_id from the resolver context
  // so every row records where it was routed and which class produced it.
  // When ctx.targetId is null (legacy single-active-target path) the
  // column stays NULL and forensic queries fall back to subsystem alone.
  await ctx.db.transaction(async (tx) => {
    await tx.insert(storageSnapshots).values({
      id: snapId,
      tenantId,
      kind: params.kind ?? 'manual',
      status: 'creating',
      archivePath,
      label: params.label ?? null,
      expiresAt,
      snapshotClass: ctx.snapshotClass ?? 'tenant_snapshot',
      subsystem: 'tenant-pvc',
      targetId: ctx.targetId ?? null,
    });
    await tx.insert(storageOperations).values({
      id: opId,
      tenantId,
      opType: 'snapshot',
      state: 'snapshotting',
      progressPct: 0,
      progressMessage: 'Quiescing workloads',
      snapshotId: snapId,
      triggeredByUserId: params.triggeredByUserId ?? null,
    });
    await tx.update(tenants)
      .set({ storageLifecycleState: 'snapshotting', activeStorageOpId: opId })
      .where(eq(tenants.id, tenantId));
  });

  let quiesceSnap: QuiesceSnapshot | null = null;
  try {
    quiesceSnap = await quiesce(ctx.k8s, tenant.kubernetesNamespace);
    await waitForQuiesced(ctx.k8s, tenant.kubernetesNamespace);
    await updateOp(ctx.db, opId, { progressPct: 20, progressMessage: 'Creating snapshot' });

    const result = await snapshotTenantPVC(ctx.k8s, {
      namespace: tenant.kubernetesNamespace,
      pvcName: `${tenant.kubernetesNamespace}-storage`,
      tenantId,
      snapshotId: snapId,
      store: ctx.store,
      onProgress: async (msg) => { await updateOp(ctx.db, opId, { progressMessage: msg }); },
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
    await unquiesce(ctx.k8s, tenant.kubernetesNamespace, quiesceSnap);
    await updateOp(ctx.db, opId, {
      state: 'idle',
      progressPct: 100,
      progressMessage: 'Snapshot complete',
      completedAt: new Date(),
    });
    await markTenantState(ctx.db, tenantId, 'idle', null);

    const [row] = await ctx.db.select().from(storageSnapshots).where(eq(storageSnapshots.id, snapId));
    return row;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const persisted = formatLifecycleError(err, 'pvc');
    await ctx.db.update(storageSnapshots).set({ status: 'failed', lastError: persisted }).where(eq(storageSnapshots.id, snapId));
    await updateOp(ctx.db, opId, { state: 'failed', lastError: persisted, completedAt: new Date() });
    if (quiesceSnap) {
      // Best-effort unquiesce so we don't leave the tenant broken.
      await unquiesce(ctx.k8s, tenant.kubernetesNamespace, quiesceSnap).catch(() => {});
    }
    await markTenantState(ctx.db, tenantId, 'idle', null);
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
  tenantId: string,
  newMib: number,
): Promise<ResizeDryRun> {
  const tenant = await mustGetTenant(ctx.db, tenantId);
  // Read current size from the live PVC, not from tenants.storage_limit_override.
  // updateTenant writes the new override BEFORE dispatching to the resize
  // orchestrator, so reading the override would always return the target
  // size and short-circuit every grow as a no-op. The PVC's
  // spec.resources.requests.storage is the source of truth for what's
  // actually provisioned.
  const namespace = tenant.kubernetesNamespace;
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
    const currentGi = Math.round(Number(tenant.storageLimitOverride ?? 0)) || await getPlanStorageGi(ctx.db, tenant.planId);
    currentMib = currentGi * 1024;
  }
  const currentGi = Math.ceil(currentMib / 1024);

  const usedBytes = await measurePvcUsed(ctx, tenant.kubernetesNamespace);
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
  tenantId: string,
  newGi: number,
): Promise<ResizeDryRun> {
  return resizeDryRunMib(ctx, tenantId, newGi * 1024);
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
 * Resize a tenant's PVC to a new size. Dispatches to:
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
export async function resizeTenant(
  ctx: ServiceCtx,
  tenantId: string,
  params: { newMib?: number; newGi?: number; triggeredByUserId?: string | null },
): Promise<{ operationId: string }> {
  const tenant = await mustGetTenant(ctx.db, tenantId);
  await mustBeIdle(ctx.db, tenantId);

  if (params.newMib == null && params.newGi == null) {
    throw new ApiError('VALIDATION_ERROR', 'One of newMib or newGi is required', 400);
  }
  const newMib = params.newMib ?? (params.newGi! * 1024);

  const dry = await resizeDryRunMib(ctx, tenantId, newMib);
  if (newMib === dry.currentMib) {
    // No-op — surface a synthetic completed op so callers don't have
    // to special-case "PATCH that didn't actually change anything".
    const opId = uuid();
    await ctx.db.insert(storageOperations).values({
      id: opId,
      tenantId,
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
    return resizeGrow(ctx, tenantId, dry.currentMib, newMib, params.triggeredByUserId ?? null);
  }
  // newMib < currentMib → destructive shrink (must check willFit).
  if (!dry.willFit) {
    throw new ApiError('RESIZE_UNSAFE', dry.rejectReason!, 400, { dryRun: dry });
  }
  return resizeDestructive(ctx, tenant.kubernetesNamespace, tenantId, dry.currentMib, newMib, params.triggeredByUserId ?? null);
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
  tenantId: string,
  currentMib: number,
  newMib: number,
  triggeredByUserId: string | null,
): Promise<{ operationId: string }> {
  const opId = uuid();
  const [tenant] = await ctx.db.select().from(tenants).where(eq(tenants.id, tenantId));
  if (!tenant) throw new ApiError('CLIENT_NOT_FOUND', `Client ${tenantId} not found`, 404);
  const namespace = tenant.kubernetesNamespace;
  const pvcName = `${namespace}-storage`;

  await ctx.db.transaction(async (tx) => {
    await tx.insert(storageOperations).values({
      id: opId,
      tenantId,
      opType: 'resize',
      state: 'resizing',
      progressPct: 0,
      progressMessage: `Online-grow ${currentMib} → ${newMib} MiB`,
      params: { fromMib: currentMib, toMib: newMib, mode: 'grow_online' },
      triggeredByUserId,
    });
    await tx.update(tenants)
      .set({ storageLifecycleState: 'resizing', activeStorageOpId: opId })
      .where(eq(tenants.id, tenantId));
  });

  void runGrowOnline(ctx, opId, namespace, pvcName, currentMib, newMib)
    .catch((err) => { console.error(`[storage-lifecycle] runGrowOnline pre-orchestrator throw for op ${opId}:`, err); });
  return { operationId: opId };
}

async function resizeDestructive(
  ctx: ServiceCtx,
  namespace: string,
  tenantId: string,
  currentMib: number,
  newMib: number,
  triggeredByUserId: string | null,
): Promise<{ operationId: string }> {
  const opId = uuid();
  const snapId = uuid();
  const archivePath = ctx.store.reservePath(tenantId, snapId);
  const pvcName = `${namespace}-storage`;
  const preResizeRetention = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await ctx.db.transaction(async (tx) => {
    await tx.insert(storageSnapshots).values({
      id: snapId,
      tenantId,
      kind: 'pre-resize',
      status: 'creating',
      archivePath,
      expiresAt: preResizeRetention,
      label: `Pre-resize ${currentMib}MiB → ${newMib}MiB`,
      // Phase 3: pre-resize snapshots are tenant_snapshot class. They
      // route to the same target as a manual snapshot would.
      snapshotClass: ctx.snapshotClass ?? 'tenant_snapshot',
      subsystem: 'tenant-pvc',
      targetId: ctx.targetId ?? null,
    });
    await tx.insert(storageOperations).values({
      id: opId,
      tenantId,
      opType: 'resize',
      state: 'snapshotting',
      progressPct: 0,
      progressMessage: 'Starting resize',
      snapshotId: snapId,
      params: { fromMib: currentMib, toMib: newMib, mode: 'destructive' },
      triggeredByUserId,
    });
    await tx.update(tenants)
      .set({ storageLifecycleState: 'snapshotting', activeStorageOpId: opId })
      .where(eq(tenants.id, tenantId));
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
 *   4. Persist the new size on tenants.storageLimitOverride so the
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
  const progress = async (state: typeof tenants.$inferSelect['storageLifecycleState'], pct: number, msg: string) => {
    await updateOp(ctx.db, opId, { state, progressPct: pct, progressMessage: msg });
    await ctx.db.update(tenants)
      .set({ storageLifecycleState: state })
      .where(eq(tenants.activeStorageOpId, opId));
  };

  try {
    await progress('resizing', 10, `Patching PVC ${pvcName} to ${newSizeStr}`);

    // 1. Patch PVC.spec.resources.requests.storage. Use a JSON merge
    //    patch — strategic-merge isn't supported on PVCs and a JSON
    //    patch with `op:replace` would fail if the path doesn't exist.
    try {
      const { MERGE_PATCH } = await import('../../shared/k8s-patch.js');
      await ctx.k8s.core.patchNamespacedPersistentVolumeClaim({
        name: pvcName,
        namespace,
        body: { spec: { resources: { requests: { storage: newSizeStr } } } },
      } as unknown as Parameters<typeof ctx.k8s.core.patchNamespacedPersistentVolumeClaim>[0],
        MERGE_PATCH);
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
    //    K8s + Longhorn flow: ControllerExpandVolume extends the block
    //    device → kubelet sets FileSystemResizePending condition →
    //    kubelet runs xfs_growfs/resize2fs on the live mount → kubelet
    //    clears the condition AND propagates the new capacity. PVC
    //    .status.capacity does not update until the whole sequence
    //    completes, so a single capacity-poll covers both the block-
    //    device extend AND the filesystem grow. Timeout 600s — enough
    //    for a slow Longhorn rebuild on a contended cluster (e.g.
    //    integration suites running back-to-back, leaving residual
    //    detach/replicate work) while still bounding indefinite hangs.
    await progress('resizing', 50, 'Extending Longhorn volume + xfs_growfs/resize2fs (kubelet)');
    await waitForPvcCapacity(ctx.k8s, namespace, pvcName, newBytes, 600_000,
      async (msg) => { await updateOp(ctx.db, opId, { progressMessage: msg }); });

    // 4. Persist the new size on the tenant row so the ResourceQuota
    //    and any subsequent quota recompute see the same value.
    const tenantId = await currentTenantId(ctx.db, opId);
    if (tenantId) {
      const giDecimal = Math.round((newMib / 1024) * 100) / 100;
      await ctx.db.update(tenants).set({
        storageLimitOverride: giDecimal.toFixed(2),
      }).where(eq(tenants.id, tenantId));
    }

    await updateOp(ctx.db, opId, {
      state: 'idle',
      progressPct: 100,
      progressMessage: `Grew ${currentMib} → ${newMib} MiB online (no downtime)`,
      completedAt: new Date(),
    });
    const cId = await currentTenantId(ctx.db, opId);
    if (cId) await markTenantState(ctx.db, cId, 'idle', null);
  } catch (err) {
    const persisted = formatLifecycleError(err, 'pvc');
    await updateOp(ctx.db, opId, {
      state: 'failed', lastError: persisted, completedAt: new Date(),
    });
    const cId = await currentTenantId(ctx.db, opId);
    if (cId) await markTenantState(ctx.db, cId, 'failed', null);
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
  onProgress?: (msg: string) => Promise<void> | void,
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
      if (onProgress) {
        const elapsed = Math.floor((Date.now() - start) / 1000);
        const capGi = (capBytes / (1024 ** 3)).toFixed(2);
        const targetGi = (targetBytes / (1024 ** 3)).toFixed(2);
        await onProgress(`Extending volume — ${capGi} / ${targetGi} GiB after ${elapsed}s (Longhorn rebuild + xfs_growfs)`);
      }
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

  const progress = async (state: typeof tenants.$inferSelect['storageLifecycleState'], pct: number, msg: string) => {
    await updateOp(ctx.db, opId, { state, progressPct: pct, progressMessage: msg });
    await ctx.db.update(tenants)
      .set({ storageLifecycleState: state })
      .where(eq(tenants.activeStorageOpId, opId));
  };

  try {
    await progress('quiescing', 5, 'Scaling workloads to zero');
    quiesceSnap = await quiesce(ctx.k8s, namespace);
    await waitForQuiesced(ctx.k8s, namespace);

    await progress('snapshotting', 15, 'Creating pre-resize snapshot');
    const snap = await snapshotTenantPVC(ctx.k8s, {
      namespace, pvcName, tenantId: (await currentTenantId(ctx.db, opId))!, snapshotId: snapId, store: ctx.store,
      onProgress: async (msg) => { await updateOp(ctx.db, opId, { progressMessage: msg }); },
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
    // Phase 5: per-target restore for new rows; legacy ctx.store for old.
    const [snapRowForRestore] = await ctx.db.select().from(storageSnapshots).where(eq(storageSnapshots.id, snapId)).limit(1);
    const restoreStoreForResize = snapRowForRestore ? await resolveRestoreStore(ctx, snapRowForRestore) : ctx.store;
    await restoreTenantPVC(ctx.k8s, {
      namespace, pvcName, tenantId: (await currentTenantId(ctx.db, opId))!,
      snapshotId: snapId, archivePath, store: restoreStoreForResize,
      onProgress: async (msg) => { await updateOp(ctx.db, opId, { progressMessage: msg }); },
    });

    await progress('unquiescing', 90, 'Scaling workloads back up');
    if (quiesceSnap) await unquiesce(ctx.k8s, namespace, quiesceSnap);

    // Persist the new size on the tenant row (override) + refresh quota
    const tenantId = await currentTenantId(ctx.db, opId);
    if (tenantId) {
      // storage_limit_override is numeric(8,2) GiB; keep one-decimal
      // precision so 2500 MiB shows as 2.44 GiB. Round to 2 dp.
      const giDecimal = Math.round((newMib / 1024) * 100) / 100;
      await ctx.db.update(tenants).set({
        storageLimitOverride: giDecimal.toFixed(2),
      }).where(eq(tenants.id, tenantId));
    }

    await updateOp(ctx.db, opId, {
      state: 'idle', progressPct: 100, progressMessage: 'Resize complete', completedAt: new Date(),
    });
    const cId = await currentTenantId(ctx.db, opId);
    if (cId) await markTenantState(ctx.db, cId, 'idle', null);
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
    const cId = await currentTenantId(ctx.db, opId);
    if (cId) await markTenantState(ctx.db, cId, 'failed', null);
  }
}

async function currentTenantId(db: Database, opId: string): Promise<string | null> {
  const [op] = await db.select({ tenantId: storageOperations.tenantId }).from(storageOperations).where(eq(storageOperations.id, opId));
  return op?.tenantId ?? null;
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
    // backup-coverage: captured-by:files
    // (recreate the canonical `${namespace}-storage` PVC during
    // resize/replace flows; same PVC the files component captures.)
    await k8s.core.createNamespacedPersistentVolumeClaim({
      namespace,
      body: {
        metadata: {
          name: `${namespace}-storage`,
          namespace,
          labels: {
            // Same label set as applyPVC in k8s-provisioner — the
            // destructive-resize path replaces the PVC, so without
            // re-stamping these labels the tenant would drop out of
            // both the backup RecurringJob and the canonical label
            // index after a shrink/snap-restore.
            'recurring-job-group.longhorn.io/default': 'enabled',
            'app.kubernetes.io/part-of': 'hosting-platform',
            'app.kubernetes.io/component': 'tenant-storage',
            ...tenantStoragePvcLabelsFromNamespace(namespace),
          },
        },
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
 * Force a tenant's storage state back to `idle` after a failed op has
 * left it stuck in `failed`. Admin-only; returns the previous state so
 * the audit log can record what was cleared.
 *
 * This is a safety valve, NOT a retry — the failed operation's DB row
 * is kept (with its error) so operators can diagnose what went wrong
 * before attempting the op again.
 */
export async function clearFailedStorageState(
  db: Database,
  tenantId: string,
): Promise<{ previousState: string }> {
  const [c] = await db
    .select({ state: tenants.storageLifecycleState })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!c) throw new ApiError('CLIENT_NOT_FOUND', `Client ${tenantId} not found`, 404);
  if (c.state !== 'failed') {
    throw new ApiError(
      'NOT_IN_FAILED_STATE',
      `Client is in state '${c.state}', not 'failed' — only failed ops can be force-cleared`,
      409,
      { currentState: c.state },
    );
  }
  await db
    .update(tenants)
    .set({ storageLifecycleState: 'idle', activeStorageOpId: null })
    .where(eq(tenants.id, tenantId));
  return { previousState: c.state };
}

/**
 * Force-cancel an in-progress storage operation. Works on ANY non-idle
 * state. Best-effort deletes the underlying Job(s) and resets the
 * tenant's storage state to idle so subsequent ops can proceed.
 * Idempotent — calling on state=idle returns deletedJobs=0.
 */
export async function cancelStorageOperation(
  ctx: ServiceCtx,
  tenantId: string,
): Promise<{ previousState: string; deletedJobs: number; cancelledOpId: string | null }> {
  const [c] = await ctx.db
    .select({
      state: tenants.storageLifecycleState,
      activeOpId: tenants.activeStorageOpId,
      namespace: tenants.kubernetesNamespace,
    })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!c) throw new ApiError('CLIENT_NOT_FOUND', `Client ${tenantId} not found`, 404);
  if (c.state === 'idle') {
    return { previousState: 'idle', deletedJobs: 0, cancelledOpId: null };
  }

  // Best-effort delete K8s Jobs in both namespaces because Tier-1
  // (fsck) lives in platform-tenant-ops while Tier-2 (snapshot /
  // restore) lives in the tenant namespace.
  const labelSelector = `platform.io/tenant-id=${tenantId}`;
  let deletedJobs = 0;
  for (const ns of ['platform-tenant-ops', c.namespace ?? '']) {
    if (!ns) continue;
    try {
      const list = await (ctx.k8s.batch as unknown as {
        listNamespacedJob: (a: { namespace: string; labelSelector?: string }) => Promise<{ items?: Array<{ metadata?: { name?: string } }> }>;
      }).listNamespacedJob({ namespace: ns, labelSelector });
      for (const job of list.items ?? []) {
        const name = job.metadata?.name;
        if (!name) continue;
        try {
          // eslint-disable-next-line no-await-in-loop
          await (ctx.k8s.batch as unknown as {
            deleteNamespacedJob: (a: { name: string; namespace: string; propagationPolicy?: string }) => Promise<unknown>;
          }).deleteNamespacedJob({ name, namespace: ns, propagationPolicy: 'Background' });
          deletedJobs++;
        } catch { /* tolerate already-gone */ }
      }
    } catch { /* tolerate listing failures (RBAC, ns-missing) */ }
  }

  if (c.activeOpId) {
    await ctx.db
      .update(storageOperations)
      .set({
        state: 'failed',
        completedAt: new Date(),
        lastError: `Cancelled by operator (was state='${c.state}')`,
      })
      .where(eq(storageOperations.id, c.activeOpId));
  }

  await ctx.db
    .update(tenants)
    .set({ storageLifecycleState: 'idle', activeStorageOpId: null })
    .where(eq(tenants.id, tenantId));

  return { previousState: c.state, deletedJobs, cancelledOpId: c.activeOpId };
}

// ─── Suspend / Resume ──────────────────────────────────────────────────

export async function suspendTenant(
  ctx: ServiceCtx,
  tenantId: string,
  opts: { triggeredByUserId?: string | null } = {},
): Promise<{ operationId: string }> {
  const tenant = await mustGetTenant(ctx.db, tenantId);
  await mustBeIdle(ctx.db, tenantId);
  if (tenant.status === 'suspended') {
    throw new ApiError('ALREADY_SUSPENDED', 'Client is already suspended', 409);
  }

  const opId = uuid();
  await ctx.db.transaction(async (tx) => {
    await tx.insert(storageOperations).values({
      id: opId, tenantId, opType: 'suspend',
      state: 'quiescing', progressPct: 0, progressMessage: 'Scaling workloads to zero',
      triggeredByUserId: opts.triggeredByUserId ?? null,
    });
    await tx.update(tenants)
      .set({ storageLifecycleState: 'quiescing', activeStorageOpId: opId })
      .where(eq(tenants.id, tenantId));
  });

  try {
    const snap = await quiesce(ctx.k8s, tenant.kubernetesNamespace);

    // Cross-cutting cascades (ingress swap, mailbox disable, domains
    // status, webcron off). Runs AFTER quiesce so pods are already
    // gone by the time we pull the ingress rug.
    const { applySuspended } = await import('../tenant-lifecycle/cascades.js');
    await applySuspended(
      { db: ctx.db, k8s: ctx.k8s, triggeredByUserId: opts.triggeredByUserId ?? null },
      tenantId,
      tenant.kubernetesNamespace,
    );

    await updateOp(ctx.db, opId, {
      state: 'idle', progressPct: 100,
      progressMessage: 'Client suspended',
      completedAt: new Date(),
      params: { quiesceSnapshot: snap as unknown as Record<string, unknown> },
    });
    // applySuspended dispatched the suspended-transition hooks
    // (tenants-status-stamp wrote status='suspended'); here we just
    // clear the storage-lifecycle state since that's not hook-owned.
    await ctx.db.update(tenants).set({
      storageLifecycleState: 'idle',
      activeStorageOpId: null,
    }).where(eq(tenants.id, tenantId));
    return { operationId: opId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const persisted = formatLifecycleError(err, 'workload');
    await updateOp(ctx.db, opId, { state: 'failed', lastError: persisted, completedAt: new Date() });
    await markTenantState(ctx.db, tenantId, 'idle', null);
    throw new ApiError('SUSPEND_FAILED', msg, 502);
  }
}

export async function resumeTenant(
  ctx: ServiceCtx,
  tenantId: string,
  opts: { triggeredByUserId?: string | null } = {},
): Promise<{ operationId: string }> {
  const tenant = await mustGetTenant(ctx.db, tenantId);
  await mustBeIdle(ctx.db, tenantId);
  if (tenant.status !== 'suspended') {
    throw new ApiError('NOT_SUSPENDED', 'Client is not suspended', 409);
  }

  // Look up the last suspend op for the quiesce snapshot it recorded.
  const [suspendOp] = await ctx.db.select().from(storageOperations).where(
    and(eq(storageOperations.tenantId, tenantId), eq(storageOperations.opType, 'suspend')),
  ).orderBy(desc(storageOperations.createdAt)).limit(1);

  const quiesceSnap = (suspendOp?.params as { quiesceSnapshot?: QuiesceSnapshot } | null)?.quiesceSnapshot;

  const opId = uuid();
  await ctx.db.transaction(async (tx) => {
    await tx.insert(storageOperations).values({
      id: opId, tenantId, opType: 'resume',
      state: 'unquiescing', progressPct: 0, progressMessage: 'Scaling workloads back up',
      triggeredByUserId: opts.triggeredByUserId ?? null,
    });
    await tx.update(tenants)
      .set({ storageLifecycleState: 'unquiescing', activeStorageOpId: opId })
      .where(eq(tenants.id, tenantId));
  });

  try {
    if (quiesceSnap) {
      await unquiesce(ctx.k8s, tenant.kubernetesNamespace, quiesceSnap);
    }

    // Reverse the suspend cascades — restore ingress backends, re-enable
    // mail, webcron, domains.
    const { applyActive } = await import('../tenant-lifecycle/cascades.js');
    await applyActive(
      { db: ctx.db, k8s: ctx.k8s, triggeredByUserId: opts.triggeredByUserId ?? null },
      tenantId,
      tenant.kubernetesNamespace,
    );

    await updateOp(ctx.db, opId, {
      state: 'idle', progressPct: 100, progressMessage: 'Client resumed', completedAt: new Date(),
    });
    // applyActive dispatched the active-transition hooks
    // (tenants-status-stamp wrote status='active' + cleared
    // suspendedAt/archivedAt); clear the storage-lifecycle state.
    await ctx.db.update(tenants).set({
      storageLifecycleState: 'idle',
      activeStorageOpId: null,
    }).where(eq(tenants.id, tenantId));
    return { operationId: opId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const persisted = formatLifecycleError(err, 'workload');
    await updateOp(ctx.db, opId, { state: 'failed', lastError: persisted, completedAt: new Date() });
    await markTenantState(ctx.db, tenantId, 'idle', null);
    throw new ApiError('RESUME_FAILED', msg, 502);
  }
}

// ─── Archive / Restore ─────────────────────────────────────────────────

export async function archiveTenant(
  ctx: ServiceCtx,
  tenantId: string,
  params: { retentionDays?: number; triggeredByUserId?: string | null } = {},
): Promise<{ operationId: string; snapshotId: string }> {
  const tenant = await mustGetTenant(ctx.db, tenantId);
  await mustBeIdle(ctx.db, tenantId);
  if (tenant.status === 'archived') {
    throw new ApiError('ALREADY_ARCHIVED', 'Client is already archived', 409);
  }

  const opId = uuid();
  const snapId = uuid();
  const archivePath = ctx.store.reservePath(tenantId, snapId);
  const retentionDays = params.retentionDays ?? 90;
  const expiresAt = new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000);

  await ctx.db.transaction(async (tx) => {
    await tx.insert(storageSnapshots).values({
      id: snapId, tenantId, kind: 'pre-archive', status: 'creating',
      archivePath, expiresAt,
      label: `Archive ${new Date().toISOString().slice(0, 10)}`,
      // Phase 3: pre-archive snapshots are tenant_snapshot class.
      snapshotClass: ctx.snapshotClass ?? 'tenant_snapshot',
      subsystem: 'tenant-pvc',
      targetId: ctx.targetId ?? null,
    });
    await tx.insert(storageOperations).values({
      id: opId, tenantId, opType: 'archive',
      state: 'quiescing', progressPct: 0, progressMessage: 'Preparing archive',
      snapshotId: snapId,
      params: { retentionDays },
      triggeredByUserId: params.triggeredByUserId ?? null,
    });
    await tx.update(tenants)
      .set({ storageLifecycleState: 'quiescing', activeStorageOpId: opId })
      .where(eq(tenants.id, tenantId));
  });

  void runArchive(ctx, opId, snapId, tenant.kubernetesNamespace)
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
  const progress = async (state: typeof tenants.$inferSelect['storageLifecycleState'], pct: number, msg: string) => {
    await updateOp(ctx.db, opId, { state, progressPct: pct, progressMessage: msg });
  };
  try {
    await progress('quiescing', 10, 'Scaling workloads to zero');
    quiesceSnap = await quiesce(ctx.k8s, namespace);
    await waitForQuiesced(ctx.k8s, namespace);

    await progress('snapshotting', 30, 'Creating archive snapshot');
    const tenantId = (await currentTenantId(ctx.db, opId))!;
    const pvcName = `${namespace}-storage`;
    const result = await snapshotTenantPVC(ctx.k8s, {
      namespace, pvcName, tenantId, snapshotId: snapId, store: ctx.store,
      onProgress: async (msg) => { await updateOp(ctx.db, opId, { progressMessage: msg }); },
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
    const { applyArchived } = await import('../tenant-lifecycle/cascades.js');
    await applyArchived({ db: ctx.db, k8s: ctx.k8s }, tenantId, namespace);

    await updateOp(ctx.db, opId, {
      state: 'idle', progressPct: 100, progressMessage: 'Archive complete', completedAt: new Date(),
    });
    await ctx.db.update(tenants).set({
      storageLifecycleState: 'idle',
      activeStorageOpId: null,
    }).where(eq(tenants.id, tenantId));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const persisted = formatLifecycleError(err, 'pvc');
    await updateOp(ctx.db, opId, { state: 'failed', lastError: persisted, completedAt: new Date() });
    await ctx.db.update(storageSnapshots).set({ status: 'failed', lastError: persisted }).where(eq(storageSnapshots.id, snapId));
    if (quiesceSnap) await unquiesce(ctx.k8s, namespace, quiesceSnap).catch(() => {});
    const cId = await currentTenantId(ctx.db, opId);
    if (cId) await markTenantState(ctx.db, cId, 'failed', null);
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
 * Restore an archived tenant from their most recent pre-archive snapshot.
 * Creates a new PVC (default: snapshot's original size, admin can override),
 * extracts the tarball, flips tenant.status back to 'active'. Deployments
 * are NOT automatically redeployed — the caller should trigger the normal
 * deployment reconciler after restore.
 */
export async function restoreArchivedTenant(
  ctx: ServiceCtx,
  tenantId: string,
  params: { newGi?: number; triggeredByUserId?: string | null } = {},
): Promise<{ operationId: string; snapshotId: string }> {
  const tenant = await mustGetTenant(ctx.db, tenantId);
  await mustBeIdle(ctx.db, tenantId);
  if (tenant.status !== 'archived') {
    throw new ApiError('NOT_ARCHIVED', 'Client is not in archived state', 409);
  }

  const [snap] = await ctx.db.select().from(storageSnapshots).where(
    and(eq(storageSnapshots.tenantId, tenantId), eq(storageSnapshots.kind, 'pre-archive'), eq(storageSnapshots.status, 'ready')),
  ).orderBy(desc(storageSnapshots.createdAt)).limit(1);
  if (!snap) {
    throw new ApiError('NO_ARCHIVE_SNAPSHOT', 'No ready pre-archive snapshot found — the archive window may have expired', 404);
  }

  const opId = uuid();
  const targetGi = params.newGi ?? await getPlanStorageGi(ctx.db, tenant.planId);
  await ctx.db.transaction(async (tx) => {
    await tx.insert(storageOperations).values({
      id: opId, tenantId, opType: 'restore',
      state: 'replacing', progressPct: 0, progressMessage: 'Recreating PVC',
      snapshotId: snap.id,
      params: { fromSnapshot: snap.id, targetGi },
      triggeredByUserId: params.triggeredByUserId ?? null,
    });
    await tx.update(tenants)
      .set({ storageLifecycleState: 'replacing', activeStorageOpId: opId })
      .where(eq(tenants.id, tenantId));
  });

  void runRestoreArchive(ctx, opId, snap.id, snap.archivePath, tenant.kubernetesNamespace, targetGi)
    .catch((err) => { console.error(`[storage-lifecycle] runRestoreArchive pre-orchestrator throw for op ${opId}:`, err); });
  return { operationId: opId, snapshotId: snap.id };
}

/**
 * Roll back the tenant data PVC to a specific snapshot WITHOUT
 * requiring the tenant to be archived. Used by the tenant-backup-
 * restore cart's rollback button when the operator wants to undo
 * a destructive files-paths restore.
 *
 * Flow:
 *   1. Verify the snapshot belongs to the requested tenant and is ready.
 *   2. Quiesce the live workloads (scale Deployments to 0).
 *   3. Tar-extract the snapshot archive over the existing PVC.
 *   4. Unquiesce.
 *
 * No PVC recreation — the existing PVC stays bound, contents are
 * replaced in-place. This matches the snapshotTenant round-trip
 * (capture is also a tar over the same PVC mount).
 *
 * Returns immediately; caller polls storage_operations for progress.
 */
export async function rollbackToSnapshot(
  ctx: ServiceCtx,
  tenantId: string,
  snapshotId: string,
  params: { triggeredByUserId?: string | null } = {},
): Promise<{ operationId: string; snapshotId: string }> {
  const tenant = await mustGetTenant(ctx.db, tenantId);
  await mustBeIdle(ctx.db, tenantId);

  const [snap] = await ctx.db.select().from(storageSnapshots).where(
    and(eq(storageSnapshots.id, snapshotId), eq(storageSnapshots.tenantId, tenantId), eq(storageSnapshots.status, 'ready')),
  ).limit(1);
  if (!snap) {
    throw new ApiError(
      'SNAPSHOT_NOT_FOUND',
      `Snapshot ${snapshotId} not found, not owned by tenant ${tenantId}, or not in 'ready' status`,
      404,
    );
  }

  const opId = uuid();
  await ctx.db.transaction(async (tx) => {
    await tx.insert(storageOperations).values({
      id: opId,
      tenantId,
      opType: 'restore',
      state: 'restoring',
      progressPct: 0,
      progressMessage: 'Quiescing workloads',
      snapshotId: snap.id,
      params: { fromSnapshot: snap.id, kind: snap.kind },
      triggeredByUserId: params.triggeredByUserId ?? null,
    });
    await tx.update(tenants)
      .set({ storageLifecycleState: 'restoring', activeStorageOpId: opId })
      .where(eq(tenants.id, tenantId));
  });

  void runRollbackToSnapshot(ctx, opId, snap.id, snap.archivePath, tenant.kubernetesNamespace, tenantId)
    .catch((err) => { console.error(`[storage-lifecycle] runRollbackToSnapshot pre-orchestrator throw for op ${opId}:`, err); });
  return { operationId: opId, snapshotId: snap.id };
}

/**
 * Phase 5 of the snapshot-storage overhaul: pick the right restore
 * store for a given snapshot row.
 *
 *   - target_id IS NOT NULL (Phase 3+ rows): resolve via
 *     `resolveSnapshotStoreByTargetId` so restore reads from the EXACT
 *     target that originally received the upload, regardless of how
 *     class assignments may have changed since.
 *   - target_id IS NULL (legacy pre-Phase-3 rows): fall back to
 *     `ctx.store` (the legacy single-active-target / hostpath
 *     resolver). These rows have `archive_path` in the old layout
 *     (`<tenantId>/<snapId>.tar.gz` without per-class prefix).
 *
 * Throws TARGET_REMOVED if the stamped target was deleted (the
 * snapshot row's target_id was nulled by ON DELETE SET NULL but the
 * caller passed an out-of-date snap object).
 */
async function resolveRestoreStore(
  ctx: ServiceCtx,
  snap: { id: string; targetId: string | null; snapshotClass: string },
): Promise<SnapshotStore> {
  if (!snap.targetId) {
    // Pre-Phase-3 row — use whatever the legacy resolver gives us.
    return ctx.store;
  }
  const { resolveSnapshotStoreByTargetId } = await import('./snapshot-store.js');
  const cls = snap.snapshotClass as import('@k8s-hosting/api-contracts').SnapshotClass;
  const store = await resolveSnapshotStoreByTargetId(ctx.db, snap.targetId, cls);
  if (!store) {
    throw new ApiError(
      'TARGET_REMOVED',
      `Snapshot ${snap.id} was uploaded to target ${snap.targetId} which has since been deleted. ` +
      `Manual recovery required: locate the archive in the original target's bucket.`,
      410,
    );
  }
  return store;
}

async function runRollbackToSnapshot(
  ctx: ServiceCtx,
  opId: string,
  snapId: string,
  archivePath: string,
  namespace: string,
  tenantId: string,
): Promise<void> {
  let quiesceSnap: QuiesceSnapshot | null = null;
  const pvcName = `${namespace}-storage`;
  try {
    // Phase 5: re-fetch the snapshot row so we have its target_id +
    // snapshot_class to drive per-target restore lookup.
    const [snap] = await ctx.db.select().from(storageSnapshots).where(eq(storageSnapshots.id, snapId)).limit(1);
    const restoreStore = snap
      ? await resolveRestoreStore(ctx, snap)
      : ctx.store; // defensive — snap should always exist; fall back to legacy

    quiesceSnap = await quiesce(ctx.k8s, namespace);
    await waitForQuiesced(ctx.k8s, namespace);
    await updateOp(ctx.db, opId, { progressPct: 30, progressMessage: 'Restoring data from snapshot' });

    await restoreTenantPVC(ctx.k8s, {
      namespace, pvcName, tenantId, snapshotId: snapId, archivePath, store: restoreStore,
      onProgress: async (msg) => { await updateOp(ctx.db, opId, { progressMessage: msg }); },
    });

    await updateOp(ctx.db, opId, { progressPct: 90, progressMessage: 'Unquiescing workloads' });
    await unquiesce(ctx.k8s, namespace, quiesceSnap);
    await updateOp(ctx.db, opId, {
      state: 'idle',
      progressPct: 100,
      progressMessage: 'Rollback complete',
      completedAt: new Date(),
    });
    await markTenantState(ctx.db, tenantId, 'idle', null);
  } catch (err) {
    if (quiesceSnap) await unquiesce(ctx.k8s, namespace, quiesceSnap).catch(() => {});
    const persisted = formatLifecycleError(err, 'pvc');
    await updateOp(ctx.db, opId, { state: 'failed', lastError: persisted, completedAt: new Date() });
    await markTenantState(ctx.db, tenantId, 'failed', null);
  }
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

    const tenantId = (await currentTenantId(ctx.db, opId))!;
    // Phase 5: per-target restore for new rows; legacy ctx.store for old.
    const [snap] = await ctx.db.select().from(storageSnapshots).where(eq(storageSnapshots.id, snapId)).limit(1);
    const restoreStore = snap ? await resolveRestoreStore(ctx, snap) : ctx.store;
    await restoreTenantPVC(ctx.k8s, {
      namespace, pvcName, tenantId, snapshotId: snapId, archivePath, store: restoreStore,
      onProgress: async (msg) => { await updateOp(ctx.db, opId, { progressMessage: msg }); },
    });

    await updateOp(ctx.db, opId, {
      state: 'idle', progressPct: 100,
      progressMessage: 'Restore complete — redeploy workloads via deployments API to bring the tenant back online',
      completedAt: new Date(),
    });
    // Phase A1: dispatch the explicit `restored` transition so the
    // hook_runs audit trail records this as restore-from-archive
    // rather than plain unsuspend. tenants-status-stamp hook writes
    // status='active' + clears archivedAt; here we only clear the
    // storage-lifecycle state.
    const { applyRestored } = await import('../tenant-lifecycle/cascades.js');
    await applyRestored({ db: ctx.db, k8s: ctx.k8s }, tenantId, namespace);
    await ctx.db.update(tenants).set({
      storageLifecycleState: 'idle',
      activeStorageOpId: null,
    }).where(eq(tenants.id, tenantId));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const persisted = formatLifecycleError(err, 'pvc');
    await updateOp(ctx.db, opId, { state: 'failed', lastError: persisted, completedAt: new Date() });
    const cId = await currentTenantId(ctx.db, opId);
    if (cId) await markTenantState(ctx.db, cId, 'failed', null);
  }
}

// ─── Filesystem check / repair (fsck) ──────────────────────────────────

/**
 * Look up the PV name + node placement + fsType for a tenant's tenant
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

  // Longhorn Volume CR → currentNodeID (where /dev/longhorn/<vol> exists
  // when attached). When detached, currentNodeID is empty string ""
  // (NOT undefined), so the `??` operator does NOT fall through to
  // ownerID — we have to check truthiness explicitly. ownerID is
  // populated even when detached (set to the node Longhorn picks as
  // the volume's "owner" — a viable attach target).
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
    const currentNode = lhVol.status?.currentNodeID;
    const ownerNode = lhVol.status?.ownerID;
    nodeName = (currentNode && currentNode.length > 0)
      ? currentNode
      : (ownerNode && ownerNode.length > 0 ? ownerNode : '');
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
export async function fsckCheckTenant(
  ctx: ServiceCtx,
  tenantId: string,
  opts: { triggeredByUserId?: string | null } = {},
): Promise<{ operationId: string }> {
  return startFsck(ctx, tenantId, true, opts);
}

/**
 * Repair-mode filesystem check. Same flow as check, but the tool is
 * allowed to write to the filesystem (xfs_repair without -n; e2fsck -y).
 * Operator-initiated only — the storage-lifecycle UI surfaces a
 * confirmation modal because writes here can lose data on a badly
 * damaged filesystem.
 */
export async function fsckRepairTenant(
  ctx: ServiceCtx,
  tenantId: string,
  opts: { triggeredByUserId?: string | null } = {},
): Promise<{ operationId: string }> {
  return startFsck(ctx, tenantId, false, opts);
}

async function startFsck(
  ctx: ServiceCtx,
  tenantId: string,
  dryRun: boolean,
  opts: { triggeredByUserId?: string | null },
): Promise<{ operationId: string }> {
  const tenant = await mustGetTenant(ctx.db, tenantId);
  await mustBeIdle(ctx.db, tenantId);

  const opId = uuid();
  await ctx.db.transaction(async (tx) => {
    await tx.insert(storageOperations).values({
      id: opId,
      tenantId,
      opType: 'fsck',
      state: 'quiescing',
      progressPct: 0,
      progressMessage: dryRun ? 'Starting fsck (dry-run)' : 'Starting fsck repair',
      params: { dryRun },
      triggeredByUserId: opts.triggeredByUserId ?? null,
    });
    await tx.update(tenants)
      .set({ storageLifecycleState: 'quiescing', activeStorageOpId: opId })
      .where(eq(tenants.id, tenantId));
  });

  // Async — caller polls /admin/storage/operations/:id for progress.
  void runFsckOp(ctx, opId, tenant.kubernetesNamespace, dryRun)
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
  const progress = async (state: typeof tenants.$inferSelect['storageLifecycleState'], pct: number, msg: string) => {
    await updateOp(ctx.db, opId, { state, progressPct: pct, progressMessage: msg });
    await ctx.db.update(tenants)
      .set({ storageLifecycleState: state })
      .where(eq(tenants.activeStorageOpId, opId));
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

    // Volume is detached after quiesce. fsck Pod uses hostPath
    // /dev/longhorn/<vol> which only exists when Longhorn has the
    // volume attached. Force-attach to the chosen node before
    // running fsck. Frontend stays as blockdev (default) so the
    // device file appears; nothing mounts the filesystem (xfs_repair/
    // e2fsck require unmounted), so it's safe to operate.
    await progress('quiescing', 25, `Attaching volume to ${located.nodeName} for fsck`);
    await attachLonghornVolume(ctx.k8s, located.volumeName, located.nodeName);
    await waitForVolumeAttached(ctx.k8s, located.volumeName, located.nodeName);

    await progress('quiescing', 30, dryRun ? `Running ${located.fsType} dry-run check` : `Running ${located.fsType} repair`);
    const { runFsck } = await import('./fsck.js');
    const result = await runFsck(ctx.k8s, {
      namespace,
      volumeName: located.volumeName,
      tenantId: (await currentTenantId(ctx.db, opId))!,
      fsType: located.fsType,
      dryRun,
      nodeName: located.nodeName,
      onProgress: async (msg) => { await updateOp(ctx.db, opId, { progressMessage: msg }); },
    });

    // Release the explicit attach. ensureVolumeReattached below will
    // re-attach via file-manager if the tenant has nothing else to
    // run; otherwise unquiesce restores tenant workloads which give
    // the PVC a real consumer.
    await detachLonghornVolume(ctx.k8s, located.volumeName).catch(() => {});

    await progress('unquiescing', 85, 'Scaling workloads back up');
    if (quiesceSnap) await unquiesce(ctx.k8s, namespace, quiesceSnap);
    // fsck used hostPath /dev/longhorn/<vol> instead of PVC mount, so
    // Longhorn detached the volume during quiesce and has no reason
    // to re-attach unless a Pod actually consumes the PVC. If
    // unquiesce restored zero workloads (e.g. file-manager was 0
    // before fsck — its idle default — and the tenant deployment is
    // also 0), the volume is left dangling. Bump file-manager to 1
    // so the PVC has a consumer; idle-cleanup will scale it back down
    // after the inactivity window. Best-effort — failure here doesn't
    // invalidate the fsck result.
    await ensureVolumeReattached(ctx.k8s, namespace).catch((err) => {
      console.warn(`[storage-lifecycle] fsck post-attach (op ${opId}):`, err);
    });

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

    const cId = await currentTenantId(ctx.db, opId);
    if (cId) await markTenantState(ctx.db, cId, result.clean ? 'idle' : 'failed', null);
  } catch (err) {
    const persisted = formatLifecycleError(err, 'pvc');
    await updateOp(ctx.db, opId, {
      state: 'failed', lastError: persisted, completedAt: new Date(),
    });
    // Best-effort cleanup: drop the explicit attach hold, then
    // restore workloads, then ensure file-manager scales up so the
    // PVC has a Pod consumer (Longhorn re-attach).
    await detachLonghornVolumeByPvc(ctx.k8s, namespace, pvcName).catch(() => {});
    if (quiesceSnap) {
      await unquiesce(ctx.k8s, namespace, quiesceSnap).catch(() => {});
    }
    await ensureVolumeReattached(ctx.k8s, namespace).catch(() => {});
    const cId = await currentTenantId(ctx.db, opId);
    if (cId) await markTenantState(ctx.db, cId, 'failed', null);
  }
}

/**
 * Force-attach (or detach) a Longhorn volume by patching the
 * `volumeattachments.longhorn.io` CR (NOT the Volume's spec.nodeID,
 * which Longhorn's mutation webhook silently clears on direct
 * patches — Longhorn 1.6+ uses a separate VolumeAttachment CR with
 * "attachment tickets" to coordinate attach/detach across competing
 * consumers).
 *
 * To attach: add a ticket keyed by `FSCK_ATTACH_TICKET` with
 *   { id, type: 'longhorn-api', nodeID, parameters: {disableFrontend:'false'} }
 * To detach: set the same ticket key to null (merge-patch removes it).
 *
 * Frontend stays "blockdev" (disableFrontend=false) so /dev/longhorn/<vol>
 * appears on the target node — fsck's hostPath relies on this device
 * file existing.
 */
const FSCK_ATTACH_TICKET = 'platform-fsck';

async function attachLonghornVolume(k8s: K8sClients, volumeName: string, nodeID: string): Promise<void> {
  const { MERGE_PATCH } = await import('../../shared/k8s-patch.js');
  await (k8s.custom as unknown as {
    patchNamespacedCustomObject: (
      a: { group: string; version: string; namespace: string; plural: string; name: string; body: unknown },
      mw: typeof MERGE_PATCH,
    ) => Promise<unknown>;
  }).patchNamespacedCustomObject(
    {
      group: 'longhorn.io', version: 'v1beta2',
      namespace: 'longhorn-system', plural: 'volumeattachments', name: volumeName,
      body: {
        spec: {
          attachmentTickets: {
            [FSCK_ATTACH_TICKET]: {
              id: FSCK_ATTACH_TICKET,
              type: 'longhorn-api',
              nodeID,
              parameters: {
                disableFrontend: 'false',
                lastAttachedBy: '',
              },
            },
          },
        },
      },
    },
    MERGE_PATCH,
  );
}

async function detachLonghornVolume(k8s: K8sClients, volumeName: string): Promise<void> {
  // null in merge-patch removes the key — clearing our ticket lets
  // Longhorn detach (assuming no other consumers hold tickets).
  const { MERGE_PATCH } = await import('../../shared/k8s-patch.js');
  await (k8s.custom as unknown as {
    patchNamespacedCustomObject: (
      a: { group: string; version: string; namespace: string; plural: string; name: string; body: unknown },
      mw: typeof MERGE_PATCH,
    ) => Promise<unknown>;
  }).patchNamespacedCustomObject(
    {
      group: 'longhorn.io', version: 'v1beta2',
      namespace: 'longhorn-system', plural: 'volumeattachments', name: volumeName,
      body: { spec: { attachmentTickets: { [FSCK_ATTACH_TICKET]: null } } },
    },
    MERGE_PATCH,
  );
}

/** Convenience: look up volumeName from the tenant's PVC, then detach. */
async function detachLonghornVolumeByPvc(
  k8s: K8sClients,
  namespace: string,
  pvcName: string,
): Promise<void> {
  const pvc = await k8s.core.readNamespacedPersistentVolumeClaim({ name: pvcName, namespace })
    .catch(() => null);
  const volumeName = (pvc as { spec?: { volumeName?: string } } | null)?.spec?.volumeName;
  if (!volumeName) return;
  await detachLonghornVolume(k8s, volumeName);
}

/**
 * Wait for Longhorn to report state=attached on the expected node.
 * Times out after 60s — Longhorn typically attaches in 5-15s.
 */
async function waitForVolumeAttached(
  k8s: K8sClients,
  volumeName: string,
  expectedNode: string,
  timeoutMs = 60_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const lhVol = await (k8s.custom as unknown as {
      getNamespacedCustomObject: (a: {
        group: string; version: string; namespace: string; plural: string; name: string;
      }) => Promise<{ status?: { state?: string; currentNodeID?: string } }>;
    }).getNamespacedCustomObject({
      group: 'longhorn.io', version: 'v1beta2',
      namespace: 'longhorn-system', plural: 'volumes', name: volumeName,
    }).catch(() => ({ status: undefined }));
    if (lhVol.status?.state === 'attached' && lhVol.status?.currentNodeID === expectedNode) {
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Longhorn volume ${volumeName} did not attach to ${expectedNode} within ${timeoutMs}ms`);
}

/**
 * Best-effort: scale file-manager to 1 if it isn't already, so the
 * tenant PVC gains a Pod consumer and Longhorn re-attaches the volume.
 * Used after fsck (which detaches via quiesce + uses hostPath instead
 * of PVC mount, so Longhorn has no reason to keep the volume attached).
 *
 * Also bumps the file-manager last-access annotation so the
 * idle-cleanup scheduler doesn't immediately scale FM back to 0
 * (cleanup uses Deployment creationTimestamp as the floor when no
 * annotation is set — for a long-lived Deployment that's effectively
 * "idle since creation", which trips the timeout instantly).
 *
 * The idle-cleanup will scale FM back to 0 after the inactivity
 * window from NOW, so this is a transient state change — long enough
 * for Longhorn to re-attach the volume.
 */
async function ensureVolumeReattached(k8s: K8sClients, namespace: string): Promise<void> {
  try {
    const dep = await (k8s.apps as unknown as {
      readNamespacedDeployment: (a: { name: string; namespace: string }) => Promise<{ spec?: { replicas?: number } }>;
    }).readNamespacedDeployment({ name: 'file-manager', namespace });
    const current = dep.spec?.replicas ?? 0;
    // Bump the last-access annotation in BOTH cases (current=0 and
    // current>=1) so the idle-cleanup sees a fresh access timestamp
    // and doesn't reap the FM during the post-fsck attach window.
    const { recordFileManagerAccess } = await import('../file-manager/idle-cleanup.js');
    recordFileManagerAccess(namespace, k8s);
    if (current >= 1) return; // someone else already kept it up
    const { STRATEGIC_MERGE_PATCH } = await import('../../shared/k8s-patch.js');
    await (k8s.apps as unknown as {
      patchNamespacedDeploymentScale: (a: { name: string; namespace: string; body: unknown }, mw: typeof STRATEGIC_MERGE_PATCH) => Promise<unknown>;
    }).patchNamespacedDeploymentScale({
      name: 'file-manager',
      namespace,
      body: { spec: { replicas: 1 } },
    }, STRATEGIC_MERGE_PATCH);
  } catch {
    // file-manager Deployment may not exist (suspended/archived
    // tenant). The next lifecycle op or Files-page interaction will
    // recreate it; we don't try to provision it from here.
  }
}

// ─── Listing + housekeeping ────────────────────────────────────────────

export async function listSnapshotsForTenant(db: Database, tenantId: string) {
  return db.select().from(storageSnapshots).where(eq(storageSnapshots.tenantId, tenantId)).orderBy(desc(storageSnapshots.createdAt));
}

export async function listOperationsForTenant(db: Database, tenantId: string, limit = 50) {
  return db.select().from(storageOperations).where(eq(storageOperations.tenantId, tenantId)).orderBy(desc(storageOperations.createdAt)).limit(limit);
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
 * Report provisioned vs actually-used storage for every tenant. The cron
 * publishes this once a week for capacity planning. For now, just
 * computes + returns — emit via logger or email in a later pass.
 */
export async function storageAuditReport(ctx: ServiceCtx): Promise<Array<{
  tenantId: string;
  namespace: string;
  provisionedGi: number;
  usedBytes: number;
  wastePct: number;
}>> {
  const rows = await ctx.db.select({
    id: tenants.id,
    ns: tenants.kubernetesNamespace,
    storageLimitOverride: tenants.storageLimitOverride,
    planId: tenants.planId,
  }).from(tenants).where(
    and(eq(tenants.status, 'active'), sql`${tenants.kubernetesNamespace} IS NOT NULL`),
  );
  const out = [];
  for (const r of rows) {
    const provisionedGi = Math.round(Number(r.storageLimitOverride ?? 0)) || await getPlanStorageGi(ctx.db, r.planId);
    const used = await measurePvcUsed(ctx, r.ns!);
    const provisionedBytes = provisionedGi * 1024 * 1024 * 1024;
    const wastePct = provisionedBytes > 0 ? Math.round(((provisionedBytes - used) / provisionedBytes) * 100) : 0;
    out.push({ tenantId: r.id, namespace: r.ns!, provisionedGi, usedBytes: used, wastePct });
  }
  return out;
}
