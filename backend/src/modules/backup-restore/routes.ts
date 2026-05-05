/**
 * Restore-cart routes (ADR-034).
 *
 * Cart CRUD + bundle-browse + sequential executor. Operators add
 * typed items to a cart (files-paths, mailboxes-by-address,
 * deployments-by-id, domains-by-id, config-tables) and then
 * execute it.
 *
 * Phase 4.0 ships routes + bundle-browse + ONE executor wired
 * (config-tables — pure DB INSERT…ON CONFLICT, no external deps).
 * The other four executors are stubs that throw a clear
 * EXECUTOR_PHASE_4_PENDING error so a cart with those items marks
 * the item failed without taking down the rest of the cart.
 *
 * Auth: `authenticate + requirePanel('admin') + requireRole(...)`
 * — same pattern as backups-v2/routes.ts. The internal-download
 * endpoint (mirror of upload, used by Phase-4.x file/mailbox
 * executors) lives separately for HMAC-token auth.
 */

import type { FastifyInstance } from 'fastify';
import { eq, asc, sql, and } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { authenticate, requireRole, requirePanel } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import {
  restoreJobs,
  restoreItems,
  backupJobs,
  backupConfigurations,
  clients,
  type NewRestoreJob,
  type NewRestoreItem,
  type RestoreJob,
  type RestoreItem,
} from '../../db/schema.js';
import {
  createRestoreCartSchema,
  addRestoreItemSchema,
  type RestoreJobSummary,
  type RestoreJobDetail,
  type RestoreItemInfo,
  type RestoreItemType,
} from '@k8s-hosting/api-contracts';
import { decrypt } from '../oidc/crypto.js';
import { S3BackupStore } from '../backups-v2/s3-backup-store.js';
import { SshBackupStore } from '../backups-v2/ssh-backup-store.js';
import type { BackupStore } from '../backups-v2/bundle-store.js';
import { gunzipSync } from 'node:zlib';
import { execConfigTablesItem } from './executors/config-tables.js';
import { execDeploymentsByIdItem } from './executors/deployments-by-id.js';
import { execDomainsByIdItem } from './executors/domains-by-id.js';
import { execFilesPathsItem } from './executors/files-paths.js';
import { execMailboxesByAddressItem } from './executors/mailboxes-by-address.js';
import { snapshotClient } from '../storage-lifecycle/service.js';
import { resolveSnapshotStore } from '../storage-lifecycle/snapshot-store.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';

