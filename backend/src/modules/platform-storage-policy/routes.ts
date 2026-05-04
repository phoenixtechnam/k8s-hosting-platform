import type { FastifyInstance, FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
import { authenticate, requireRole, requirePanel, type JwtPayload } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { updatePlatformStoragePolicySchema } from '@k8s-hosting/api-contracts';
import { auditLogs, notifications, users } from '../../db/schema.js';
import { inArray } from 'drizzle-orm';
import { getPolicy, setPolicy, readClusterState, applyPolicy } from './service.js';
import { readClusterCapacity } from './capacity-reconciler.js';

export async function platformStoragePolicyRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requirePanel('admin'));
  // GET requires admin or super_admin — read-only state.
  // PATCH narrows to super_admin ONLY (per-handler check below); the
  // mutation drops/adds Longhorn replicas which is irreversible for
  // the data on the removed-replica nodes.
  app.addHook('onRequest', requireRole('super_admin', 'admin'));

  // GET /api/v1/admin/platform-storage-policy
  // GET /api/v1/admin/cluster-capacity
  // Per-node Longhorn commitPct + cluster aggregate. Drives the
  // top-of-page capacity banner in admin panel ("Storage at 92% —
  // provisioning may fail"). Same data the capacity-reconciler tick
  // uses to decide warning/critical notifications.
  app.get('/admin/cluster-capacity', {
    schema: {
      tags: ['PlatformStoragePolicy'],
      summary: 'Per-node Longhorn capacity (storageScheduled vs effective max) for the operator banner',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kubeconfigPath);
    return success(await readClusterCapacity(k8s));
  });

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
    // JWT payload exposes the subject (user UUID) on `sub`, not `id` —
    // earlier code read `id` and silently fell through to null, so
    // `last_applied_by` was always NULL. The audit_logs row has its own
    // actor_id column populated below; this fixes the row-level field.
    const user = req.user as JwtPayload | undefined;
    const actorId = user?.sub ?? null;
    const before = await getPolicy(app.db);
    const updated = await setPolicy(app.db, input.systemTier, input.pinnedByAdmin ?? true, actorId);
    const outcome = await applyPolicy(k8s, app.db);

    // Audit trail: lastAppliedBy on the row is reset on every change,
    // so push a permanent record into audit_logs that includes the
    // before/after tiers and the per-resource patch outcomes.
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
        volumes: outcome.volumes.map((p) => ({ volume: p.volumeName, prev: p.previousReplicas, next: p.newReplicas, ok: p.patched })),
        deployments: outcome.deployments.map((d) => ({ name: d.name, prev: d.previousReplicas, next: d.newReplicas, ok: d.patched })),
        cnpgClusters: outcome.cnpgClusters.map((c) => ({ name: c.name, prev: c.previousInstances, next: c.newInstances, ok: c.patched })),
      },
      httpMethod: 'PATCH',
      httpPath: '/api/v1/admin/platform-storage-policy',
      httpStatus: 200,
    } as typeof auditLogs.$inferInsert).catch((err) => {
      // Don't fail the operator's request because audit insert failed —
      // log so it surfaces in observability and move on.
      app.log.warn({ err }, 'platform-storage-policy: audit log insert failed');
    });

    // Admin-notification fan-out so Apply HA outcomes show up in the
    // bell icon (durable history of every storage-policy change). The
    // operator's UI shows the in-flight result; the notification is
    // for OTHER admins + post-hoc audit. Failures here are non-fatal.
    try {
      const failed = [
        ...outcome.volumes.filter((v) => !v.patched && v.error),
        ...outcome.deployments.filter((d) => !d.patched && d.error),
        ...outcome.cnpgClusters.filter((c) => !c.patched && c.error),
      ];
      const isInsufficientStorage = outcome.cnpgClusters.some((c) => c.error?.startsWith('INSUFFICIENT_STORAGE'));
      const title = failed.length === 0
        ? `Platform storage tier set to ${updated.systemTier}`
        : isInsufficientStorage
          ? `Platform storage Apply ${updated.systemTier} blocked — insufficient capacity`
          : `Platform storage Apply ${updated.systemTier} completed with ${failed.length} failure(s)`;
      const lines: string[] = [];
      lines.push(`Volumes: ${outcome.volumes.filter((v) => v.patched).length} patched, ${outcome.volumes.filter((v) => !v.patched && !v.error).length} no-op, ${outcome.volumes.filter((v) => v.error).length} failed.`);
      lines.push(`Deployments: ${outcome.deployments.filter((d) => d.patched).length} patched, ${outcome.deployments.filter((d) => !d.patched && !d.error).length} no-op, ${outcome.deployments.filter((d) => d.error).length} failed.`);
      lines.push(`CNPG clusters: ${outcome.cnpgClusters.filter((c) => c.patched).length} patched, ${outcome.cnpgClusters.filter((c) => !c.patched && !c.error).length} no-op, ${outcome.cnpgClusters.filter((c) => c.error).length} failed.`);
      for (const f of failed.slice(0, 5)) {
        if ('volumeName' in f) lines.push(`  ✗ vol ${f.volumeName}: ${f.error}`);
        else if ('previousInstances' in f) lines.push(`  ✗ cluster ${f.namespace}/${f.name}: ${f.error}`);
        else lines.push(`  ✗ deploy ${f.namespace}/${f.name}: ${f.error}`);
      }
      const adminRows = await app.db.select({ id: users.id }).from(users).where(inArray(users.roleName, ['super_admin', 'admin']));
      for (const a of adminRows) {
        await app.db.insert(notifications).values({
          id: crypto.randomUUID(),
          userId: a.id,
          type: failed.length === 0 ? 'info' : (isInsufficientStorage ? 'error' : 'warning'),
          title,
          message: lines.join(' '),
          resourceType: 'platform_storage_policy',
          resourceId: 'singleton',
        }).catch(() => undefined);
      }
    } catch (err) {
      app.log.warn({ err }, 'platform-storage-policy: notification fan-out failed');
    }

    return success({
      policy: {
        systemTier: updated.systemTier,
        pinnedByAdmin: updated.pinnedByAdmin,
        lastAppliedAt: updated.lastAppliedAt?.toISOString() ?? null,
        lastAppliedBy: updated.lastAppliedBy ?? null,
        updatedAt: updated.updatedAt.toISOString(),
      },
      // Field name preserved (frontend expects "patches") — contains
      // Longhorn volume patch results. New sibling fields surface
      // the additional patch outcomes for stateless Deployments and
      // the CNPG Cluster.
      patches: outcome.volumes,
      deployments: outcome.deployments,
      cnpgClusters: outcome.cnpgClusters,
    });
  });
}
