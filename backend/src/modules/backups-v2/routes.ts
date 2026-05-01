import type { FastifyInstance } from 'fastify';
import { eq, desc } from 'drizzle-orm';
import { authenticate, requireRole, requirePanel } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { backupJobs, backupComponents, backupConfigurations, clients } from '../../db/schema.js';
import {
  createBundleSchema,
  type BundleSummary,
  type BundleDetail,
  type BackupComponentInfo,
} from '@k8s-hosting/api-contracts';
import { LocalHostPathBackupStore } from './local-hostpath-backup-store.js';
import { S3BackupStore } from './s3-backup-store.js';
import type { BackupStore } from './bundle-store.js';
import { runBundle } from './orchestrator.js';

const PLATFORM_BUNDLES_HOSTPATH = '/var/lib/platform/bundles';

export async function backupsV2Routes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requirePanel('admin'));
  app.addHook('onRequest', requireRole('super_admin', 'admin'));

  const platformVersion = (app.config as Record<string, unknown>).PLATFORM_VERSION as string | undefined ?? '0.0.0-dev';
  const secretsKeyHex = (app.config as Record<string, unknown>).OIDC_ENCRYPTION_KEY as string | undefined
    ?? process.env.OIDC_ENCRYPTION_KEY
    ?? '0'.repeat(64); /* dev-only fallback */

  // ── GET /api/v1/admin/backups/bundles ──────────────────────────────
  app.get('/admin/backups/bundles', {
    schema: { tags: ['BackupsV2'], summary: 'List bundles', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const q = request.query as { clientId?: string; limit?: string; status?: string };
    const limit = Math.min(Math.max(parseInt(q.limit ?? '50', 10) || 50, 1), 100);

    let rows;
    if (q.clientId) {
      rows = await app.db
        .select()
        .from(backupJobs)
        .where(eq(backupJobs.clientId, q.clientId))
        .orderBy(desc(backupJobs.createdAt))
        .limit(limit);
    } else {
      rows = await app.db
        .select()
        .from(backupJobs)
        .orderBy(desc(backupJobs.createdAt))
        .limit(limit);
    }

    const items: BundleSummary[] = rows.map(toBundleSummary);
    return success({ data: items, pagination: { total_count: items.length, cursor: null, has_more: false, page_size: limit } });
  });

  // ── GET /api/v1/admin/backups/bundles/:id ──────────────────────────
  app.get('/admin/backups/bundles/:id', {
    schema: { tags: ['BackupsV2'], summary: 'Get bundle detail', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const [job] = await app.db.select().from(backupJobs).where(eq(backupJobs.id, id)).limit(1);
    if (!job) throw new ApiError('NOT_FOUND', 'Bundle not found', 404);
    const components = await app.db.select().from(backupComponents).where(eq(backupComponents.backupJobId, id));
    const detail: BundleDetail = {
      ...toBundleSummary(job),
      components: components.map(toComponentInfo),
    };
    return success(detail);
  });

  // ── POST /api/v1/admin/backups/bundles ─────────────────────────────
  app.post('/admin/backups/bundles', {
    schema: { tags: ['BackupsV2'], summary: 'Create a new bundle', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const parsed = createBundleSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; '), 400);
    }
    const input = parsed.data;

    // Resolve the BackupStore from the chosen target.
    const store = await resolveStore(app, input.targetConfigId ?? null);

    // Resolve client + plan retention.
    const [client] = await app.db.select().from(clients).where(eq(clients.id, input.clientId)).limit(1);
    if (!client) throw new ApiError('NOT_FOUND', 'Client not found', 404);

    const retentionDays = input.retentionDays ?? 30;

    // Build kube clients best-effort — orchestrator handles undefined.
    let k8s;
    try {
      const kc = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
      k8s = createK8sClients(kc);
    } catch (err) {
      app.log.warn({ err }, 'backups-v2: k8s client unavailable');
      k8s = undefined;
    }

    const targetUri = store.kind === 'hostpath'
      ? `hostpath://${PLATFORM_BUNDLES_HOSTPATH}`
      : `${store.kind}://${input.targetConfigId ?? 'unknown'}`;

    const result = await runBundle(
      { db: app.db, k8s, store, platformVersion, secretsKeyHex },
      {
        clientId: input.clientId,
        initiator: input.initiator,
        systemTrigger: input.systemTrigger ?? null,
        label: input.label ?? null,
        description: input.description ?? null,
        retentionDays,
        targetConfigId: input.targetConfigId ?? null,
        targetUri,
        components: {
          files: input.components?.files ?? true,
          mailboxes: input.components?.mailboxes ?? true,
          config: input.components?.config ?? true,
          secrets: input.components?.secrets ?? (input.exportMode !== 'data_export'),
        },
      },
    );

    reply.status(201).send(success({ bundleId: result.bundleId, status: result.status, meta: result.meta }));
  });

  // ── DELETE /api/v1/admin/backups/bundles/:id ───────────────────────
  app.delete('/admin/backups/bundles/:id', {
    schema: { tags: ['BackupsV2'], summary: 'Delete a bundle (also from store)', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const [job] = await app.db.select().from(backupJobs).where(eq(backupJobs.id, id)).limit(1);
    if (!job) throw new ApiError('NOT_FOUND', 'Bundle not found', 404);
    const store = await resolveStore(app, job.targetConfigId);
    const handle = await store.open(id);
    if (handle) await store.delete(handle);
    await app.db.delete(backupJobs).where(eq(backupJobs.id, id));
    reply.status(204).send();
  });
}

async function resolveStore(app: FastifyInstance, targetConfigId: string | null): Promise<BackupStore> {
  if (!targetConfigId) {
    return new LocalHostPathBackupStore(PLATFORM_BUNDLES_HOSTPATH);
  }
  const [cfg] = await app.db.select().from(backupConfigurations).where(eq(backupConfigurations.id, targetConfigId)).limit(1);
  if (!cfg) throw new ApiError('NOT_FOUND', 'Backup target not found', 404);
  if (cfg.storageType !== 's3') {
    throw new ApiError('NOT_IMPLEMENTED', `Backup store kind '${cfg.storageType}' is not yet wired in backups-v2`, 501);
  }
  // Pull access keys from the encrypted column. We re-use backup-config's
  // decryption helper.
  const { decryptConfig } = await import('../backup-config/service.js') as unknown as {
    decryptConfig?: (cfg: unknown, key: string) => { accessKey?: string; secretKey?: string };
  };
  const encKey = (app.config as Record<string, unknown>).OIDC_ENCRYPTION_KEY as string | undefined
    ?? process.env.OIDC_ENCRYPTION_KEY
    ?? '0'.repeat(64);
  const decoded = decryptConfig ? decryptConfig(cfg, encKey) : {};
  return new S3BackupStore({
    bucket: cfg.s3Bucket ?? '',
    region: cfg.s3Region ?? 'us-east-1',
    endpoint: cfg.s3Endpoint ?? undefined,
    accessKeyId: decoded.accessKey ?? '',
    secretAccessKey: decoded.secretKey ?? '',
    pathPrefix: cfg.s3Prefix ?? undefined,
  });
}

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
    artifactName: c.artifactName,
    status: c.status,
    sizeBytes: Number(c.sizeBytes),
    sha256: c.sha256,
    startedAt: c.startedAt ? c.startedAt.toISOString() : null,
    finishedAt: c.finishedAt ? c.finishedAt.toISOString() : null,
    lastError: c.lastError,
  };
}
