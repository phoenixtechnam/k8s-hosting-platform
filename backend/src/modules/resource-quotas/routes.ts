import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { authenticate, requireRole, requireClientAccess } from '../../middleware/auth.js';
import * as service from './service.js';
import { success } from '../../shared/response.js';
import { validateQuotaFitsHeadroom } from './headroom-gate.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { auditLogs, notifications, users } from '../../db/schema.js';
import { inArray } from 'drizzle-orm';

export async function resourceQuotaRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);

  // GET /api/v1/clients/:clientId/resource-quota — anyone authenticated can view
  app.get('/clients/:clientId/resource-quota', async (request) => {
    const { clientId } = request.params as { clientId: string };
    const quota = await service.getResourceQuota(app.db, clientId);
    return success(quota);
  });

  // GET /api/v1/clients/:clientId/resource-availability — authenticated + client access
  app.get('/clients/:clientId/resource-availability', {
    onRequest: [authenticate, requireClientAccess()],
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };
    const availability = await service.getClientResourceAvailability(app.db, clientId);
    return success(availability);
  });

  // PATCH /api/v1/clients/:clientId/resource-quota — admin only
  //
  // 2026-05-11 (Phase 2): cluster-failover-headroom gate. Before saving
  // the new limits, sum all tenant quota limits (across every client),
  // add the projected delta from this patch, and compare against
  // getClusterFailoverHeadroom().tenantAvailable{Cpu,MemoryGi}. If the
  // projection breaches single-failure survivability, return 409
  // CLUSTER_HEADROOM_EXCEEDED. A `?force=true` query param lets a
  // super_admin bypass the gate (e.g. capacity expansion in flight); both
  // accept and override paths emit audit-log entries.
  app.patch('/clients/:clientId/resource-quota', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
  }, async (request, reply) => {
    const { clientId } = request.params as { clientId: string };
    const input = request.body as Record<string, unknown>;
    const query = request.query as { force?: string };
    const force = query.force === 'true' || query.force === '1';
    const userSub = (request.user as { sub?: string; role?: string } | undefined)?.sub ?? 'system';
    const userRole = (request.user as { sub?: string; role?: string } | undefined)?.role ?? '';

    const newCpuLimit =
      typeof input.cpu_cores_limit === 'number' ? input.cpu_cores_limit : null;
    const newMemoryLimitGi =
      typeof input.memory_gb_limit === 'number' ? input.memory_gb_limit : null;

    // Only gate on CPU/memory changes — storage and bandwidth aren't
    // part of the failover-headroom computation. If the patch touches
    // only those fields, skip the headroom check.
    const gateApplies = newCpuLimit !== null || newMemoryLimitGi !== null;

    if (gateApplies) {
      const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
      const k8s = createK8sClients(kubeconfigPath);
      const gate = await validateQuotaFitsHeadroom(app.db, k8s, {
        clientId,
        newCpuLimit,
        newMemoryLimitGi,
      });

      if (!gate.allowed && !force) {
        await app.db.insert(auditLogs).values({
          id: crypto.randomUUID(),
          actorId: userSub,
          actorType: 'user',
          actionType: 'resource_quota.update.refused',
          resourceType: 'resource_quota',
          resourceId: clientId,
          changes: {
            reason: 'cluster_headroom_exceeded',
            attempt: { newCpuLimit, newMemoryLimitGi },
            details: gate.details,
          },
          httpStatus: 409,
        });
        return reply.code(409).send({
          error: {
            code: 'CLUSTER_HEADROOM_EXCEEDED',
            message: gate.reason,
            status: 409,
            details: gate.details,
            remediation:
              'Lower another tenant\'s quota first, add a server, or (super_admin only) retry with ?force=true to accept the failover risk.',
          },
        });
      }

      if (!gate.allowed && force) {
        // Force-override is super_admin-only. The PATCH is already
        // gated by requireRole('super_admin','admin') so an `admin`
        // could otherwise sneak through — block them here.
        if (userRole !== 'super_admin') {
          await app.db.insert(auditLogs).values({
            id: crypto.randomUUID(),
            actorId: userSub,
            actorType: 'user',
            actionType: 'resource_quota.update.force_denied',
            resourceType: 'resource_quota',
            resourceId: clientId,
            changes: { reason: 'force_requires_super_admin', userRole },
            httpStatus: 403,
          });
          return reply.code(403).send({
            error: {
              code: 'FORCE_REQUIRES_SUPER_ADMIN',
              message: 'force=true overrides the cluster failover headroom gate; only super_admin may use it.',
              status: 403,
            },
          });
        }
        // Allowed override — audit-log the deliberate breach.
        await app.db.insert(auditLogs).values({
          id: crypto.randomUUID(),
          actorId: userSub,
          actorType: 'user',
          actionType: 'resource_quota.update.force_override',
          resourceType: 'resource_quota',
          resourceId: clientId,
          changes: {
            reason: 'super_admin_override_cluster_headroom',
            patch: { newCpuLimit, newMemoryLimitGi },
            details: gate.details,
          },
          httpStatus: 200,
        });
        // Security-review follow-up (2026-05-11): an audit-log entry
        // alone is invisible to operators monitoring the bell icon. A
        // deliberate failover-survivability breach is at least as
        // significant as a storage-capacity warning — fan out a
        // warning-severity notification to all super_admin + admin
        // users so the operator team sees the override land.
        const adminRows = await app.db
          .select({ id: users.id })
          .from(users)
          .where(inArray(users.roleName, ['super_admin', 'admin']));
        const overage: string[] = [];
        if (gate.details.overByCpu > 0) overage.push(`CPU +${gate.details.overByCpu.toFixed(2)} cores`);
        if (gate.details.overByMemoryGi > 0) overage.push(`memory +${gate.details.overByMemoryGi.toFixed(2)} GiB`);
        const overageStr = overage.length > 0 ? overage.join(', ') : 'cluster headroom clamped';
        for (const a of adminRows) {
          await app.db.insert(notifications).values({
            id: crypto.randomUUID(),
            userId: a.id,
            type: 'warning',
            title: 'Tenant quota force-overrode cluster failover headroom',
            message: `super_admin "${userSub}" used ?force=true on client ${clientId} quota patch — ${overageStr} past safe headroom. Tenant total ${gate.details.projectedSumCpu.toFixed(2)} CPU / ${gate.details.projectedSumMemoryGi.toFixed(2)} GiB vs available ${gate.details.headroomCpu.toFixed(2)} CPU / ${gate.details.headroomMemoryGi.toFixed(2)} GiB. Cluster will NOT survive single-server loss until quotas come back inside headroom or a server is added.`,
            resourceType: 'resource_quota',
            resourceId: clientId,
          });
        }
      }
    }

    const updated = await service.updateResourceQuota(app.db, clientId, {
      cpu_cores_limit: input.cpu_cores_limit as number | undefined,
      memory_gb_limit: input.memory_gb_limit as number | undefined,
      storage_gb_limit: input.storage_gb_limit as number | undefined,
      bandwidth_gb_limit: input.bandwidth_gb_limit as number | undefined,
    });

    // Audit-log only when the patch actually carried at least one
    // changeable quota field — a no-op PATCH (empty body, or only fields
    // we don't recognise) shouldn't pollute the timeline. Storage and
    // bandwidth aren't gated but still count as real changes.
    const hasAnyField =
      input.cpu_cores_limit !== undefined ||
      input.memory_gb_limit !== undefined ||
      input.storage_gb_limit !== undefined ||
      input.bandwidth_gb_limit !== undefined;
    if (hasAnyField) {
      await app.db.insert(auditLogs).values({
        id: crypto.randomUUID(),
        actorId: userSub,
        actorType: 'user',
        actionType: 'resource_quota.update',
        resourceType: 'resource_quota',
        resourceId: clientId,
        changes: { patch: { newCpuLimit, newMemoryLimitGi } },
        httpStatus: 200,
      });
    }

    return success(updated);
  });
}
