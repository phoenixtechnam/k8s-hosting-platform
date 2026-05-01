import type { FastifyInstance } from 'fastify';
import { eq, desc, sql } from 'drizzle-orm';
import { authenticate, requireRole, requirePanel } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { createK8sClients, type K8sClients } from '../k8s-provisioner/k8s-client.js';
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
import { decrypt } from '../oidc/crypto.js';

// Bundles share the same hostPath as `/snapshots` (mounted at /snapshots
// in the platform-api Deployment, backed by /var/lib/platform/snapshots
// on the node). Keeping them as a sibling subdir avoids a new
// volumeMount and keeps Phase 2 a code-only deploy. Phase 3 may move to
// a dedicated PVC-backed location.
//
// The pod runs as uid 1000 but the hostPath root is root:0755, so the
// store delegates the parent-dir create to a one-shot root-Job (see
// hostpath-job.ts). hostpathRoot/mountPath here must match what the
// platform-api Deployment mounts.
const PLATFORM_BUNDLES_INPOD_ROOT = '/snapshots/_bundles_v2';
const PLATFORM_BUNDLES_HOSTPATH = '/var/lib/platform/snapshots/_bundles_v2';
const PLATFORM_SNAPSHOTS_HOSTPATH_ROOT = '/var/lib/platform/snapshots';
const PLATFORM_SNAPSHOTS_MOUNT_PATH = '/snapshots';

export async function backupsV2Routes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requirePanel('admin'));
  app.addHook('onRequest', requireRole('super_admin', 'admin'));

  const platformVersion = (app.config as Record<string, unknown>).PLATFORM_VERSION as string | undefined ?? '0.0.0-dev';
  const configuredKey = (app.config as Record<string, unknown>).OIDC_ENCRYPTION_KEY as string | undefined
    ?? process.env.OIDC_ENCRYPTION_KEY;
  const secretsKeyHex = configuredKey ?? '0'.repeat(64);
  if (!configuredKey && process.env.NODE_ENV === 'production') {
    app.log.error('backups-v2: OIDC_ENCRYPTION_KEY is not set in production — using zero-key fallback. Secrets-component bundles encrypted today are trivially decryptable. Set OIDC_ENCRYPTION_KEY now.');
  } else if (!configuredKey) {
    app.log.warn('backups-v2: OIDC_ENCRYPTION_KEY not set — using zero-key dev fallback. Secrets bundles produced now will be unencrypted.');
  }

  // ── GET /api/v1/admin/backups/bundles ──────────────────────────────
  app.get('/admin/backups/bundles', {
    schema: { tags: ['BackupsV2'], summary: 'List bundles', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const q = request.query as { clientId?: string; limit?: string; status?: string };
    const limit = Math.min(Math.max(parseInt(q.limit ?? '50', 10) || 50, 1), 100);

    const whereClause = q.clientId ? eq(backupJobs.clientId, q.clientId) : undefined;
    const rowsQuery = whereClause
      ? app.db.select().from(backupJobs).where(whereClause).orderBy(desc(backupJobs.createdAt)).limit(limit + 1)
      : app.db.select().from(backupJobs).orderBy(desc(backupJobs.createdAt)).limit(limit + 1);
    const countQuery = whereClause
      ? app.db.select({ n: sql<number>`count(*)::int` }).from(backupJobs).where(whereClause)
      : app.db.select({ n: sql<number>`count(*)::int` }).from(backupJobs);
    const [rows, countRows] = await Promise.all([rowsQuery, countQuery]);

    const hasMore = rows.length > limit;
    const items: BundleSummary[] = rows.slice(0, limit).map(toBundleSummary);
    const total = countRows[0]?.n ?? items.length;
    return success({
      data: items,
      pagination: {
        total_count: total,
        cursor: hasMore ? items[items.length - 1]?.id ?? null : null,
        has_more: hasMore,
        page_size: limit,
      },
    });
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
      // The Job needs the *node* path so its hostPath volume sees the
      // same files the platform-api pod sees through /snapshots.
      // Phase 3 will swap to a PVC-backed mount and unify the paths.
      { db: app.db, k8s, store, platformVersion, secretsKeyHex, hostpathRoot: PLATFORM_BUNDLES_HOSTPATH },
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
    // Production wiring: pass the K8s client so the store can spawn a
    // root-Job to chmod the parent dir on first use. K8s client is
    // best-effort — if the in-cluster config isn't loadable (vitest
    // runs), the store falls back to skipping the Job which is fine
    // for tmpdirs.
    let k8s: K8sClients | undefined;
    try {
      const kc = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
      k8s = createK8sClients(kc);
    } catch (err) {
      app.log.warn({ err }, 'backups-v2: k8s client unavailable for hostpath init Job');
      k8s = undefined;
    }
    return new LocalHostPathBackupStore({
      inPodRoot: PLATFORM_BUNDLES_INPOD_ROOT,
      hostpathRoot: PLATFORM_SNAPSHOTS_HOSTPATH_ROOT,
      mountPath: PLATFORM_SNAPSHOTS_MOUNT_PATH,
      k8s,
      logFn: (level, ctx, msg) => app.log[level](ctx, msg),
    });
  }
  const [cfg] = await app.db.select().from(backupConfigurations).where(eq(backupConfigurations.id, targetConfigId)).limit(1);
  if (!cfg) throw new ApiError('NOT_FOUND', 'Backup target not found', 404);
  if (cfg.storageType !== 's3') {
    throw new ApiError('NOT_IMPLEMENTED', `Backup store kind '${cfg.storageType}' is not yet wired in backups-v2`, 501);
  }
  // Decrypt the S3 access keys using the platform-wide OIDC_ENCRYPTION_KEY.
  // Same key the backup-config module uses to encrypt them at write time.
  const encKey = (app.config as Record<string, unknown>).OIDC_ENCRYPTION_KEY as string | undefined
    ?? process.env.OIDC_ENCRYPTION_KEY
    ?? '0'.repeat(64);
  // Decrypt with a sanitised error wrapper — the underlying decrypt()
  // can throw OpenSSL strings that include ciphertext fragments, and
  // those would otherwise leak through Fastify's default 500 handler
  // into the response body.
  let accessKey = '';
  let secretKey = '';
  try {
    accessKey = cfg.s3AccessKeyEncrypted ? decrypt(cfg.s3AccessKeyEncrypted, encKey) : '';
    secretKey = cfg.s3SecretKeyEncrypted ? decrypt(cfg.s3SecretKeyEncrypted, encKey) : '';
  } catch (err) {
    app.log.error({ err, configId: cfg.id }, 'backups-v2: S3 credential decryption failed');
    throw new ApiError('CONFIG_INVALID', 'S3 credential decryption failed (encryption key may have rotated)', 500);
  }
  if (!accessKey || !secretKey) {
    throw new ApiError('CONFIG_INVALID', `Backup target ${cfg.id} has no S3 credentials configured`, 400);
  }
  return new S3BackupStore({
    bucket: cfg.s3Bucket ?? '',
    region: cfg.s3Region ?? 'us-east-1',
    endpoint: cfg.s3Endpoint ?? undefined,
    accessKeyId: accessKey,
    secretAccessKey: secretKey,
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
