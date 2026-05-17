import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { resolveSnapshotStore } from './snapshot-store.js';
import {
  getRedactedStorageLifecycleSettings,
  saveStorageLifecycleSettings,
  storageLifecycleSettingsSchema,
} from './settings.js';
import * as service from './service.js';

// Accept both the legacy `newGi` (integer GiB) and the new `newMib`
// (integer MiB). `newMib` is preferred — admins increasingly want
// fractional-GiB sizes (e.g. 2500 MiB) for right-sizing. `newGi`
// stays for backward compat and is converted to MiB internally.
const resizeSchema = z.object({
  newGi: z.number().int().min(1).max(10000).optional(),
  newMib: z.number().int().min(100).max(10000000).optional(),
}).refine((d) => d.newGi !== undefined || d.newMib !== undefined, {
  message: 'One of newGi or newMib is required',
});
const snapshotSchema = z.object({
  label: z.string().max(255).optional(),
  retentionDays: z.number().int().min(1).max(3650).optional(),
});
const archiveSchema = z.object({
  retentionDays: z.number().int().min(1).max(3650).optional(),
});
const restoreSchema = z.object({
  newGi: z.number().int().min(1).max(1000).optional(),
});

export async function storageLifecycleRoutes(app: FastifyInstance): Promise<void> {
  // All ops are admin-only.
  const adminGate = [authenticate, requireRole('super_admin', 'admin')];

  async function ctx() {
    const kcfg = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kcfg);
    const store = await resolveSnapshotStore(app.db, app.config as Record<string, unknown>);
    const platformNamespace = ((app.config as Record<string, unknown>).PLATFORM_NAMESPACE as string | undefined) ?? 'platform';
    return { db: app.db, k8s, store, platformNamespace };
  }

  /**
   * Phase 3 of the snapshot-storage overhaul: per-class store resolver.
   * Builds a ctx whose store routes to the assigned primary target for
   * the given snapshot class. Throws NO_SNAPSHOT_TARGET (409) if the
   * class is unassigned — fail-loud per the locked decision.
   *
   * Used by tenant-PVC snapshot ops (manual, pre-resize, pre-archive).
   * Non-snapshot ops (suspend, resume, fsck) keep the legacy ctx() since
   * they don't write to a backup target.
   */
  async function snapshotCtx(snapshotClass: import('@k8s-hosting/api-contracts').SnapshotClass) {
    const kcfg = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kcfg);
    const platformNamespace = ((app.config as Record<string, unknown>).PLATFORM_NAMESPACE as string | undefined) ?? 'platform';
    const { resolveSnapshotStoreForClass } = await import('./snapshot-store.js');
    const bundle = await resolveSnapshotStoreForClass(
      app.db,
      app.config as Record<string, unknown>,
      snapshotClass,
      // Phase 11: pass k8s ctx so CIFS stores can spawn one-shot Jobs
      // for stat/delete/readSidecar during housekeeping + restore.
      { k8sCtx: { k8s, namespace: platformNamespace } },
    );
    return {
      db: app.db,
      k8s,
      store: bundle.store,
      platformNamespace,
      targetId: bundle.targetId,
      snapshotClass,
    };
  }

  // ─── Resize ──────────────────────────────────────────────────────────

  app.post('/admin/tenants/:tenantId/storage/resize/dry-run', {
    onRequest: adminGate,
    schema: {
      tags: ['Storage Lifecycle'],
      summary: 'Estimate a resize without mutating anything',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const parsed = resizeSchema.safeParse(request.body);
    if (!parsed.success) throw new ApiError('VALIDATION_ERROR', parsed.error.issues[0].message, 400);
    const mib = parsed.data.newMib ?? (parsed.data.newGi! * 1024);
    const result = await service.resizeDryRunMib(await ctx(), tenantId, mib);
    return success(result);
  });

  app.post('/admin/tenants/:tenantId/storage/resize', {
    onRequest: adminGate,
    schema: {
      tags: ['Storage Lifecycle'],
      summary: 'Resize a tenant PVC (shrink supported via snapshot+recreate)',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const parsed = resizeSchema.safeParse(request.body);
    if (!parsed.success) throw new ApiError('VALIDATION_ERROR', parsed.error.issues[0].message, 400);
    const userId = ((request.user as { id?: string } | undefined)?.id) ?? null;
    const mib = parsed.data.newMib ?? (parsed.data.newGi! * 1024);
    // Resize takes a pre-resize snapshot — use the per-class resolver
    // so that snapshot routes to the assigned tenant_snapshot target
    // and gets stamped with target_id for forensic lookup on restore.
    const { operationId } = await service.resizeTenant(await snapshotCtx('tenant_snapshot'), tenantId, {
      newMib: mib,
      triggeredByUserId: userId,
    });
    return success({ operationId });
  });

  // ─── Manual snapshot ────────────────────────────────────────────────

  app.post('/admin/tenants/:tenantId/storage/snapshot', {
    onRequest: adminGate,
    schema: {
      tags: ['Storage Lifecycle'],
      summary: 'Take an ad-hoc snapshot of a tenant PVC',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const parsed = snapshotSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ApiError('VALIDATION_ERROR', parsed.error.issues[0].message, 400);
    const userId = ((request.user as { id?: string } | undefined)?.id) ?? null;
    // Manual snapshot → per-class resolver for tenant_snapshot.
    const snap = await service.snapshotTenant(await snapshotCtx('tenant_snapshot'), tenantId, {
      label: parsed.data.label,
      retentionDays: parsed.data.retentionDays,
      triggeredByUserId: userId,
    });
    return success(snap);
  });

  app.get('/admin/tenants/:tenantId/storage/snapshots', {
    onRequest: adminGate,
    schema: { tags: ['Storage Lifecycle'], summary: 'List snapshots for a tenant', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    return success(await service.listSnapshotsForTenant(app.db, tenantId));
  });

  app.delete('/admin/storage/snapshots/:snapshotId', {
    onRequest: adminGate,
    schema: { tags: ['Storage Lifecycle'], summary: 'Delete a snapshot (removes archive + DB row)', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { snapshotId } = request.params as { snapshotId: string };
    await service.deleteSnapshot(await ctx(), snapshotId);
    return success({ deleted: snapshotId });
  });

  // ─── Rollback to a specific snapshot ─────────────────────────────────
  //
  // Phase 5 of the snapshot-storage overhaul: rollback exercises the
  // streaming restore pipeline (rclone cat | gunzip | tar x). Resolves
  // the store per-snapshot-row target_id so rollback reads from the
  // exact target that received the original upload, regardless of
  // current class assignments. Legacy ctx() is fine here because the
  // service-internal `resolveRestoreStore` swaps ctx.store as needed.
  const rollbackSchema = z.object({ snapshotId: z.string().uuid() });
  app.post('/admin/tenants/:tenantId/storage/rollback', {
    onRequest: adminGate,
    schema: {
      tags: ['Storage Lifecycle'],
      summary: 'Roll back tenant data PVC to a specific snapshot (without archiving first)',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const parsed = rollbackSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ApiError('VALIDATION_ERROR', parsed.error.issues[0].message, 400);
    const userId = ((request.user as { id?: string } | undefined)?.id) ?? null;
    return success(await service.rollbackToSnapshot(await ctx(), tenantId, parsed.data.snapshotId, {
      triggeredByUserId: userId,
    }));
  });

  // ─── Suspend / Resume ───────────────────────────────────────────────

  app.post('/admin/tenants/:tenantId/storage/suspend', {
    onRequest: adminGate,
    schema: { tags: ['Storage Lifecycle'], summary: 'Suspend a tenant — scale workloads to 0, preserve PVC', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const userId = ((request.user as { id?: string } | undefined)?.id) ?? null;
    return success(await service.suspendTenant(await ctx(), tenantId, { triggeredByUserId: userId }));
  });

  app.post('/admin/tenants/:tenantId/storage/resume', {
    onRequest: adminGate,
    schema: { tags: ['Storage Lifecycle'], summary: 'Resume a suspended tenant — restore workloads to prior replica counts', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const userId = ((request.user as { id?: string } | undefined)?.id) ?? null;
    return success(await service.resumeTenant(await ctx(), tenantId, { triggeredByUserId: userId }));
  });

  // ─── Archive / Restore ──────────────────────────────────────────────

  app.post('/admin/tenants/:tenantId/storage/archive', {
    onRequest: adminGate,
    schema: { tags: ['Storage Lifecycle'], summary: 'Archive a tenant — final snapshot + delete PVC/workloads', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const parsed = archiveSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ApiError('VALIDATION_ERROR', parsed.error.issues[0].message, 400);
    const userId = ((request.user as { id?: string } | undefined)?.id) ?? null;
    // Archive takes a pre-archive snapshot — class-routed so the
    // long-retention archive lands on the operator-chosen target.
    return success(await service.archiveTenant(await snapshotCtx('tenant_snapshot'), tenantId, {
      retentionDays: parsed.data.retentionDays,
      triggeredByUserId: userId,
    }));
  });

  app.post('/admin/tenants/:tenantId/storage/restore', {
    onRequest: adminGate,
    schema: { tags: ['Storage Lifecycle'], summary: 'Restore an archived tenant from its pre-archive snapshot', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const parsed = restoreSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ApiError('VALIDATION_ERROR', parsed.error.issues[0].message, 400);
    const userId = ((request.user as { id?: string } | undefined)?.id) ?? null;
    return success(await service.restoreArchivedTenant(await ctx(), tenantId, {
      newGi: parsed.data.newGi,
      triggeredByUserId: userId,
    }));
  });

  // ─── Operations + audit ─────────────────────────────────────────────

  app.get('/admin/tenants/:tenantId/storage/operations', {
    onRequest: adminGate,
    schema: { tags: ['Storage Lifecycle'], summary: 'List recent storage operations for a tenant', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    return success(await service.listOperationsForTenant(app.db, tenantId));
  });

  app.get('/admin/storage/operations/:operationId', {
    onRequest: adminGate,
    schema: { tags: ['Storage Lifecycle'], summary: 'Poll one storage operation by id (for progress UI)', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { operationId } = request.params as { operationId: string };
    const op = await service.getOperation(app.db, operationId);
    if (!op) throw new ApiError('OPERATION_NOT_FOUND', `Operation ${operationId} not found`, 404);
    return success(op);
  });

  app.get('/admin/storage/audit', {
    onRequest: adminGate,
    schema: { tags: ['Storage Lifecycle'], summary: 'Platform-wide provisioned vs used storage report', security: [{ bearerAuth: [] }] },
  }, async () => {
    return success(await service.storageAuditReport(await ctx()));
  });

  // ─── Snapshot quota (Phase 6 of snapshot-storage overhaul) ─────────
  //
  // Per-tenant: current vs plan cap. Admin UI uses this on the
  // per-tenant storage page to show the fill bar. Cluster-wide:
  // system_snapshot usage for the Storage > Overview tile.
  app.get('/admin/tenants/:tenantId/storage/snapshot-quota', {
    onRequest: adminGate,
    schema: {
      tags: ['Storage Lifecycle'],
      summary: 'Per-tenant snapshot quota usage vs plan cap',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const { getSnapshotQuotaUsage } = await import('./snapshot-quota.js');
    const usage = await getSnapshotQuotaUsage(app.db, tenantId);
    if (!usage) throw new ApiError('CLIENT_NOT_FOUND', `Tenant ${tenantId} not found`, 404);
    return success(usage);
  });

  // ─── Backfill (Phase 7 of snapshot-storage overhaul) ───────────────
  //
  // Inventory pass: enumerate snapshots needing Phase 7 backfill.
  // Read-only — operator inspects before running the backfill Job.
  app.get('/admin/storage/snapshot-backfill', {
    onRequest: adminGate,
    schema: {
      tags: ['Storage Lifecycle'],
      summary: 'Inventory of snapshot rows needing Phase 7 backfill to assigned target',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const { buildBackfillInventory, checkBackfillPreconditions, getBackfillSummary } = await import('./backfill.js');
    const [inv, preconditions, summary] = await Promise.all([
      buildBackfillInventory(app.db),
      checkBackfillPreconditions(app.db),
      getBackfillSummary(app.db),
    ]);
    return success({
      summary,
      preconditions,
      inventory: {
        totalRows: inv.totalRows,
        needsBackfill: inv.needsBackfill.length,
        alreadyMigrated: inv.alreadyMigrated,
        failedRows: inv.failedRows,
      },
    });
  });

  app.get('/admin/storage/system-snapshot-usage', {
    onRequest: adminGate,
    schema: {
      tags: ['Storage Lifecycle'],
      summary: 'Cluster-wide system snapshot byte/count totals',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const { getSystemSnapshotUsage } = await import('./snapshot-quota.js');
    return success(await getSystemSnapshotUsage(app.db));
  });

  // ─── Snapshot accounting (Phase 1 of snapshot-storage overhaul) ──────
  //
  // Per-class + per-tenant rollup of every storage_snapshots row so
  // operators have visibility into snapshot disk usage before quotas
  // (Phase 6) are enforced. Pure read; no Kubernetes dependency.
  app.get('/admin/storage/snapshot-accounting', {
    onRequest: adminGate,
    schema: {
      tags: ['Storage Lifecycle'],
      summary: 'Per-class + per-tenant snapshot byte/count rollup',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const { loadSnapshotAccounting } = await import('./snapshot-accounting.js');
    return success(await loadSnapshotAccounting(app.db));
  });

  // ─── Filesystem check / repair ──────────────────────────────────────
  //
  // Two modes:
  //   /storage/fsck         → dry run (xfs_repair -n / e2fsck -n)
  //   /storage/fsck-repair  → real repair (xfs_repair / e2fsck -y)
  //
  // BOTH require quiesce because xfs_repair refuses to operate on a
  // mounted filesystem even with -n. The orchestrator handles
  // scale-to-zero + scale-back. The Pod runs privileged on the node
  // where Longhorn has the volume attached so it can hit
  // /dev/longhorn/<pvname> directly.
  //
  // Output is captured into the operation row's progressMessage
  // (clean) or lastError (errors found). Frontend polls the op id
  // and renders the full report in a modal.
  app.post('/admin/tenants/:tenantId/storage/fsck', {
    onRequest: adminGate,
    schema: {
      tags: ['Storage Lifecycle'],
      summary: 'Run a dry-run filesystem check (xfs_repair -n / e2fsck -n) on a tenant PVC',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const userId = ((request.user as { id?: string } | undefined)?.id) ?? null;
    return success(await service.fsckCheckTenant(await ctx(), tenantId, { triggeredByUserId: userId }));
  });

  app.post('/admin/tenants/:tenantId/storage/fsck-repair', {
    onRequest: adminGate,
    schema: {
      tags: ['Storage Lifecycle'],
      summary: 'Run a repair-mode filesystem check on a tenant PVC (writes to disk; quiesces tenant)',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const userId = ((request.user as { id?: string } | undefined)?.id) ?? null;
    return success(await service.fsckRepairTenant(await ctx(), tenantId, { triggeredByUserId: userId }));
  });

  // ─── Operator recovery ──────────────────────────────────────────────
  //
  // When an op fails partway through (e.g. PVC delete times out), the
  // tenant is stuck in state='failed' and any subsequent ops return 409.
  // This endpoint is the safety valve — admin resets the state back to
  // 'idle' so the next op can proceed. The failed operation's DB row is
  // NOT removed so the original error is still auditable.

  // Force-cancel an in-progress storage operation. Works on ANY
  // non-idle state (quiescing/snapshotting/resizing/restoring/fsck).
  // Useful when the underlying K8s Job is wedged (quota / image-pull
  // / orphaned). Best-effort deletes the Job(s) and resets the
  // tenant's storage state to idle so subsequent ops can proceed.
  app.post('/admin/tenants/:tenantId/storage/cancel', {
    onRequest: adminGate,
    schema: {
      tags: ['Storage Lifecycle'],
      summary: "Force-cancel a tenant's in-progress storage operation and reset state to idle",
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    return success(await service.cancelStorageOperation(await ctx(), tenantId));
  });

  app.post('/admin/tenants/:tenantId/storage/clear-failed', {
    onRequest: adminGate,
    schema: {
      tags: ['Storage Lifecycle'],
      summary: "Force-clear a tenant's stuck 'failed' storage state back to idle",
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    return success(await service.clearFailedStorageState(app.db, tenantId));
  });

  // ─── Settings ───────────────────────────────────────────────────────
  //
  // Admin-only CRUD over the DB-backed snapshot-store config. Secrets
  // (`s3SecretAccessKey`, `azureConnectionString`) are never returned
  // — GET returns `*Set: true/false` flags so the UI can show an
  // indicator without leaking plaintext; PATCH omits a field to leave
  // it unchanged, or passes `null` to clear it.

  app.get('/admin/settings/storage-lifecycle', {
    onRequest: adminGate,
    schema: {
      tags: ['Storage Lifecycle'],
      summary: 'Get storage-lifecycle platform settings (secrets redacted)',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    return success(await getRedactedStorageLifecycleSettings(app.db));
  });

  app.patch('/admin/settings/storage-lifecycle', {
    onRequest: adminGate,
    schema: {
      tags: ['Storage Lifecycle'],
      summary: 'Update storage-lifecycle platform settings',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const parsed = storageLifecycleSettingsSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', parsed.error.issues[0].message, 400, {
        field: parsed.error.issues[0].path.join('.'),
      });
    }
    await saveStorageLifecycleSettings(app.db, parsed.data);

    // Audit-log the change. Secrets are referenced by key name only,
    // never by value, so the log is safe to retain long-term.
    try {
      const { auditLogs } = await import('../../db/schema.js');
      const actorId = (request.user as { sub?: string; id?: string } | undefined)?.sub
        ?? (request.user as { id?: string } | undefined)?.id
        ?? null;
      const changedKeys = Object.keys(parsed.data);
      await app.db.insert(auditLogs).values({
        id: crypto.randomUUID(),
        tenantId: null,
        actionType: 'storage_lifecycle_settings.update',
        resourceType: 'platform_settings',
        resourceId: null,
        actorId: actorId ?? 'unknown',
        actorType: 'user',
        httpMethod: 'PATCH',
        httpPath: '/admin/settings/storage-lifecycle',
        httpStatus: 200,
        changes: { keys: changedKeys },
        ipAddress: request.ip ?? null,
      });
    } catch (err) {
      request.log.warn({ err }, 'audit log write failed for storage-lifecycle settings update');
    }

    return success(await getRedactedStorageLifecycleSettings(app.db));
  });
}
