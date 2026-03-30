import type { FastifyInstance } from 'fastify';
import { eq, and, inArray, desc } from 'drizzle-orm';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import {
  applicationInstances,
  applicationVersions,
  applicationUpgrades,
} from '../../db/schema.js';
import {
  validateUpgradeRequest,
  getAvailableUpgradesForInstance,
  createUpgradeRecord,
} from './service.js';
import {
  triggerUpgradeSchema,
  batchUpgradeSchema,
} from '@k8s-hosting/api-contracts';

const ACTIVE_STATUSES = [
  'pending', 'backing_up', 'pre_check', 'upgrading', 'health_check', 'rolling_back',
] as const;

export async function applicationUpgradeRoutes(app: FastifyInstance): Promise<void> {
  // ─── POST /api/v1/admin/application-instances/:id/upgrade ────────────────

  app.post('/admin/application-instances/:id/upgrade', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
    schema: {
      tags: ['Application Upgrades'],
      summary: 'Trigger an upgrade for an application instance',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = triggerUpgradeSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', parsed.error.errors[0].message, 400);
    }

    const { toVersion } = parsed.data;

    // Fetch instance
    const [instance] = await app.db
      .select()
      .from(applicationInstances)
      .where(eq(applicationInstances.id, id));

    if (!instance) {
      throw new ApiError('INSTANCE_NOT_FOUND', `Application instance '${id}' not found`, 404);
    }

    // Fetch versions for this app
    const versions = await app.db
      .select()
      .from(applicationVersions)
      .where(eq(applicationVersions.applicationCatalogId, instance.applicationCatalogId));

    // Fetch active upgrades
    const activeUpgrades = await app.db
      .select({ id: applicationUpgrades.id, status: applicationUpgrades.status })
      .from(applicationUpgrades)
      .where(
        and(
          eq(applicationUpgrades.instanceId, id),
          inArray(applicationUpgrades.status, [...ACTIVE_STATUSES]),
        ),
      );

    // Validate
    const validation = validateUpgradeRequest(instance, toVersion, versions, activeUpgrades);
    if (!validation.valid) {
      throw new ApiError('UPGRADE_VALIDATION_FAILED', validation.error!, 409);
    }

    // Create upgrade record
    const record = createUpgradeRecord({
      instanceId: id,
      fromVersion: instance.installedVersion!,
      toVersion,
      triggeredBy: ((request as Record<string, unknown>).user as { id?: string } | undefined)?.id ?? 'unknown',
      triggerType: 'manual',
    });

    await app.db.insert(applicationUpgrades).values(record);

    // Set target version on instance
    await app.db
      .update(applicationInstances)
      .set({ targetVersion: toVersion })
      .where(eq(applicationInstances.id, id));

    reply.status(201).send(success(record));
  });

  // ─── POST /api/v1/admin/application-upgrades/batch ───────────────────────

  app.post('/admin/application-upgrades/batch', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
    schema: {
      tags: ['Application Upgrades'],
      summary: 'Trigger batch upgrades for multiple instances',
      security: [{ bearerAuth: [] }],
    },
  }, async (request, reply) => {
    const parsed = batchUpgradeSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', parsed.error.errors[0].message, 400);
    }

    const { instanceIds, toVersion } = parsed.data;
    const userId = ((request as Record<string, unknown>).user as { id?: string } | undefined)?.id ?? 'unknown';
    const results: { instanceId: string; upgradeId?: string; error?: string }[] = [];

    for (const instanceId of instanceIds) {
      const [instance] = await app.db
        .select()
        .from(applicationInstances)
        .where(eq(applicationInstances.id, instanceId));

      if (!instance) {
        results.push({ instanceId, error: 'Instance not found' });
        continue;
      }

      const versions = await app.db
        .select()
        .from(applicationVersions)
        .where(eq(applicationVersions.applicationCatalogId, instance.applicationCatalogId));

      const activeUpgrades = await app.db
        .select({ id: applicationUpgrades.id, status: applicationUpgrades.status })
        .from(applicationUpgrades)
        .where(
          and(
            eq(applicationUpgrades.instanceId, instanceId),
            inArray(applicationUpgrades.status, [...ACTIVE_STATUSES]),
          ),
        );

      const validation = validateUpgradeRequest(instance, toVersion, versions, activeUpgrades);
      if (!validation.valid) {
        results.push({ instanceId, error: validation.error });
        continue;
      }

      const record = createUpgradeRecord({
        instanceId,
        fromVersion: instance.installedVersion!,
        toVersion,
        triggeredBy: userId,
        triggerType: 'batch',
      });

      await app.db.insert(applicationUpgrades).values(record);
      await app.db
        .update(applicationInstances)
        .set({ targetVersion: toVersion })
        .where(eq(applicationInstances.id, instanceId));

      results.push({ instanceId, upgradeId: record.id });
    }

    reply.status(201).send(success(results));
  });

  // ─── GET /api/v1/admin/application-upgrades ──────────────────────────────

  app.get('/admin/application-upgrades', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
    schema: {
      tags: ['Application Upgrades'],
      summary: 'List all upgrade jobs',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          instanceId: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
        },
      },
    },
  }, async (request) => {
    const query = request.query as { status?: string; instanceId?: string; limit?: number };
    const limit = query.limit ?? 50;

    let q = app.db
      .select()
      .from(applicationUpgrades)
      .orderBy(desc(applicationUpgrades.createdAt))
      .limit(limit);

    if (query.instanceId) {
      q = q.where(eq(applicationUpgrades.instanceId, query.instanceId)) as typeof q;
    }

    const rows = await q;
    return success(rows);
  });

  // ─── GET /api/v1/admin/application-upgrades/:id ──────────────────────────

  app.get('/admin/application-upgrades/:id', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
    schema: {
      tags: ['Application Upgrades'],
      summary: 'Get upgrade job detail',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const [upgrade] = await app.db
      .select()
      .from(applicationUpgrades)
      .where(eq(applicationUpgrades.id, id));

    if (!upgrade) {
      throw new ApiError('UPGRADE_NOT_FOUND', `Upgrade '${id}' not found`, 404);
    }

    return success(upgrade);
  });

  // ─── POST /api/v1/admin/application-upgrades/:id/rollback ────────────────

  app.post('/admin/application-upgrades/:id/rollback', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
    schema: {
      tags: ['Application Upgrades'],
      summary: 'Manually trigger rollback for a failed upgrade',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const [upgrade] = await app.db
      .select()
      .from(applicationUpgrades)
      .where(eq(applicationUpgrades.id, id));

    if (!upgrade) {
      throw new ApiError('UPGRADE_NOT_FOUND', `Upgrade '${id}' not found`, 404);
    }

    if (upgrade.status !== 'failed') {
      throw new ApiError(
        'ROLLBACK_NOT_ALLOWED',
        `Can only rollback failed upgrades (current: ${upgrade.status})`,
        409,
      );
    }

    await app.db
      .update(applicationUpgrades)
      .set({
        status: 'rolling_back',
        statusMessage: 'Manual rollback triggered',
        progressPct: 80,
      })
      .where(eq(applicationUpgrades.id, id));

    const [updated] = await app.db
      .select()
      .from(applicationUpgrades)
      .where(eq(applicationUpgrades.id, id));

    return success(updated);
  });

  // ─── GET /api/v1/admin/application-instances/:id/available-upgrades ──────

  app.get('/admin/application-instances/:id/available-upgrades', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
    schema: {
      tags: ['Application Upgrades'],
      summary: 'List available upgrade versions for an instance',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };

    const [instance] = await app.db
      .select()
      .from(applicationInstances)
      .where(eq(applicationInstances.id, id));

    if (!instance) {
      throw new ApiError('INSTANCE_NOT_FOUND', `Application instance '${id}' not found`, 404);
    }

    const versions = await app.db
      .select()
      .from(applicationVersions)
      .where(eq(applicationVersions.applicationCatalogId, instance.applicationCatalogId));

    const available = getAvailableUpgradesForInstance(instance.installedVersion, versions);

    return success(available.map(v => ({
      version: v.version,
      isDefault: v.isDefault,
      breakingChanges: v.breakingChanges,
      migrationNotes: v.migrationNotes,
      envChanges: v.envChanges,
      minResources: v.minResources,
    })));
  });

  // ─── GET /api/v1/admin/application-upgrades/:id/progress (SSE) ───────────

  app.get('/admin/application-upgrades/:id/progress', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
    schema: {
      tags: ['Application Upgrades'],
      summary: 'Stream upgrade progress via Server-Sent Events',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const TERMINAL_STATUSES = new Set(['completed', 'failed', 'rolled_back']);
    let closed = false;

    request.raw.on('close', () => {
      closed = true;
    });

    // Poll every 2 seconds until terminal state or client disconnect
    const poll = async () => {
      while (!closed) {
        const [upgrade] = await app.db
          .select()
          .from(applicationUpgrades)
          .where(eq(applicationUpgrades.id, id));

        if (!upgrade) {
          reply.raw.write(`data: ${JSON.stringify({ error: 'Upgrade not found' })}\n\n`);
          reply.raw.end();
          return;
        }

        const event = {
          id: upgrade.id,
          status: upgrade.status,
          progressPct: upgrade.progressPct,
          statusMessage: upgrade.statusMessage,
          errorMessage: upgrade.errorMessage,
        };

        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);

        if (TERMINAL_STATUSES.has(upgrade.status)) {
          reply.raw.end();
          return;
        }

        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    };

    poll().catch(() => {
      if (!closed) reply.raw.end();
    });
  });
}