export async function backupRestoreRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requirePanel('admin'));
  app.addHook('onRequest', requireRole('super_admin', 'admin'));

  // ── POST /api/v1/admin/restores/carts ──────────────────────────────
  app.post('/admin/restores/carts', {
    schema: { tags: ['Restore'], summary: 'Create an empty restore cart', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const parsed = createRestoreCartSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; '), 400);
    }
    const input = parsed.data;
    const [client] = await app.db.select().from(clients).where(eq(clients.id, input.clientId)).limit(1);
    if (!client) throw new ApiError('NOT_FOUND', 'Client not found', 404);

    const initiatorUserId = (request as { user?: { sub?: string } }).user?.sub ?? null;
    const id = `rstr-${randomUUID()}`;
    const row: NewRestoreJob = {
      id,
      clientId: input.clientId,
      initiatorUserId,
      status: 'draft',
      description: input.description ?? null,
    };
    await app.db.insert(restoreJobs).values(row);
    reply.status(201).send(success({ id, clientId: input.clientId, status: 'draft' }));
  });

  // ── GET /api/v1/admin/restores/carts/:id ───────────────────────────
  app.get('/admin/restores/carts/:id', {
    schema: { tags: ['Restore'], summary: 'Get cart + items', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const [job] = await app.db.select().from(restoreJobs).where(eq(restoreJobs.id, id)).limit(1);
    if (!job) throw new ApiError('NOT_FOUND', 'Restore cart not found', 404);
    const items = await app.db.select().from(restoreItems)
      .where(eq(restoreItems.restoreJobId, id))
      .orderBy(asc(restoreItems.seq));
    const detail: RestoreJobDetail = {
      ...toJobSummary(job),
      items: items.map(toItemInfo),
    };
    return success(detail);
  });

  // ── POST /api/v1/admin/restores/carts/:id/items ────────────────────
  // Adds an item with seq = MAX(seq) + 1 inside a serializable
  // transaction so two concurrent adds can't collide on the unique
  // index.
  app.post('/admin/restores/carts/:id/items', {
    schema: { tags: ['Restore'], summary: 'Add an item to the cart', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const { id: cartId } = request.params as { id: string };
    const parsed = addRestoreItemSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; '), 400);
    }
    const input = parsed.data;
    const [job] = await app.db.select().from(restoreJobs).where(eq(restoreJobs.id, cartId)).limit(1);
    if (!job) throw new ApiError('NOT_FOUND', 'Restore cart not found', 404);
    if (job.status !== 'draft') {
      throw new ApiError('VALIDATION_ERROR', `Cannot add items to cart in status '${job.status}' (must be 'draft')`, 400);
    }
    // Verify the bundle exists.
    const [bundle] = await app.db.select().from(backupJobs).where(eq(backupJobs.id, input.bundleId)).limit(1);
    if (!bundle) throw new ApiError('NOT_FOUND', 'Bundle not found', 404);
    if (bundle.clientId !== job.clientId) {
      throw new ApiError('VALIDATION_ERROR', 'Bundle belongs to a different client than the cart', 400);
    }

    // Atomic next-seq insert via subquery. Postgres serialises this
    // by row-locking restoreJobs[id] FOR UPDATE.
    const itemId = randomUUID();
    const newRow: NewRestoreItem = {
      id: itemId,
      restoreJobId: cartId,
      bundleId: input.bundleId,
      type: input.type,
      selector: input.selector as Record<string, unknown>,
      label: input.label ?? null,
      // Filled by transaction below.
      seq: 0,
    };
    await app.db.transaction(async (tx) => {
      // Lock the parent row so concurrent adds serialise.
      await tx.execute(sql`SELECT id FROM restore_jobs WHERE id = ${cartId} FOR UPDATE`);
      const r = await tx.execute(sql`
        SELECT COALESCE(MAX(seq) + 1, 0) AS next_seq
        FROM restore_items WHERE restore_job_id = ${cartId}
      `) as unknown as { rows: { next_seq: number }[] };
      const nextSeq = Number(r.rows[0]?.next_seq ?? 0);
      await tx.insert(restoreItems).values({ ...newRow, seq: nextSeq });
    });
    const [item] = await app.db.select().from(restoreItems).where(eq(restoreItems.id, itemId)).limit(1);
    reply.status(201).send(success(toItemInfo(item!)));
  });

  // ── DELETE /api/v1/admin/restores/carts/:id/items/:itemId ──────────
  app.delete('/admin/restores/carts/:id/items/:itemId', {
    schema: { tags: ['Restore'], summary: 'Remove an item from the cart', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const { id: cartId, itemId } = request.params as { id: string; itemId: string };
    const [job] = await app.db.select().from(restoreJobs).where(eq(restoreJobs.id, cartId)).limit(1);
    if (!job) throw new ApiError('NOT_FOUND', 'Restore cart not found', 404);
    if (job.status !== 'draft') {
      throw new ApiError('VALIDATION_ERROR', `Cannot remove items from cart in status '${job.status}'`, 400);
    }
    await app.db.delete(restoreItems)
      .where(and(eq(restoreItems.restoreJobId, cartId), eq(restoreItems.id, itemId)));
    reply.status(204).send();
  });

  // ── POST /api/v1/admin/restores/carts/:id/execute ──────────────────
  // Executes pending items sequentially. Idempotent — already-done
  // items are skipped. Failures stop the cart at that item; operator
  // re-invokes /execute to retry from the failed item.
  app.post('/admin/restores/carts/:id/execute', {
    schema: { tags: ['Restore'], summary: 'Execute pending items sequentially', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const { id: cartId } = request.params as { id: string };
    // Atomic compare-and-swap: claim the cart by transitioning OUT of
    // any non-executing status into 'executing' in a single UPDATE …
    // WHERE … RETURNING. A concurrent second /execute hits the lock
    // and sees 0 rows updated → 409. Closes the TOCTOU gap that
    // would otherwise let two callers race-apply the same items.
    const claim = await app.db.execute(sql`
      UPDATE restore_jobs
      SET status = 'executing',
          started_at = COALESCE(started_at, now()),
          updated_at = now()
      WHERE id = ${cartId}
        AND status != 'executing'
      RETURNING id
    `) as unknown as { rows: Array<{ id: string }> };
    if (claim.rows.length === 0) {
      const [existing] = await app.db.select().from(restoreJobs).where(eq(restoreJobs.id, cartId)).limit(1);
      if (!existing) throw new ApiError('NOT_FOUND', 'Restore cart not found', 404);
      throw new ApiError('CONFLICT', 'Cart is already executing — wait for completion', 409);
    }
    const [job] = await app.db.select().from(restoreJobs).where(eq(restoreJobs.id, cartId)).limit(1);
    if (!job) throw new ApiError('NOT_FOUND', 'Restore cart vanished mid-claim', 404);

    const items = await app.db.select().from(restoreItems)
      .where(eq(restoreItems.restoreJobId, cartId))
      .orderBy(asc(restoreItems.seq));

    // Pre-restore snapshot (ADR-034 §2). Only relevant when at least
    // one item touches the tenant PVC (files-paths). For DB-only
    // restores (config-tables, deployments-by-id, domains-by-id) and
    // mail-namespace restores (mailboxes-by-address), there is no
    // convenient rollback target today; the operator's safety net is
    // a fresh capture bundle taken before the restore.
    //
    // Idempotent: skip if the cart already recorded a snapshot id
    // (operator retried /execute after a partial failure).
    if (!job.preRestoreSnapshotId && items.some((it) => it.status !== 'done' && it.type === 'files-paths')) {
      try {
        const k8s = (app as unknown as { k8s?: ReturnType<typeof createK8sClients> }).k8s
          ?? createK8sClients((app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined);
        const store = await resolveSnapshotStore(app.db, app.config as Record<string, unknown>);
        const platformNamespace = ((app.config as Record<string, unknown>).PLATFORM_NAMESPACE as string | undefined) ?? 'platform';
        const snap = await snapshotClient(
          { db: app.db, k8s, store, platformNamespace },
          job.clientId,
          { kind: 'pre-restore', label: `restore-cart ${cartId}`, retentionDays: 7 },
        );
        await app.db.update(restoreJobs)
          .set({ preRestoreSnapshotId: snap.id })
          .where(eq(restoreJobs.id, cartId));
        app.log.info({ cartId, snapshotId: snap.id, clientId: job.clientId }, 'tenant-backup-restore: pre-restore snapshot created');
      } catch (err) {
        // Snapshot failure is fatal for the cart — proceeding without
        // a rollback target on a files-paths item would violate the
        // ADR's safety guarantee. Mark the cart failed and surface a
        // clear error.
        app.log.error({ err, cartId, clientId: job.clientId }, 'tenant-backup-restore: pre-restore snapshot failed');
        await app.db.update(restoreJobs)
          .set({ status: 'failed', finishedAt: new Date(), lastError: 'PRE_RESTORE_SNAPSHOT_FAILED: see server logs' })
          .where(eq(restoreJobs.id, cartId));
        throw new ApiError('SNAPSHOT_FAILED', 'Pre-restore snapshot failed; cart aborted to preserve current state', 500);
      }
    }

    let firstFailureMsg: string | null = null;
    for (const item of items) {
      if (item.status === 'done' || item.status === 'skipped') continue;
      // Mark applying.
      await app.db.update(restoreItems)
        .set({ status: 'applying', startedAt: new Date(), lastError: null })
        .where(eq(restoreItems.id, item.id));
      try {
        const store = await resolveStoreForBundle(app, item.bundleId);
        await dispatchExecutor(app, item, store);
        await app.db.update(restoreItems)
          .set({ status: 'done', finishedAt: new Date() })
          .where(eq(restoreItems.id, item.id));
      } catch (err) {
        // Sanitise the executor error before persisting + returning.
        // Raw errors from S3/SSH/Drizzle can include hostnames, IPs,
        // bucket paths, or partial credential context. Only the
        // ApiError code (or a generic class label) goes into
        // last_error; the raw error stays in the server log.
        const apiErr = err as ApiError & { code?: string };
        const safeCode = (typeof apiErr.code === 'string' && apiErr.code.length <= 64) ? apiErr.code : 'EXECUTOR_FAILED';
        const safeMsg = `${safeCode}: restore item failed (see server logs)`;
        app.log.error({ err, itemId: item.id, type: item.type, cartId }, 'tenant-backup-restore: executor threw');
        await app.db.update(restoreItems)
          .set({ status: 'failed', finishedAt: new Date(), lastError: safeMsg })
          .where(eq(restoreItems.id, item.id));
        firstFailureMsg = `item ${item.id} (${item.type}): ${safeMsg}`;
        break;
      }
    }

    const finalStatus = firstFailureMsg ? 'failed' : 'done';
    await app.db.update(restoreJobs)
      .set({
        status: finalStatus,
        finishedAt: new Date(),
        lastError: firstFailureMsg,
      })
      .where(eq(restoreJobs.id, cartId));

    const [refreshed] = await app.db.select().from(restoreJobs).where(eq(restoreJobs.id, cartId)).limit(1);
    const refreshedItems = await app.db.select().from(restoreItems)
      .where(eq(restoreItems.restoreJobId, cartId))
      .orderBy(asc(restoreItems.seq));
    reply.send(success({
      ...toJobSummary(refreshed!),
      items: refreshedItems.map(toItemInfo),
    } satisfies RestoreJobDetail));
  });

  // ── DELETE /api/v1/admin/restores/carts/:id ────────────────────────
  app.delete('/admin/restores/carts/:id', {
    schema: { tags: ['Restore'], summary: 'Delete a draft cart', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const [job] = await app.db.select().from(restoreJobs).where(eq(restoreJobs.id, id)).limit(1);
    if (!job) throw new ApiError('NOT_FOUND', 'Restore cart not found', 404);
    if (job.status === 'executing') {
      throw new ApiError('VALIDATION_ERROR', 'Cannot delete an executing cart; wait for completion or pause first', 400);
    }
    await app.db.delete(restoreJobs).where(eq(restoreJobs.id, id));
    reply.status(204).send();
  });

  // ── GET /api/v1/admin/backups/bundles/:bundleId/browse/* ───────────
  // Bundle-browse routes — populate the cart UI's "what can I restore
  // from this bundle?" picker. Each call sources data from a single
  // bundle on the off-site target via BackupStore.readComponent +
  // parsing.

  app.get('/admin/backups/bundles/:bundleId/browse/config-tables', async (request) => {
    const { bundleId } = request.params as { bundleId: string };
    const dump = await readConfigDump(app, bundleId);
    const tables = Object.entries(dump.tables ?? {}).map(([name, rows]) => ({
      name,
      rowCount: Array.isArray(rows) ? rows.length : 0,
    }));
    return success({ bundleId, tables });
  });

  app.get('/admin/backups/bundles/:bundleId/browse/mailboxes', async (request) => {
    const { bundleId } = request.params as { bundleId: string };
    const job = await loadBundle(app, bundleId);
    const store = await resolveStoreForBundle(app, bundleId);
    const handle = await store.open(bundleId);
    if (!handle) throw new ApiError('NOT_FOUND', 'Bundle artefacts not found on remote target', 404);
    const refs = await store.listArtifacts(handle, 'mailboxes');
    const addresses = refs
      .map((r) => r.name.replace(/\.mbox\.tar\.gz$/, ''))
      .filter((s) => s.length > 0);
    void job;
    return success({ bundleId, addresses });
  });

  app.get('/admin/backups/bundles/:bundleId/browse/deployments', async (request) => {
    const { bundleId } = request.params as { bundleId: string };
    const dump = await readConfigDump(app, bundleId);
    const rows = (dump.tables?.deployments ?? []) as Array<{ id: string; name: string }>;
    return success({
      bundleId,
      deployments: rows.map((d) => ({ id: d.id, name: d.name })),
    });
  });

  app.get('/admin/backups/bundles/:bundleId/browse/domains', async (request) => {
    const { bundleId } = request.params as { bundleId: string };
    const dump = await readConfigDump(app, bundleId);
    const rows = (dump.tables?.domains ?? []) as Array<{ id: string; hostname: string }>;
    return success({
      bundleId,
      domains: rows.map((d) => ({ id: d.id, hostname: d.hostname })),
    });
  });

  app.get('/admin/backups/bundles/:bundleId/browse/files/tree', async (request) => {
    const { bundleId } = request.params as { bundleId: string };
    const q = request.query as { limit?: string; after?: string };
    const limit = Math.min(Math.max(parseInt(q.limit ?? '500', 10) || 500, 1), 2000);
    const after = q.after ?? '';
    const store = await resolveStoreForBundle(app, bundleId);
    const handle = await store.open(bundleId);
    if (!handle) throw new ApiError('NOT_FOUND', 'Bundle artefacts not found on remote target', 404);
    let tree: Buffer;
    try {
      const stream = await store.readComponent(handle, 'files', 'tree.jsonl.gz');
      const chunks: Buffer[] = [];
      for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      tree = gunzipSync(Buffer.concat(chunks));
    } catch (err) {
      throw new ApiError('NOT_FOUND', `tree.jsonl.gz not found in bundle (was files component captured?): ${(err as Error).message}`, 404);
    }
    // tree.jsonl.gz is produced by `find -printf` which is depth-
    // first, NOT lexicographically sorted by path. Pagination via
    // a `path > after` cursor only works on a sorted list — sort
    // here so two consecutive page calls return a stable, complete
    // result set with no skipped entries.
    const lines = tree.toString('utf8').split('\n').filter(Boolean);
    const allEntries: Array<{ path: string; size: number; mode: number; mtime: string }> = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as { path: string; size: number; mode: number; mtime: string };
        allEntries.push(obj);
      } catch { /* tolerate malformed lines */ }
    }
    allEntries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const totalCount = allEntries.length;
    // Lexicographic forward cursor on sorted entries.
    const startIdx = after
      ? (() => {
          // First index where path > after (binary search).
          let lo = 0, hi = allEntries.length;
          while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (allEntries[mid]!.path > after) hi = mid;
            else lo = mid + 1;
          }
          return lo;
        })()
      : 0;
    const endIdx = Math.min(startIdx + limit, allEntries.length);
    const entries = allEntries.slice(startIdx, endIdx);
    const nextCursor = endIdx < allEntries.length
      ? entries[entries.length - 1]?.path ?? null
      : null;
    return success({ bundleId, totalCount, entries, nextCursor });
  });
}

// ─── helpers ─────────────────────────────────────────────────────────

function toJobSummary(j: RestoreJob): RestoreJobSummary {
  return {
    id: j.id,
    clientId: j.clientId,
    initiatorUserId: j.initiatorUserId,
    status: j.status,
    preRestoreSnapshotId: j.preRestoreSnapshotId,
    description: j.description,
    startedAt: j.startedAt ? j.startedAt.toISOString() : null,
    finishedAt: j.finishedAt ? j.finishedAt.toISOString() : null,
    lastError: j.lastError,
    createdAt: j.createdAt.toISOString(),
    updatedAt: j.updatedAt.toISOString(),
  };
}

function toItemInfo(i: RestoreItem): RestoreItemInfo {
  return {
    id: i.id,
    restoreJobId: i.restoreJobId,
    bundleId: i.bundleId,
    type: i.type as RestoreItemType,
    selector: i.selector,
    label: i.label,
    seq: i.seq,
    status: i.status,
    progressMessage: i.progressMessage,
    sizeBytes: Number(i.sizeBytes),
    startedAt: i.startedAt ? i.startedAt.toISOString() : null,
    finishedAt: i.finishedAt ? i.finishedAt.toISOString() : null,
    lastError: i.lastError,
  };
}

async function loadBundle(app: FastifyInstance, bundleId: string) {
  const [job] = await app.db.select().from(backupJobs).where(eq(backupJobs.id, bundleId)).limit(1);
  if (!job) throw new ApiError('NOT_FOUND', 'Bundle not found', 404);
  if (!job.targetConfigId) {
    throw new ApiError('CONFIG_INVALID', 'Bundle has no target_config_id (legacy row)', 400);
  }
  return job;
}

async function resolveStoreForBundle(app: FastifyInstance, bundleId: string): Promise<BackupStore> {
  const job = await loadBundle(app, bundleId);
  const [cfg] = await app.db.select().from(backupConfigurations).where(eq(backupConfigurations.id, job.targetConfigId!)).limit(1);
  if (!cfg) throw new ApiError('NOT_FOUND', 'Backup target not found', 404);
  const configuredKey = (app.config as Record<string, unknown>).OIDC_ENCRYPTION_KEY as string | undefined
    ?? process.env.OIDC_ENCRYPTION_KEY;
  if (!configuredKey && process.env.NODE_ENV === 'production') {
    app.log.error('tenant-backup-restore: OIDC_ENCRYPTION_KEY is not set in production — refusing to decrypt target credentials with zero-key fallback');
    throw new ApiError('CONFIG_INVALID', 'OIDC_ENCRYPTION_KEY is not configured; cannot decrypt backup target credentials', 500);
  }
  const encKey = configuredKey ?? '0'.repeat(64);
  if (cfg.storageType === 's3') {
    // Wrap decrypt() in try/catch — OpenSSL error strings can leak
    // ciphertext fragments. Match backups-v2/routes.ts pattern.
    let accessKey: string;
    let secretKey: string;
    try {
      accessKey = cfg.s3AccessKeyEncrypted ? decrypt(cfg.s3AccessKeyEncrypted, encKey) : '';
      secretKey = cfg.s3SecretKeyEncrypted ? decrypt(cfg.s3SecretKeyEncrypted, encKey) : '';
    } catch (err) {
      app.log.error({ err, configId: cfg.id }, 'tenant-backup-restore: S3 credential decryption failed');
      throw new ApiError('CONFIG_INVALID', 'S3 credential decryption failed (encryption key may have rotated)', 500);
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
    let privateKey: string;
    try {
      privateKey = decrypt(cfg.sshKeyEncrypted, encKey);
    } catch (err) {
      app.log.error({ err, configId: cfg.id }, 'tenant-backup-restore: SSH key decryption failed');
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
  throw new ApiError('NOT_IMPLEMENTED', `Store kind '${cfg.storageType}' not supported`, 501);
}

async function readConfigDump(app: FastifyInstance, bundleId: string): Promise<{ tables: Record<string, unknown[]> }> {
  const store = await resolveStoreForBundle(app, bundleId);
  const handle = await store.open(bundleId);
  if (!handle) throw new ApiError('NOT_FOUND', 'Bundle artefacts not found on remote target', 404);
  const stream = await store.readComponent(handle, 'config', 'db-rows.json.gz');
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  const buf = gunzipSync(Buffer.concat(chunks));
  const dump = JSON.parse(buf.toString('utf8')) as { tables?: Record<string, unknown[]> };
  return { tables: dump.tables ?? {} };
}

/** Dispatch one item to its type-specific executor. */
async function dispatchExecutor(app: FastifyInstance, item: RestoreItem, store: BackupStore): Promise<void> {
  switch (item.type) {
    case 'config-tables':
      await execConfigTablesItem({ app, item, store });
      return;
    case 'deployments-by-id':
      await execDeploymentsByIdItem({ app, item, store });
      return;
    case 'domains-by-id':
      await execDomainsByIdItem({ app, item, store });
      return;
    case 'files-paths':
      await execFilesPathsItem({ app, item, store });
      return;
    case 'mailboxes-by-address':
      await execMailboxesByAddressItem({ app, item, store });
      return;
    default: {
      const err = new Error(`Unknown restore item type '${item.type}'`);
      (err as Error & { code?: string }).code = 'UNKNOWN_TYPE';
      throw err;
    }
  }
}
