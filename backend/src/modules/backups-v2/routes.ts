import type { FastifyInstance } from 'fastify';
import { eq, desc, sql } from 'drizzle-orm';
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
import { S3BackupStore } from './s3-backup-store.js';
import { SshBackupStore } from './ssh-backup-store.js';
import type { BackupStore } from './bundle-store.js';
import { runBundle } from './orchestrator.js';
import { decrypt } from '../oidc/crypto.js';
import { decryptSecretsPayload } from './components/secrets.js';
import { createHash } from 'node:crypto';
import { gunzip } from 'node:zlib';
import type { Readable } from 'node:stream';

// Backups-v2 stores bundles OFF-CLUSTER only (S3 / SSH). The cluster's
// disk is reserved for live tenant data — backups must never compete
// for it. Every bundle request therefore requires `targetConfigId`
// pointing at an active row in `backup_configurations`.
//
// (LocalHostPathBackupStore still exists for unit tests via mkdtemp;
// it is never used by the route layer in production.)

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

    // Backups MUST go to an off-cluster target. The cluster's disk is
    // for live tenant data, not bundles. Reject any request without
    // an explicit targetConfigId.
    if (!input.targetConfigId) {
      throw new ApiError('VALIDATION_ERROR',
        'targetConfigId is required: bundles must be written to an active off-site backup target (S3 or SSH).',
        400);
    }
    const store = await resolveStore(app, input.targetConfigId);

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

    const targetUri = `${store.kind}://${input.targetConfigId}`;

    // Internal cluster URL the files-component Job uses to POST
    // archive + tree uploads back to platform-api. Falls back to the
    // standard k8s service DNS when not explicitly configured.
    const platformApiUrl = (app.config as Record<string, unknown>).PLATFORM_API_INTERNAL_URL as string | undefined
      ?? process.env.PLATFORM_API_INTERNAL_URL
      ?? 'http://platform-api.platform.svc:3000';

    const result = await runBundle(
      { db: app.db, k8s, store, platformVersion, secretsKeyHex, platformApiUrl },
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
          // files + mailboxes are deferred to Phase 3 (cross-namespace
          // PVC + Stalwart export wiring). Default to false so a request
          // that omits `components` doesn't get a misleading `partial`
          // status. Callers wanting an explicit Phase-3 attempt can
          // still set them to true and watch the orchestrator surface
          // the deferred-component error.
          files: input.components?.files ?? false,
          mailboxes: input.components?.mailboxes ?? false,
          config: input.components?.config ?? true,
          secrets: input.components?.secrets ?? (input.exportMode !== 'data_export'),
        },
      },
    );

    reply.status(201).send(success({ bundleId: result.bundleId, status: result.status, meta: result.meta }));
  });

  // ── POST /api/v1/admin/backups/bundles/:id/verify ──────────────────
  //
  // Read every component artifact back from the off-site target,
  // decrypt secrets, decompress config, and report:
  //   - meta.json schemaVersion + initiator + timestamps
  //   - per-component byte count + SHA-256 (computed live, no sidecar)
  //   - secrets KID + decrypt success + count of TLS Secrets
  //   - config JSON parse success + per-table row counts
  //
  // Operators run this from the admin panel after a backup to confirm
  // the bytes left the pod and round-trip cleanly. No DB writes; safe
  // to run any number of times.
  app.post('/admin/backups/bundles/:id/verify', {
    schema: { tags: ['BackupsV2'], summary: 'Verify a bundle round-trip', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const [job] = await app.db.select().from(backupJobs).where(eq(backupJobs.id, id)).limit(1);
    if (!job) throw new ApiError('NOT_FOUND', 'Bundle not found', 404);
    if (!job.targetConfigId) {
      throw new ApiError('CONFIG_INVALID', 'Bundle has no target_config_id (pre-D-redesign row); cannot verify.', 400);
    }
    const store = await resolveStore(app, job.targetConfigId, { requireActive: false });
    const handle = await store.open(id);
    if (!handle) throw new ApiError('NOT_FOUND', 'Bundle artefacts not found on remote target', 404);

    // meta.json
    const meta = await store.getMeta(handle);

    const components: Record<string, unknown> = {};

    // files component — Phase 3 deferred, listed here so the operator
    // sees that the verifier is aware of it.
    if (meta.components.files) {
      const stat = await store.stat(handle, 'files', 'archive.tar.gz').catch(() => null);
      components.files = { reachable: !!stat, sizeBytes: stat?.sizeBytes ?? 0 };
    }

    // config component — gunzip + JSON.parse + count rows per table
    if (meta.components.config) {
      const stream = await store.readComponent(handle, 'config', 'db-rows.json.gz');
      const buf = await streamToBuffer(stream);
      const sha256 = createHash('sha256').update(buf).digest('hex');
      const rowCounts: Record<string, number> = {};
      let parseError: string | null = null;
      try {
        const decompressed = await new Promise<Buffer>((resolve, reject) => {
          gunzip(buf, (err, out) => (err ? reject(err) : resolve(out)));
        });
        const dump = JSON.parse(decompressed.toString('utf8'));
        for (const [table, rows] of Object.entries(dump.tables ?? {})) {
          rowCounts[table] = Array.isArray(rows) ? rows.length : 0;
        }
      } catch (err) {
        parseError = (err as Error).message;
      }
      components.config = {
        sizeBytes: buf.length,
        sha256,
        rowCounts,
        parseError,
      };
    }

    // secrets component — decrypt with k1 + JSON.parse
    if (meta.components.secrets) {
      const stream = await store.readComponent(handle, 'secrets', 'tls.json.gz.enc');
      const buf = await streamToBuffer(stream);
      const sha256 = createHash('sha256').update(buf).digest('hex');
      let secretCount = 0;
      let decryptError: string | null = null;
      try {
        const plaintext = decryptSecretsPayload(buf.toString('utf8'), secretsKeyHex);
        const decompressed = await new Promise<Buffer>((resolve, reject) => {
          gunzip(plaintext, (err, out) => (err ? reject(err) : resolve(out)));
        });
        const dump = JSON.parse(decompressed.toString('utf8'));
        secretCount = Array.isArray(dump.secrets) ? dump.secrets.length : 0;
      } catch (err) {
        decryptError = (err as Error).message;
      }
      components.secrets = {
        sizeBytes: buf.length,
        sha256,
        encryptionKeyId: meta.components.secrets.encryptionKeyId,
        secretCount,
        decryptError,
      };
    }

    return success({
      bundleId: id,
      meta: {
        schemaVersion: meta.schemaVersion,
        capturedAt: meta.capturedAt,
        platformVersion: meta.platformVersion,
        initiator: meta.initiator,
        retentionDays: meta.retentionDays,
        expiresAt: meta.expiresAt,
      },
      components,
    });
  });

  // ── DELETE /api/v1/admin/backups/bundles/:id ───────────────────────
  app.delete('/admin/backups/bundles/:id', {
    schema: { tags: ['BackupsV2'], summary: 'Delete a bundle (also from store)', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const [job] = await app.db.select().from(backupJobs).where(eq(backupJobs.id, id)).limit(1);
    if (!job) throw new ApiError('NOT_FOUND', 'Bundle not found', 404);
    // Best-effort remote delete: only attempt if the bundle has an
    // off-site target configured. (Older rows could have null
    // targetConfigId from the pre-D-redesign world; for those we
    // just drop the DB row.)
    if (job.targetConfigId) {
      const store = await resolveStore(app, job.targetConfigId, { requireActive: false });
      const handle = await store.open(id);
      if (handle) await store.delete(handle);
    }
    await app.db.delete(backupJobs).where(eq(backupJobs.id, id));
    reply.status(204).send();
  });
}

async function resolveStore(
  app: FastifyInstance,
  targetConfigId: string,
  opts: { requireActive: boolean } = { requireActive: true },
): Promise<BackupStore> {
  const [cfg] = await app.db.select().from(backupConfigurations).where(eq(backupConfigurations.id, targetConfigId)).limit(1);
  if (!cfg) throw new ApiError('NOT_FOUND', 'Backup target not found', 404);
  // Inactive targets must not accept NEW writes — an operator may have
  // taken the target out of service (rotated keys, decommissioning).
  // DELETE callers pass requireActive=false so cleanup of existing
  // bundles on a deactivated target still works.
  if (opts.requireActive && !cfg.active) {
    throw new ApiError('CONFIG_INVALID',
      `Backup target ${cfg.id} is not active. Activate it via Admin → Backup Settings before writing bundles.`,
      400);
  }

  const encKey = (app.config as Record<string, unknown>).OIDC_ENCRYPTION_KEY as string | undefined
    ?? process.env.OIDC_ENCRYPTION_KEY
    ?? '0'.repeat(64);

  if (cfg.storageType === 's3') {
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

  if (cfg.storageType === 'ssh') {
    if (!cfg.sshHost || !cfg.sshUser || !cfg.sshKeyEncrypted || !cfg.sshPath) {
      throw new ApiError('CONFIG_INVALID',
        `Backup target ${cfg.id} is missing SSH host/user/key/path`, 400);
    }
    let privateKey = '';
    try {
      privateKey = decrypt(cfg.sshKeyEncrypted, encKey);
    } catch (err) {
      app.log.error({ err, configId: cfg.id }, 'backups-v2: SSH key decryption failed');
      throw new ApiError('CONFIG_INVALID', 'SSH key decryption failed (encryption key may have rotated)', 500);
    }
    if (!privateKey) {
      throw new ApiError('CONFIG_INVALID', `Backup target ${cfg.id} has empty SSH key`, 400);
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

  throw new ApiError('NOT_IMPLEMENTED',
    `Backup store kind '${cfg.storageType}' is not supported`, 501);
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
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
