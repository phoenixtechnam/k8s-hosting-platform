import type { FastifyInstance, FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
import { authenticate, requireRole, requirePanel } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { updatePlatformStoragePolicySchema } from '@k8s-hosting/api-contracts';
import { auditLogs } from '../../db/schema.js';
import { getPolicy, setPolicy, readClusterState, applyPolicy } from './service.js';

export async function platformStoragePolicyRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requirePanel('admin'));
  // GET requires admin or super_admin — read-only state.
  // PATCH narrows to super_admin ONLY (per-handler check below); the
  // mutation drops/adds Longhorn replicas which is irreversible for
  // the data on the removed-replica nodes.
  app.addHook('onRequest', requireRole('super_admin', 'admin'));

  // GET /api/v1/admin/platform-storage-policy
  // Returns the current policy + observed cluster state
  // (server count, recommended tier, per-volume replica facts).
  app.get('/admin/platform-storage-policy', {
    schema: {
      tags: ['PlatformStoragePolicy'],
      summary: 'Current platform-storage policy + cluster state',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kubeconfigPath);
    const policy = await getPolicy(app.db);
    const clusterState = await readClusterState(k8s, app.db);
    return success({
      policy: {
        systemTier: policy.systemTier,
        pinnedByAdmin: policy.pinnedByAdmin,
        lastAppliedAt: policy.lastAppliedAt?.toISOString() ?? null,
        lastAppliedBy: policy.lastAppliedBy ?? null,
        updatedAt: policy.updatedAt.toISOString(),
      },
      clusterState,
    });
  });

  // PATCH /api/v1/admin/platform-storage-policy
  // Operator confirms the new tier and the reconciler immediately
  // patches Longhorn Volume CRs. Replica add/remove happens
  // asynchronously inside Longhorn after the patch returns.
  app.patch('/admin/platform-storage-policy', {
    onRequest: requireRole('super_admin'),  // narrower than the plugin-wide hook
    schema: {
      tags: ['PlatformStoragePolicy'],
      summary: 'Set platform-storage tier + apply Longhorn replica changes',
      security: [{ bearerAuth: [] }],
    },
  }, async (req: FastifyRequest) => {
    const input = updatePlatformStoragePolicySchema.parse(req.body);
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kubeconfigPath);
    const user = req.user as { id?: string } | undefined;
    const actorId = user?.id ?? null;
    const before = await getPolicy(app.db);
    const updated = await setPolicy(app.db, input.systemTier, input.pinnedByAdmin ?? true, actorId);
    const patches = await applyPolicy(k8s, app.db);

    // Audit trail: lastAppliedBy on the row is reset on every change,
    // so push a permanent record into audit_logs that includes the
    // before/after tiers and the per-volume patch outcome.
    await app.db.insert(auditLogs).values({
      id: crypto.randomUUID(),
      actorId,
      actorType: 'user',
      actionType: 'update',
      resourceType: 'platform_storage_policy',
      resourceId: 'singleton',
      changes: {
        before: { systemTier: before.systemTier, pinnedByAdmin: before.pinnedByAdmin },
        after: { systemTier: updated.systemTier, pinnedByAdmin: updated.pinnedByAdmin },
        patches: patches.map((p) => ({ volume: p.volumeName, prev: p.previousReplicas, next: p.newReplicas, ok: p.patched })),
      },
      httpMethod: 'PATCH',
      httpPath: '/api/v1/admin/platform-storage-policy',
      httpStatus: 200,
    } as typeof auditLogs.$inferInsert).catch((err) => {
      // Don't fail the operator's request because audit insert failed —
      // log so it surfaces in observability and move on.
      app.log.warn({ err }, 'platform-storage-policy: audit log insert failed');
    });

    return success({
      policy: {
        systemTier: updated.systemTier,
        pinnedByAdmin: updated.pinnedByAdmin,
        lastAppliedAt: updated.lastAppliedAt?.toISOString() ?? null,
        lastAppliedBy: updated.lastAppliedBy ?? null,
        updatedAt: updated.updatedAt.toISOString(),
      },
      patches,
    });
  });
}
