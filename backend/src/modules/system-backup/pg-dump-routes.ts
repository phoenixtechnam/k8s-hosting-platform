/**
 * Phase 2 — pg_dump routes (admin-gated, super_admin only).
 *
 *   POST /api/v1/system-backup/pg-dump          — trigger a dump
 *   GET  /api/v1/system-backup/pg-dump/clusters — list discoverable
 *                                                  CNPG clusters that
 *                                                  qualify as "system"
 *
 * Listing of pg_dump runs reuses GET /api/v1/system-backup/secrets/runs
 * pattern — Phase 2.3 will add a wider /api/v1/system-backup/runs that
 * lists all kinds together. For now operators filter by
 * source_namespace + source_cluster client-side.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authenticate, requireRole, requirePanel } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { systemBackupRuns, auditLogs, backupConfigurations, systemPgDumpSchedules } from '../../db/schema.js';
import { eq, desc, and, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import {
  pgDumpRequestSchema,
  pgDumpListQuerySchema,
  pgDumpScheduleUpsertSchema,
  type PgDumpResponse,
  type SystemBackupRun,
  type PgDumpSchedule,
} from '@k8s-hosting/api-contracts';
import { nextFireAt } from './pg-dump-scheduler.js';
import { createPgDumpJob } from './pg-dump-job-spawner.js';
import { resolveSystemStore, SYSTEM_BACKUP_CLIENT_ID, resolveCnpgCredentials } from './pg-dump-orchestrator.js';
import { getPlatformApiImage } from '../postgres-restore/service.js';
import { spawn } from 'node:child_process';

// Cap on simultaneous /download streams. Each download pipes the
// entire pgdump artifact (potentially multi-GB) S3/SSH→platform-api→
// client. Without a limit a single operator can saturate the pod's
// egress (sec review M-3). Module-scoped intentionally — per-replica
// counter is fine for DoS-from-self protection; if multi-replica
// total cap matters later, swap for a DB advisory-lock counter.
let activeDownloads = 0;
const MAX_CONCURRENT_DOWNLOADS = 3;

export async function systemBackupPgDumpRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requirePanel('admin'));
  app.addHook('onRequest', requireRole('super_admin'));

  // ── POST /system-backup/pg-dump ──────────────────────────────────
  app.post('/system-backup/pg-dump', {
    schema: {
      tags: ['SystemBackup'],
      summary: 'Trigger a pg_dump Job against a CNPG cluster (super_admin)',
      security: [{ bearerAuth: [] }],
    },
  }, async (request, reply) => {
    const parsed = pgDumpRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError('SYSTEM_BACKUP_BAD_REQUEST', parsed.error.message, 400);
    }
    const userId = (request.user as { sub?: string } | undefined)?.sub;
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new ApiError('UNAUTHENTICATED', 'no user id in token', 401);
    }

    // Validate target exists + active.
    const targetRows = await app.db
      .select()
      .from(backupConfigurations)
      .where(eq(backupConfigurations.id, parsed.data.targetConfigId))
      .limit(1);
    const target = targetRows[0];
    if (!target) {
      throw new ApiError('SYSTEM_BACKUP_TARGET_NOT_FOUND', 'backup target not found', 404);
    }
    if (target.active === false) {
      throw new ApiError('SYSTEM_BACKUP_TARGET_INACTIVE',
        'backup target is not active — activate it via /admin/backup-configs/:id/activate before triggering a dump',
        400);
    }

    const runId = randomUUID();
    const k8s = createK8sClients();
    const image = await getPlatformApiImage(k8s);

    // Create run row + audit row inside a transaction so we never
    // ship an unaudited dump. The transaction also closes the
    // concurrency race (DB review C1, Sec review M1): we lock any
    // pre-existing pending/running row for the same (ns, cluster, db)
    // tuple FOR UPDATE — a second concurrent POST will block and then
    // see our committed row, returning 409.
    try {
      await app.db.transaction(async (tx) => {
        const inflight = await tx
          .select({ id: systemBackupRuns.id })
          .from(systemBackupRuns)
          .where(and(
            eq(systemBackupRuns.kind, 'pg_dump'),
            eq(systemBackupRuns.sourceNamespace, parsed.data.sourceNamespace),
            eq(systemBackupRuns.sourceCluster, parsed.data.sourceCluster),
            eq(systemBackupRuns.sourceDatabase, parsed.data.sourceDatabase),
            inArray(systemBackupRuns.status, ['pending', 'running']),
          ))
          .for('update')
          .limit(1);
        if (inflight.length > 0) {
          throw new ApiError(
            'SYSTEM_BACKUP_ALREADY_RUNNING',
            `a pg_dump for ${parsed.data.sourceNamespace}/${parsed.data.sourceCluster} is already in flight (run ${inflight[0].id})`,
            409,
          );
        }
        await tx.insert(systemBackupRuns).values({
          id: runId,
          kind: 'pg_dump',
          status: 'pending',
          operatorUserId: userId,
          operatorIp: clientIp(request),
          operatorUserAgent: clientUa(request),
          sourceNamespace: parsed.data.sourceNamespace,
          sourceCluster: parsed.data.sourceCluster,
          sourceDatabase: parsed.data.sourceDatabase,
          targetConfigId: parsed.data.targetConfigId,
        });
        await tx.insert(auditLogs).values({
          id: randomUUID(),
          actionType: 'system_backup_pg_dump',
          resourceType: 'system_backup_run',
          resourceId: runId,
          actorId: userId,
          actorType: 'user',
          httpMethod: 'POST',
          httpPath: '/api/v1/system-backup/pg-dump',
          httpStatus: 202,
          changes: {
            sourceNamespace: parsed.data.sourceNamespace,
            sourceCluster: parsed.data.sourceCluster,
            sourceDatabase: parsed.data.sourceDatabase,
            targetConfigId: parsed.data.targetConfigId,
            reason: parsed.data.reason ?? null,
          },
          ipAddress: clientIp(request) ?? null,
        });
      });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(
        'SYSTEM_BACKUP_RUN_CREATE_FAILED',
        err instanceof Error ? err.message : String(err),
        500,
      );
    }

    let jobInfo: { jobName: string; namespace: string };
    try {
      jobInfo = await createPgDumpJob(k8s, {
        runId,
        namespace: parsed.data.sourceNamespace,
        cluster: parsed.data.sourceCluster,
        database: parsed.data.sourceDatabase,
        targetConfigId: parsed.data.targetConfigId,
        actorUserId: userId,
        image,
      });
    } catch (err) {
      // Job creation failed — flip the row to failed before we ack 202.
      const msg = err instanceof Error ? err.message : String(err);
      await app.db.update(systemBackupRuns)
        .set({
          status: 'failed',
          finishedAt: new Date(),
          errorEnvelope: { code: 'SYSTEM_BACKUP_JOB_CREATE_FAILED', message: msg } as unknown as Record<string, unknown>,
        })
        .where(eq(systemBackupRuns.id, runId));
      throw new ApiError('SYSTEM_BACKUP_JOB_CREATE_FAILED', msg, 502);
    }

    await app.db.update(systemBackupRuns)
      .set({ status: 'running', jobName: jobInfo.jobName })
      .where(eq(systemBackupRuns.id, runId));

    void reply.code(202);
    return success<PgDumpResponse>({
      runId,
      status: 'running',
      jobName: jobInfo.jobName,
      pollUrl: `/api/v1/system-backup/pg-dump/runs/${runId}`,
    });
  });

  // ── GET /system-backup/pg-dump/runs ─────────────────────────────
  app.get('/system-backup/pg-dump/runs', {
    schema: {
      tags: ['SystemBackup'],
      summary: 'List pg_dump runs (optionally filtered by cluster)',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const parsedQuery = pgDumpListQuerySchema.safeParse(request.query ?? {});
    if (!parsedQuery.success) {
      throw new ApiError('SYSTEM_BACKUP_BAD_REQUEST', parsedQuery.error.message, 400);
    }
    const q = parsedQuery.data;
    const limit = Math.min(Math.max(parseInt(q.limit ?? '20', 10) || 20, 1), 100);
    const conditions = [eq(systemBackupRuns.kind, 'pg_dump')];
    if (q.namespace) conditions.push(eq(systemBackupRuns.sourceNamespace, q.namespace));
    if (q.cluster) conditions.push(eq(systemBackupRuns.sourceCluster, q.cluster));
    const rows = await app.db
      .select(RUN_COLUMNS)
      .from(systemBackupRuns)
      .where(and(...conditions))
      .orderBy(desc(systemBackupRuns.createdAt))
      .limit(limit);
    return success(rows.map(toApiRun));
  });

  // ── DELETE /system-backup/pg-dump/runs/:id ──────────────────────
  // Removes the artifact at the BackupStore + the run row + writes
  // an audit row. Idempotent: 404 if already gone. Best-effort on
  // store delete (bundle may already be pruned by retention).
  app.delete('/system-backup/pg-dump/runs/:id', {
    schema: {
      tags: ['SystemBackup'],
      summary: 'Delete pg_dump run + artifact at backup target',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const userId = (request.user as { sub?: string } | undefined)?.sub;
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new ApiError('UNAUTHENTICATED', 'no user id in token', 401);
    }
    const rows = await app.db
      .select({
        id: systemBackupRuns.id,
        kind: systemBackupRuns.kind,
        status: systemBackupRuns.status,
        targetConfigId: systemBackupRuns.targetConfigId,
        bundleId: systemBackupRuns.bundleId,
      })
      .from(systemBackupRuns)
      .where(and(eq(systemBackupRuns.id, id), eq(systemBackupRuns.kind, 'pg_dump')))
      .limit(1);
    const row = rows[0];
    if (!row) throw new ApiError('SYSTEM_BACKUP_RUN_NOT_FOUND', 'run not found', 404);

    if (row.targetConfigId && row.bundleId && row.status === 'succeeded') {
      try {
        const oidcKey = (app.config as Record<string, unknown>).PLATFORM_ENCRYPTION_KEY as string | undefined;
        const { store } = await resolveSystemStore(app.db, row.targetConfigId, oidcKey ?? null);
        const handle = await store.open(row.bundleId);
        if (handle) await store.delete(handle);
      } catch (err) {
        // Elevated to ERROR (was warn): once the row is deleted we
        // lose the bundleId, and the orphan S3 object is invisible
        // to retention. Surface to the production alerting pipeline.
        app.log.error(
          { err, runId: id, bundleId: row.bundleId, targetConfigId: row.targetConfigId },
          '[system-backup] artifact delete failed — orphan possible at backup target',
        );
      }
    }

    await app.db.transaction(async (tx) => {
      await tx.delete(systemBackupRuns).where(eq(systemBackupRuns.id, id));
      await tx.insert(auditLogs).values({
        id: randomUUID(),
        actionType: 'system_backup_pg_dump_delete',
        resourceType: 'system_backup_run',
        resourceId: id,
        actorId: userId,
        actorType: 'user',
        httpMethod: 'DELETE',
        httpPath: `/api/v1/system-backup/pg-dump/runs/${id}`,
        httpStatus: 200,
        changes: { bundleId: row.bundleId, targetConfigId: row.targetConfigId },
        ipAddress: clientIp(request) ?? null,
      });
    });
    return success({ ok: true });
  });

  // ── POST /system-backup/pg-dump/runs/:id/restore-recipe ─────────
  // Returns the manual `pg_restore` command for the operator to run
  // against the chosen target. The run is super_admin-gated, audited.
  // In-product orchestrated restore (spawns a Job that downloads +
  // pipes pg_restore) lands in Phase 5 DR drill.
  app.post('/system-backup/pg-dump/runs/:id/restore-recipe', {
    schema: {
      tags: ['SystemBackup'],
      summary: 'Get pg_restore recipe for a succeeded run',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const rows = await app.db
      .select({
        id: systemBackupRuns.id,
        sourceCluster: systemBackupRuns.sourceCluster,
        sourceDatabase: systemBackupRuns.sourceDatabase,
        sourceNamespace: systemBackupRuns.sourceNamespace,
        artifactName: systemBackupRuns.artifactName,
        sha256: systemBackupRuns.sha256,
      })
      .from(systemBackupRuns)
      .where(and(eq(systemBackupRuns.id, id), eq(systemBackupRuns.kind, 'pg_dump'),
        eq(systemBackupRuns.status, 'succeeded')))
      .limit(1);
    const row = rows[0];
    if (!row) {
      throw new ApiError('SYSTEM_BACKUP_RUN_NOT_FOUND',
        'run not found or not in status=succeeded', 404);
    }
    const file = row.artifactName ?? 'dump.pgdump';
    return success({
      runId: id,
      downloadUrl: `/api/v1/system-backup/pg-dump/runs/${id}/download`,
      sha256: row.sha256,
      recipe: [
        `# 1. Download (super_admin JWT required)`,
        `curl -sSL -H 'Authorization: Bearer <jwt>' \\`,
        `  https://<admin-host>/api/v1/system-backup/pg-dump/runs/${id}/download \\`,
        `  -o ${file}`,
        ...(row.sha256 ? [`# 2. Verify`, `sha256sum ${file}  # expect ${row.sha256}`] : []),
        `# ${row.sha256 ? '3' : '2'}. Restore into the source cluster (will WIPE existing data)`,
        `kubectl -n ${row.sourceNamespace} cp ${file} ${row.sourceCluster}-1:/tmp/`,
        `kubectl -n ${row.sourceNamespace} exec -it ${row.sourceCluster}-1 -- \\`,
        `  pg_restore --no-owner --no-privileges --clean --if-exists \\`,
        `  -d ${row.sourceDatabase} /tmp/${file}`,
      ].join('\n'),
      note: 'In-product orchestrated restore lands in Phase 5 (DR drill).',
    });
  });

  // ── GET /system-backup/pg-dump/runs/:id ─────────────────────────
  app.get('/system-backup/pg-dump/runs/:id', {
    schema: {
      tags: ['SystemBackup'],
      summary: 'Get one pg_dump run',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const rows = await app.db
      .select(RUN_COLUMNS)
      .from(systemBackupRuns)
      .where(and(
        eq(systemBackupRuns.id, id),
        eq(systemBackupRuns.kind, 'pg_dump'),
      ))
      .limit(1);
    if (rows.length === 0) {
      throw new ApiError('SYSTEM_BACKUP_RUN_NOT_FOUND', 'pg_dump run not found', 404);
    }
    return success(toApiRun(rows[0]));
  });

  // ── GET /system-backup/pg-dump/runs/:id/download ────────────────
  // Stream the pg_dump artifact straight from the BackupStore back
  // to the operator. Super_admin gated (already by addHook). Body is
  // a Postgres custom-format archive (use with `pg_restore`).
  //
  // Supports If-Match: <sha256> for safety — the operator can pin to
  // the exact bytes they expect, e.g. when piping into pg_restore in
  // a script. If not provided, no integrity precheck is done; the
  // sha256 is still in the JSON run row for after-the-fact verify.
  app.get('/system-backup/pg-dump/runs/:id/download', {
    schema: {
      tags: ['SystemBackup'],
      summary: 'Stream the pg_dump artifact (super_admin)',
      security: [{ bearerAuth: [] }],
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const ifMatch = (request.headers['if-match'] as string | undefined)?.replace(/^"|"$/g, '');

    const rows = await app.db
      .select({
        id: systemBackupRuns.id,
        kind: systemBackupRuns.kind,
        status: systemBackupRuns.status,
        targetConfigId: systemBackupRuns.targetConfigId,
        bundleId: systemBackupRuns.bundleId,
        artifactName: systemBackupRuns.artifactName,
        sha256: systemBackupRuns.sha256,
        sizeBytes: systemBackupRuns.sizeBytes,
      })
      .from(systemBackupRuns)
      .where(and(eq(systemBackupRuns.id, id), eq(systemBackupRuns.kind, 'pg_dump')))
      .limit(1);
    const row = rows[0];
    if (!row) throw new ApiError('SYSTEM_BACKUP_RUN_NOT_FOUND', 'pg_dump run not found', 404);
    if (row.status !== 'succeeded') {
      throw new ApiError('SYSTEM_BACKUP_NOT_DOWNLOADABLE',
        `run is in status=${row.status}; only succeeded runs are downloadable`, 409);
    }
    if (!row.targetConfigId || !row.bundleId || !row.artifactName) {
      throw new ApiError('SYSTEM_BACKUP_INCOMPLETE_RUN',
        'run row missing target/bundle/artifact — likely a partial write', 500);
    }
    if (ifMatch && row.sha256 && ifMatch !== row.sha256) {
      throw new ApiError('SYSTEM_BACKUP_PRECONDITION_FAILED',
        `If-Match=${ifMatch} ≠ sha256=${row.sha256}`, 412);
    }

    if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS) {
      throw new ApiError('SYSTEM_BACKUP_DOWNLOAD_BUSY',
        `too many concurrent downloads (max ${MAX_CONCURRENT_DOWNLOADS}) — try again shortly`, 429);
    }

    const oidcKey = (app.config as Record<string, unknown>).PLATFORM_ENCRYPTION_KEY as string | undefined;
    const { store } = await resolveSystemStore(app.db, row.targetConfigId, oidcKey ?? null);
    const handle = await store.open(row.bundleId);
    if (!handle) {
      throw new ApiError('SYSTEM_BACKUP_BUNDLE_NOT_FOUND',
        `bundle ${row.bundleId} not found at backup target — may have been pruned by retention`, 404);
    }
    const stat = await store.stat(handle, 'config', row.artifactName);
    if (!stat) {
      throw new ApiError('SYSTEM_BACKUP_ARTIFACT_NOT_FOUND',
        `artifact ${row.artifactName} not found in bundle`, 404);
    }
    const body = await store.readComponent(handle, 'config', row.artifactName);

    // Audit + downloadedAt stamp BEFORE response is committed (sec
    // review M-2). On a partial-stream failure the timestamp + audit
    // row may be ahead of the actual byte transfer — that's acceptable
    // forensics-wise (logs the *attempt*, not "we know it succeeded").
    const userId = (request.user as { sub?: string } | undefined)?.sub ?? null;
    try {
      await app.db.transaction(async (tx) => {
        await tx.insert(auditLogs).values({
          id: randomUUID(),
          actionType: 'system_backup_pg_dump_download',
          resourceType: 'system_backup_run',
          resourceId: row.id,
          actorId: userId ?? '',
          actorType: 'user',
          httpMethod: 'GET',
          httpPath: `/api/v1/system-backup/pg-dump/runs/${row.id}/download`,
          httpStatus: 200,
          changes: { bundleId: row.bundleId, sha256: row.sha256, sizeBytes: row.sizeBytes },
          ipAddress: clientIp(request) ?? null,
        });
        await tx.update(systemBackupRuns)
          .set({ downloadedAt: new Date() })
          .where(eq(systemBackupRuns.id, row.id));
      });
    } catch (auditErr) {
      // Audit failure should NOT block the download (operator may need
      // it during incident response when DB is degraded). Log loudly.
      app.log.error({ err: auditErr, runId: row.id }, '[system-backup] download audit write failed');
    }

    // RFC 5987-style filename* encoding so artifact names with edge
    // chars (theoretically possible if Zod ever loosens) can't inject
    // headers. Also strip CR/LF as belt-and-braces.
    const safeName = row.artifactName.replace(/[\r\n"\\]/g, '_');
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Disposition',
      `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(row.artifactName)}`);
    if (Number.isFinite(stat.sizeBytes) && stat.sizeBytes >= 0) {
      reply.header('Content-Length', String(stat.sizeBytes));
    }
    if (row.sha256) reply.header('X-Content-Sha256', row.sha256);
    reply.header('Cache-Control', 'no-store');

    // Concurrency counter — increment before send, decrement on
    // response close (success OR error path). Fastify emits 'close'
    // on the underlying socket regardless of how the response ended.
    activeDownloads++;
    reply.raw.on('close', () => { activeDownloads = Math.max(0, activeDownloads - 1); });

    void SYSTEM_BACKUP_CLIENT_ID;
    return reply.send(body);
  });

  // ─── Phase 4b: one-off direct download (no S3 push, no run row) ─
  // Streams `pg_dump --format=custom` bytes directly to the HTTP
  // response. No Job pod, no BackupStore reservation, no audit run
  // row — the audit_logs row is the only persistent trace. Useful
  // for ad-hoc recovery / forensics / GDPR data export.
  app.post('/system-backup/pg-dump/stream', {
    schema: {
      tags: ['SystemBackup'],
      summary: 'One-off pg_dump streamed directly back (super_admin)',
      security: [{ bearerAuth: [] }],
    },
  }, async (request, reply) => {
    const parsed = pgDumpRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError('SYSTEM_BACKUP_BAD_REQUEST', parsed.error.message, 400);
    }
    const userId = (request.user as { sub?: string } | undefined)?.sub;
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new ApiError('UNAUTHENTICATED', 'no user id in token', 401);
    }
    const k8s = createK8sClients();
    const creds = await resolveCnpgCredentials(
      k8s, parsed.data.sourceNamespace, parsed.data.sourceCluster,
    );

    // Audit BEFORE we commit the response. The streamed output never
    // touches the DB, so this is the only persistent record.
    await app.db.insert(auditLogs).values({
      id: randomUUID(),
      actionType: 'system_backup_pg_dump_stream',
      resourceType: 'cnpg_cluster',
      resourceId: `${parsed.data.sourceNamespace}/${parsed.data.sourceCluster}/${parsed.data.sourceDatabase}`,
      actorId: userId,
      actorType: 'user',
      httpMethod: 'POST',
      httpPath: '/api/v1/system-backup/pg-dump/stream',
      httpStatus: 200,
      changes: { reason: parsed.data.reason ?? null },
      ipAddress: clientIp(request) ?? null,
    });

    // `-r` (any ready instance) instead of `-ro` (replicas only) so
    // single-instance CNPG clusters work — see orchestrator comment.
    const host = `${parsed.data.sourceCluster}-r.${parsed.data.sourceNamespace}.svc`;
    const args = [
      '-h', host, '-p', '5432',
      '-d', parsed.data.sourceDatabase,
      '--format=custom', '--compress=9',
      '--no-owner', '--no-privileges',
    ];
    const proc = spawn('pg_dump', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PGUSER: creds.username, PGPASSWORD: creds.password },
    });
    // Capture stderr so a non-zero exit produces a useful error log
    // (operator gets a partial body in this case — that's the price
    // of streaming; their client should fail any sha-checksum step).
    const stderrChunks: Buffer[] = [];
    proc.stderr.on('data', (c: Buffer) => { if (stderrChunks.length < 100) stderrChunks.push(c); });
    proc.on('error', (err) => {
      app.log.error({ err }, '[pg-dump-stream] spawn error');
    });
    proc.on('close', (code) => {
      if (code !== 0) {
        const err = Buffer.concat(stderrChunks).toString('utf8').slice(0, 1000);
        app.log.warn({ code, err, ns: parsed.data.sourceNamespace, cluster: parsed.data.sourceCluster },
          '[pg-dump-stream] pg_dump exited non-zero');
      }
    });
    // Kill pg_dump if the client aborts the response — otherwise we'd
    // leak a child process per cancelled download.
    reply.raw.on('close', () => {
      if (!proc.killed) proc.kill('SIGTERM');
    });

    const safeName = `${parsed.data.sourceCluster}.${parsed.data.sourceDatabase}.pgdump`
      .replace(/[\r\n"\\]/g, '_');
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename="${safeName}"`);
    reply.header('Cache-Control', 'no-store');
    return reply.send(proc.stdout);
  });

  // ─── Phase 4b: pg_dump scheduled exports ───────────────────────
  // GET — list schedules
  app.get('/system-backup/pg-dump/schedules', {
    schema: { tags: ['SystemBackup'], summary: 'List pg_dump schedules', security: [{ bearerAuth: [] }] },
  }, async () => {
    const rows = await app.db.select().from(systemPgDumpSchedules)
      .orderBy(systemPgDumpSchedules.sourceNamespace, systemPgDumpSchedules.sourceCluster);
    const targetIds = [...new Set(rows.map((r) => r.targetConfigId))];
    const targets = targetIds.length > 0
      ? await app.db
        .select({ id: backupConfigurations.id, name: backupConfigurations.name })
        .from(backupConfigurations)
        .where(inArray(backupConfigurations.id, targetIds))
      : [];
    const nameById = new Map(targets.map((t) => [t.id, t.name] as const));
    const out: PgDumpSchedule[] = rows.map((r) => ({
      id: r.id,
      sourceNamespace: r.sourceNamespace,
      sourceCluster: r.sourceCluster,
      sourceDatabase: r.sourceDatabase,
      targetConfigId: r.targetConfigId,
      targetName: nameById.get(r.targetConfigId) ?? null,
      cronSchedule: r.cronSchedule,
      retentionDays: r.retentionDays,
      enabled: r.enabled,
      lastRunAt: r.lastRunAt?.toISOString() ?? null,
      lastRunId: r.lastRunId,
      nextRunAt: r.nextRunAt?.toISOString() ?? null,
    }));
    return success(out);
  });

  // POST — upsert (one schedule per ns/cluster/db tuple)
  app.post('/system-backup/pg-dump/schedules', {
    schema: { tags: ['SystemBackup'], summary: 'Create/update pg_dump schedule', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const parsed = pgDumpScheduleUpsertSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError('SYSTEM_BACKUP_BAD_REQUEST', parsed.error.message, 400);
    }
    const userId = (request.user as { sub?: string } | undefined)?.sub;
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new ApiError('UNAUTHENTICATED', 'no user id in token', 401);
    }
    // Validate target exists + active.
    const cfgRows = await app.db
      .select({ id: backupConfigurations.id, active: backupConfigurations.active })
      .from(backupConfigurations)
      .where(eq(backupConfigurations.id, parsed.data.targetConfigId))
      .limit(1);
    if (!cfgRows[0]) throw new ApiError('SYSTEM_BACKUP_TARGET_NOT_FOUND', 'target not found', 404);
    if (!cfgRows[0].active) throw new ApiError('SYSTEM_BACKUP_TARGET_INACTIVE', 'target is not active', 400);

    const next = nextFireAt(parsed.data.cronSchedule, new Date());
    const id = randomUUID();
    await app.db.transaction(async (tx) => {
      await tx.insert(systemPgDumpSchedules).values({
        id,
        sourceNamespace: parsed.data.sourceNamespace,
        sourceCluster: parsed.data.sourceCluster,
        sourceDatabase: parsed.data.sourceDatabase,
        targetConfigId: parsed.data.targetConfigId,
        cronSchedule: parsed.data.cronSchedule,
        retentionDays: parsed.data.retentionDays,
        enabled: parsed.data.enabled,
        nextRunAt: next,
        operatorUserId: userId,
      }).onConflictDoUpdate({
        target: [
          systemPgDumpSchedules.sourceNamespace,
          systemPgDumpSchedules.sourceCluster,
          systemPgDumpSchedules.sourceDatabase,
        ],
        set: {
          targetConfigId: parsed.data.targetConfigId,
          cronSchedule: parsed.data.cronSchedule,
          retentionDays: parsed.data.retentionDays,
          enabled: parsed.data.enabled,
          nextRunAt: next,
          operatorUserId: userId,
          updatedAt: new Date(),
        },
      });
      await tx.insert(auditLogs).values({
        id: randomUUID(),
        actionType: 'system_backup_pg_dump_schedule_upsert',
        resourceType: 'pg_dump_schedule',
        resourceId: `${parsed.data.sourceNamespace}/${parsed.data.sourceCluster}/${parsed.data.sourceDatabase}`,
        actorId: userId,
        actorType: 'user',
        httpMethod: 'POST',
        httpPath: '/api/v1/system-backup/pg-dump/schedules',
        httpStatus: 200,
        changes: parsed.data as unknown as Record<string, unknown>,
        ipAddress: clientIp(request) ?? null,
      });
    });
    return success({ ok: true, id, nextRunAt: next.toISOString() });
  });

  // DELETE — remove schedule
  app.delete('/system-backup/pg-dump/schedules/:id', {
    schema: { tags: ['SystemBackup'], summary: 'Delete pg_dump schedule', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const userId = (request.user as { sub?: string } | undefined)?.sub;
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new ApiError('UNAUTHENTICATED', 'no user id in token', 401);
    }
    await app.db.transaction(async (tx) => {
      const deleted = await tx.delete(systemPgDumpSchedules)
        .where(eq(systemPgDumpSchedules.id, id))
        .returning({ id: systemPgDumpSchedules.id });
      if (deleted.length === 0) {
        throw new ApiError('SYSTEM_BACKUP_SCHEDULE_NOT_FOUND', 'schedule not found', 404);
      }
      await tx.insert(auditLogs).values({
        id: randomUUID(),
        actionType: 'system_backup_pg_dump_schedule_delete',
        resourceType: 'pg_dump_schedule',
        resourceId: id,
        actorId: userId,
        actorType: 'user',
        httpMethod: 'DELETE',
        httpPath: `/api/v1/system-backup/pg-dump/schedules/${id}`,
        httpStatus: 200,
        changes: null,
        ipAddress: clientIp(request) ?? null,
      });
    });
    return success({ ok: true });
  });
}

const RUN_COLUMNS = {
  id: systemBackupRuns.id,
  kind: systemBackupRuns.kind,
  status: systemBackupRuns.status,
  startedAt: systemBackupRuns.startedAt,
  finishedAt: systemBackupRuns.finishedAt,
  sizeBytes: systemBackupRuns.sizeBytes,
  sha256: systemBackupRuns.sha256,
  errorEnvelope: systemBackupRuns.errorEnvelope,
  operatorUserId: systemBackupRuns.operatorUserId,
  operatorIp: systemBackupRuns.operatorIp,
  operatorUserAgent: systemBackupRuns.operatorUserAgent,
  manifest: systemBackupRuns.manifest,
  downloadUrlExpiresAt: systemBackupRuns.downloadUrlExpiresAt,
  downloadedAt: systemBackupRuns.downloadedAt,
  createdAt: systemBackupRuns.createdAt,
  sourceNamespace: systemBackupRuns.sourceNamespace,
  sourceCluster: systemBackupRuns.sourceCluster,
  sourceDatabase: systemBackupRuns.sourceDatabase,
  targetConfigId: systemBackupRuns.targetConfigId,
  bundleId: systemBackupRuns.bundleId,
  artifactName: systemBackupRuns.artifactName,
  jobName: systemBackupRuns.jobName,
};

interface RunRow {
  id: string;
  kind: string;
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
  sizeBytes: number | null;
  sha256: string | null;
  errorEnvelope: unknown;
  operatorUserId: string | null;
  operatorIp: string | null;
  operatorUserAgent: string | null;
  manifest: unknown;
  downloadUrlExpiresAt: Date | null;
  downloadedAt: Date | null;
  createdAt: Date;
  sourceNamespace: string | null;
  sourceCluster: string | null;
  sourceDatabase: string | null;
  targetConfigId: string | null;
  bundleId: string | null;
  artifactName: string | null;
  jobName: string | null;
}

function toApiRun(row: RunRow): SystemBackupRun {
  return {
    id: row.id,
    kind: row.kind as SystemBackupRun['kind'],
    status: row.status as SystemBackupRun['status'],
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    errorEnvelope: row.errorEnvelope ?? null,
    operatorUserId: row.operatorUserId,
    operatorIp: row.operatorIp,
    operatorUserAgent: row.operatorUserAgent,
    manifest: (row.manifest as SystemBackupRun['manifest']) ?? null,
    downloadUrl: null, // pg_dumps don't use the inline-payload download path
    downloadUrlExpiresAt: row.downloadUrlExpiresAt?.toISOString() ?? null,
    downloadedAt: row.downloadedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    sourceNamespace: row.sourceNamespace,
    sourceCluster: row.sourceCluster,
    sourceDatabase: row.sourceDatabase,
    targetConfigId: row.targetConfigId,
    bundleId: row.bundleId,
    artifactName: row.artifactName,
    jobName: row.jobName,
  };
}

function clientIp(request: FastifyRequest): string | null {
  const xff = (request.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim();
  return xff || request.ip || null;
}
function clientUa(request: FastifyRequest): string | null {
  const ua = request.headers['user-agent'];
  if (typeof ua === 'string') return ua.slice(0, 500);
  return null;
}
