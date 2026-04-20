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

  // ─── Resize ──────────────────────────────────────────────────────────

  app.post('/admin/clients/:clientId/storage/resize/dry-run', {
    onRequest: adminGate,
    schema: {
      tags: ['Storage Lifecycle'],
      summary: 'Estimate a resize without mutating anything',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };
    const parsed = resizeSchema.safeParse(request.body);
    if (!parsed.success) throw new ApiError('VALIDATION_ERROR', parsed.error.errors[0].message, 400);
    const mib = parsed.data.newMib ?? (parsed.data.newGi! * 1024);
    const result = await service.resizeDryRunMib(await ctx(), clientId, mib);
    return success(result);
  });

  app.post('/admin/clients/:clientId/storage/resize', {
    onRequest: adminGate,
    schema: {
      tags: ['Storage Lifecycle'],
      summary: 'Resize a client PVC (shrink supported via snapshot+recreate)',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };
    const parsed = resizeSchema.safeParse(request.body);
    if (!parsed.success) throw new ApiError('VALIDATION_ERROR', parsed.error.errors[0].message, 400);
    const userId = ((request.user as { id?: string } | undefined)?.id) ?? null;
    const mib = parsed.data.newMib ?? (parsed.data.newGi! * 1024);
    const { operationId } = await service.resizeClient(await ctx(), clientId, {
      newMib: mib,
      triggeredByUserId: userId,
    });
    return success({ operationId });
  });

  // ─── Manual snapshot ────────────────────────────────────────────────

  app.post('/admin/clients/:clientId/storage/snapshot', {
    onRequest: adminGate,
    schema: {
      tags: ['Storage Lifecycle'],
      summary: 'Take an ad-hoc snapshot of a client PVC',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };
    const parsed = snapshotSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ApiError('VALIDATION_ERROR', parsed.error.errors[0].message, 400);
    const userId = ((request.user as { id?: string } | undefined)?.id) ?? null;
    const snap = await service.snapshotClient(await ctx(), clientId, {
      label: parsed.data.label,
      retentionDays: parsed.data.retentionDays,
      triggeredByUserId: userId,
    });
    return success(snap);
  });

  app.get('/admin/clients/:clientId/storage/snapshots', {
    onRequest: adminGate,
    schema: { tags: ['Storage Lifecycle'], summary: 'List snapshots for a client', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };
    return success(await service.listSnapshotsForClient(app.db, clientId));
  });

  app.delete('/admin/storage/snapshots/:snapshotId', {
    onRequest: adminGate,
    schema: { tags: ['Storage Lifecycle'], summary: 'Delete a snapshot (removes archive + DB row)', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { snapshotId } = request.params as { snapshotId: string };
    await service.deleteSnapshot(await ctx(), snapshotId);
    return success({ deleted: snapshotId });
  });

  // ─── Suspend / Resume ───────────────────────────────────────────────

  app.post('/admin/clients/:clientId/storage/suspend', {
    onRequest: adminGate,
    schema: { tags: ['Storage Lifecycle'], summary: 'Suspend a client — scale workloads to 0, preserve PVC', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };
    const userId = ((request.user as { id?: string } | undefined)?.id) ?? null;
    return success(await service.suspendClient(await ctx(), clientId, { triggeredByUserId: userId }));
  });

  app.post('/admin/clients/:clientId/storage/resume', {
    onRequest: adminGate,
    schema: { tags: ['Storage Lifecycle'], summary: 'Resume a suspended client — restore workloads to prior replica counts', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };
    const userId = ((request.user as { id?: string } | undefined)?.id) ?? null;
    return success(await service.resumeClient(await ctx(), clientId, { triggeredByUserId: userId }));
  });

  // ─── Archive / Restore ──────────────────────────────────────────────

  app.post('/admin/clients/:clientId/storage/archive', {
    onRequest: adminGate,
    schema: { tags: ['Storage Lifecycle'], summary: 'Archive a client — final snapshot + delete PVC/workloads', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };
    const parsed = archiveSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ApiError('VALIDATION_ERROR', parsed.error.errors[0].message, 400);
    const userId = ((request.user as { id?: string } | undefined)?.id) ?? null;
    return success(await service.archiveClient(await ctx(), clientId, {
      retentionDays: parsed.data.retentionDays,
      triggeredByUserId: userId,
    }));
  });

  app.post('/admin/clients/:clientId/storage/restore', {
    onRequest: adminGate,
    schema: { tags: ['Storage Lifecycle'], summary: 'Restore an archived client from its pre-archive snapshot', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };
    const parsed = restoreSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ApiError('VALIDATION_ERROR', parsed.error.errors[0].message, 400);
    const userId = ((request.user as { id?: string } | undefined)?.id) ?? null;
    return success(await service.restoreArchivedClient(await ctx(), clientId, {
      newGi: parsed.data.newGi,
      triggeredByUserId: userId,
    }));
  });

  // ─── Operations + audit ─────────────────────────────────────────────

  app.get('/admin/clients/:clientId/storage/operations', {
    onRequest: adminGate,
    schema: { tags: ['Storage Lifecycle'], summary: 'List recent storage operations for a client', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };
    return success(await service.listOperationsForClient(app.db, clientId));
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

  // ─── Operator recovery ──────────────────────────────────────────────
  //
  // When an op fails partway through (e.g. PVC delete times out), the
  // client is stuck in state='failed' and any subsequent ops return 409.
  // This endpoint is the safety valve — admin resets the state back to
  // 'idle' so the next op can proceed. The failed operation's DB row is
  // NOT removed so the original error is still auditable.

  app.post('/admin/clients/:clientId/storage/clear-failed', {
    onRequest: adminGate,
    schema: {
      tags: ['Storage Lifecycle'],
      summary: "Force-clear a client's stuck 'failed' storage state back to idle",
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };
    return success(await service.clearFailedStorageState(app.db, clientId));
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
      throw new ApiError('VALIDATION_ERROR', parsed.error.errors[0].message, 400, {
        field: parsed.error.errors[0].path.join('.'),
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
        clientId: null,
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
