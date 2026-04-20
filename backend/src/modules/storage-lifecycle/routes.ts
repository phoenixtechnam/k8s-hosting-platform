import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { getSnapshotStore } from './snapshot-store.js';
import * as service from './service.js';

const resizeSchema = z.object({
  newGi: z.number().int().min(1).max(1000),
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

  function ctx() {
    const kcfg = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kcfg);
    const store = getSnapshotStore(app.config as Record<string, unknown>);
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
    const result = await service.resizeDryRun(ctx(), clientId, parsed.data.newGi);
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
    const { operationId } = await service.resizeClient(ctx(), clientId, {
      newGi: parsed.data.newGi,
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
    const snap = await service.snapshotClient(ctx(), clientId, {
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
    await service.deleteSnapshot(ctx(), snapshotId);
    return success({ deleted: snapshotId });
  });

  // ─── Suspend / Resume ───────────────────────────────────────────────

  app.post('/admin/clients/:clientId/storage/suspend', {
    onRequest: adminGate,
    schema: { tags: ['Storage Lifecycle'], summary: 'Suspend a client — scale workloads to 0, preserve PVC', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };
    const userId = ((request.user as { id?: string } | undefined)?.id) ?? null;
    return success(await service.suspendClient(ctx(), clientId, { triggeredByUserId: userId }));
  });

  app.post('/admin/clients/:clientId/storage/resume', {
    onRequest: adminGate,
    schema: { tags: ['Storage Lifecycle'], summary: 'Resume a suspended client — restore workloads to prior replica counts', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };
    const userId = ((request.user as { id?: string } | undefined)?.id) ?? null;
    return success(await service.resumeClient(ctx(), clientId, { triggeredByUserId: userId }));
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
    return success(await service.archiveClient(ctx(), clientId, {
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
    return success(await service.restoreArchivedClient(ctx(), clientId, {
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
    return success(await service.storageAuditReport(ctx()));
  });
}
