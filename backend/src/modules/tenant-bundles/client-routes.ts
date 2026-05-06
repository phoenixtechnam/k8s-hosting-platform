/**
 * Client-panel self-service routes for Tenant Backup (Tier-3).
 *
 * Mounted at /api/v1/client/backups — gated by `requirePanel('client')`
 * + `requireClientAccess()`. Each route resolves the client from the
 * JWT's clientId claim; there is no `:clientId` URL param to spoof.
 *
 * Endpoints:
 *   GET  /api/v1/client/backups/bundles
 *        List the authenticated client's bundles (BundleSummary[]).
 *   GET  /api/v1/client/backups/bundles/:id
 *        Detail + components for a bundle the client owns.
 *   GET  /api/v1/client/backups/bundles/:id/data-export
 *        Stream the GDPR data-export ciphertext (attachment).
 *   GET  /api/v1/client/backups/schedule
 *        Get the client's schedule row (or null).
 *   PUT  /api/v1/client/backups/schedule
 *        Upsert the schedule — plan cap on retentionDays enforced.
 *
 * The admin-side counterparts under /api/v1/admin/* still exist for
 * platform-staff use; this file is the customer-facing slice.
 */

import type { FastifyInstance } from 'fastify';
import { eq, desc, and } from 'drizzle-orm';
import { authenticate, requirePanel, requireClientAccess } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import {
  backupJobs,
  backupComponents,
  backupConfigurations,
  clients,
  hostingPlans,
  clientBackupSchedules,
} from '../../db/schema.js';
import {
  updateClientBackupScheduleSchema,
  type BundleSummary,
  type BundleDetail,
  type BackupComponentInfo,
} from '@k8s-hosting/api-contracts';
import { S3BackupStore } from './s3-backup-store.js';
import { SshBackupStore } from './ssh-backup-store.js';
import type { BackupStore } from './bundle-store.js';
import { decrypt } from '../oidc/crypto.js';

export async function backupsV2ClientRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requirePanel('client'));
  // Defence-in-depth: even though every handler reads the clientId
  // from the JWT (never the URL params) and filters DB queries by
  // it, requireClientAccess gives a second enforcement layer so a
  // future handler that forgets the WHERE clause can't leak across
  // tenants. The middleware is a no-op for these handlers (no
  // :clientId params) but rejects malformed client-panel tokens.
  app.addHook('onRequest', requireClientAccess());

  // Resolve the client from the JWT — every route shares this.
  function clientIdFromRequest(request: { user?: { clientId?: string } }): string {
    const cid = request.user?.clientId;
    if (!cid) throw new ApiError('CLIENT_ACCESS_DENIED', 'Client-panel token missing clientId', 403);
    return cid;
  }

  // ── GET /api/v1/client/backups/bundles ─────────────────────────────
  app.get('/client/backups/bundles', {
    schema: { tags: ['TenantBundles-Client'], summary: 'List my bundles', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const clientId = clientIdFromRequest(request);
    const rows = await app.db.select().from(backupJobs)
      .where(eq(backupJobs.clientId, clientId))
      .orderBy(desc(backupJobs.createdAt))
      .limit(100);
    return success({ data: rows.map(toBundleSummary) });
  });

  // ── GET /api/v1/client/backups/bundles/:id ─────────────────────────
  app.get('/client/backups/bundles/:id', {
    schema: { tags: ['TenantBundles-Client'], summary: 'My bundle detail', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const clientId = clientIdFromRequest(request);
    const { id } = request.params as { id: string };
    const [job] = await app.db.select().from(backupJobs)
      .where(and(eq(backupJobs.id, id), eq(backupJobs.clientId, clientId)))
      .limit(1);
    if (!job) throw new ApiError('NOT_FOUND', 'Bundle not found', 404);
    const components = await app.db.select().from(backupComponents).where(eq(backupComponents.backupJobId, id));
    const detail: BundleDetail = {
      ...toBundleSummary(job),
      components: components.map(toComponentInfo),
    };
    return success(detail);
  });

  // ── GET /api/v1/client/backups/bundles/:id/data-export ─────────────
  app.get('/client/backups/bundles/:id/data-export', {
    schema: { tags: ['TenantBundles-Client'], summary: 'Download my GDPR data-export ciphertext', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const clientId = clientIdFromRequest(request);
    const { id } = request.params as { id: string };
    const [job] = await app.db.select().from(backupJobs)
      .where(and(eq(backupJobs.id, id), eq(backupJobs.clientId, clientId)))
      .limit(1);
    if (!job) throw new ApiError('NOT_FOUND', 'Bundle not found', 404);
    if (job.exportMode !== 'data_export' || !job.exportArtifact) {
      throw new ApiError('NO_DATA_EXPORT', 'This bundle has no data_export artifact.', 400);
    }
    if (!job.targetConfigId) {
      throw new ApiError('CONFIG_INVALID', 'Bundle has no target_config_id', 400);
    }
    const store = await resolveStore(app, job.targetConfigId);
    const handle = await store.open(id);
    if (!handle) throw new ApiError('NOT_FOUND', 'Bundle artefacts not found on remote target', 404);
    const m = job.exportArtifact.match(/^components\/(files|mailboxes|config|secrets)\/(.+)$/);
    if (!m) throw new ApiError('CONFIG_INVALID', `Malformed export_artifact path '${job.exportArtifact}'`, 400);
    const [, component, artifactName] = m as unknown as [string, 'files' | 'mailboxes' | 'config' | 'secrets', string];
    const stat = await store.stat(handle, component, artifactName);
    if (!stat) throw new ApiError('NOT_FOUND', `Export artifact missing on remote target`, 404);
    const body = await store.readComponent(handle, component, artifactName);
    reply.header('Content-Type', 'application/octet-stream');
    if (Number.isFinite(stat.sizeBytes) && stat.sizeBytes >= 0) {
      reply.header('Content-Length', String(stat.sizeBytes));
    }
    reply.header('Content-Disposition', `attachment; filename="data-export-${id}.tar.gz.enc"`);
    reply.header('Cache-Control', 'no-store');
    return reply.send(body);
  });

  // ── GET /api/v1/client/backups/schedule ────────────────────────────
  app.get('/client/backups/schedule', {
    schema: { tags: ['TenantBundles-Client'], summary: 'My backup schedule', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const clientId = clientIdFromRequest(request);
    const [row] = await app.db.select().from(clientBackupSchedules)
      .where(eq(clientBackupSchedules.clientId, clientId)).limit(1);
    if (!row) return success(null);
    return success({
      clientId: row.clientId,
      enabled: row.enabled,
      frequency: row.frequency,
      hourOfDayUtc: row.hourOfDayUtc,
      dayOfWeek: row.dayOfWeek,
      dayOfMonth: row.dayOfMonth,
      retentionDays: row.retentionDays,
      lastRunAt: row.lastRunAt ? row.lastRunAt.toISOString() : null,
      lastRunStatus: row.lastRunStatus,
    });
  });

  // ── PUT /api/v1/client/backups/schedule ────────────────────────────
  app.put('/client/backups/schedule', {
    schema: { tags: ['TenantBundles-Client'], summary: 'Upsert my backup schedule', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const clientId = clientIdFromRequest(request);
    const parsed = updateClientBackupScheduleSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; '), 400);
    }
    const [client] = await app.db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
    if (!client) throw new ApiError('NOT_FOUND', 'Client not found', 404);
    const [plan] = await app.db.select({
      defaultDays: hostingPlans.defaultBackupRetentionDays,
      maxDays: hostingPlans.maxBackupRetentionDays,
    }).from(hostingPlans).where(eq(hostingPlans.id, client.planId)).limit(1);
    if (!plan) throw new ApiError('CONFIG_INVALID', 'Client has no resolvable plan', 400);
    const requestedRetention = parsed.data.retentionDays ?? plan.defaultDays;
    if (requestedRetention > plan.maxDays) {
      throw new ApiError(
        'VALIDATION_ERROR',
        `retentionDays ${requestedRetention} exceeds your plan's max_backup_retention_days (${plan.maxDays})`,
        400,
      );
    }
    const existing = await app.db.select().from(clientBackupSchedules)
      .where(eq(clientBackupSchedules.clientId, clientId)).limit(1);
    if (existing.length === 0) {
      await app.db.insert(clientBackupSchedules).values({
        clientId,
        enabled: parsed.data.enabled ?? false,
        frequency: parsed.data.frequency ?? 'weekly',
        hourOfDayUtc: parsed.data.hourOfDayUtc ?? 3,
        dayOfWeek: parsed.data.dayOfWeek ?? null,
        dayOfMonth: parsed.data.dayOfMonth ?? null,
        retentionDays: requestedRetention,
      });
    } else {
      await app.db.update(clientBackupSchedules).set({
        enabled: parsed.data.enabled ?? existing[0]!.enabled,
        frequency: parsed.data.frequency ?? existing[0]!.frequency,
        hourOfDayUtc: parsed.data.hourOfDayUtc ?? existing[0]!.hourOfDayUtc,
        dayOfWeek: parsed.data.dayOfWeek === undefined ? existing[0]!.dayOfWeek : parsed.data.dayOfWeek,
        dayOfMonth: parsed.data.dayOfMonth === undefined ? existing[0]!.dayOfMonth : parsed.data.dayOfMonth,
        retentionDays: requestedRetention,
      }).where(eq(clientBackupSchedules.clientId, clientId));
    }
    const [refreshed] = await app.db.select().from(clientBackupSchedules)
      .where(eq(clientBackupSchedules.clientId, clientId)).limit(1);
    return success({
      clientId: refreshed!.clientId,
      enabled: refreshed!.enabled,
      frequency: refreshed!.frequency,
      hourOfDayUtc: refreshed!.hourOfDayUtc,
      dayOfWeek: refreshed!.dayOfWeek,
      dayOfMonth: refreshed!.dayOfMonth,
      retentionDays: refreshed!.retentionDays,
      lastRunAt: refreshed!.lastRunAt ? refreshed!.lastRunAt.toISOString() : null,
      lastRunStatus: refreshed!.lastRunStatus,
    });
  });
}

// ── helpers ───────────────────────────────────────────────────────────

function toBundleSummary(j: typeof backupJobs.$inferSelect): BundleSummary {
  return {
    id: j.id,
    clientId: j.clientId,
    initiator: j.initiator,
    systemTrigger: j.systemTrigger,
    status: j.status,
    targetKind: j.targetKind,
    targetUri: j.targetUri,
    targetConfigId: j.targetConfigId,
    label: j.label,
    description: j.description,
    sizeBytes: Number(j.sizeBytes),
    retentionDays: j.retentionDays,
    expiresAt: j.expiresAt ? j.expiresAt.toISOString() : null,
    exportMode: j.exportMode,
    exportArtifact: j.exportArtifact,
    startedAt: j.startedAt ? j.startedAt.toISOString() : null,
    finishedAt: j.finishedAt ? j.finishedAt.toISOString() : null,
    lastError: j.lastError,
    createdAt: j.createdAt.toISOString(),
    updatedAt: j.updatedAt.toISOString(),
  };
}

function toComponentInfo(c: typeof backupComponents.$inferSelect): BackupComponentInfo {
  return {
    id: c.id,
    component: c.component,
    artifactName: c.artifactName ?? '',
    status: c.status,
    sizeBytes: Number(c.sizeBytes),
    sha256: c.sha256,
    startedAt: c.startedAt ? c.startedAt.toISOString() : null,
    finishedAt: c.finishedAt ? c.finishedAt.toISOString() : null,
    lastError: c.lastError,
  };
}

async function resolveStore(app: FastifyInstance, targetConfigId: string): Promise<BackupStore> {
  const [cfg] = await app.db.select().from(backupConfigurations).where(eq(backupConfigurations.id, targetConfigId)).limit(1);
  if (!cfg) throw new ApiError('NOT_FOUND', 'Backup target not found', 404);
  const configuredKey = (app.config as Record<string, unknown>).OIDC_ENCRYPTION_KEY as string | undefined
    ?? process.env.OIDC_ENCRYPTION_KEY;
  if (!configuredKey && process.env.NODE_ENV === 'production') {
    throw new ApiError('CONFIG_INVALID', 'OIDC_ENCRYPTION_KEY is not configured', 500);
  }
  if (!configuredKey) {
    // Match the admin-side warn-log so operators see the zero-key
    // fallback path on staging the same way they see it on the
    // admin route. Without this, a staging-only reproduction is
    // silent in the client-panel path.
    app.log.warn('tenant-bundles client: OIDC_ENCRYPTION_KEY not set — using zero-key dev fallback. Decrypted credentials are trivially recoverable in this environment.');
  }
  const encKey = configuredKey ?? '0'.repeat(64);
  if (cfg.storageType === 's3') {
    let accessKey = '';
    let secretKey = '';
    try {
      accessKey = cfg.s3AccessKeyEncrypted ? decrypt(cfg.s3AccessKeyEncrypted, encKey) : '';
      secretKey = cfg.s3SecretKeyEncrypted ? decrypt(cfg.s3SecretKeyEncrypted, encKey) : '';
    } catch (err) {
      app.log.error({ err, configId: cfg.id }, 'tenant-bundles client: S3 credential decryption failed');
      throw new ApiError('CONFIG_INVALID', 'S3 credential decryption failed', 500);
    }
    if (!accessKey || !secretKey) throw new ApiError('CONFIG_INVALID', 'S3 credentials missing', 400);
    return new S3BackupStore({
      bucket: cfg.s3Bucket ?? '',
      region: cfg.s3Region ?? 'us-east-1',
      endpoint: cfg.s3Endpoint ?? undefined,
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
      pathPrefix: cfg.s3Prefix ?? undefined,
    });
  }
  if (cfg.storageType === 'ssh') {
    if (!cfg.sshHost || !cfg.sshUser || !cfg.sshKeyEncrypted || !cfg.sshPath) {
      throw new ApiError('CONFIG_INVALID', `SSH target ${cfg.id} missing fields`, 400);
    }
    let privateKey = '';
    try {
      privateKey = decrypt(cfg.sshKeyEncrypted, encKey);
    } catch (err) {
      app.log.error({ err, configId: cfg.id }, 'tenant-bundles client: SSH key decryption failed');
      throw new ApiError('CONFIG_INVALID', 'SSH key decryption failed', 500);
    }
    return new SshBackupStore({
      host: cfg.sshHost,
      port: cfg.sshPort ?? 22,
      user: cfg.sshUser,
      privateKey,
      basePath: cfg.sshPath,
      logFn: (level, ctx, msg) => app.log[level](ctx, msg),
    });
  }
  throw new ApiError('NOT_IMPLEMENTED', `Store kind '${cfg.storageType}' not supported`, 501);
}
