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
import { systemBackupRuns, auditLogs, backupConfigurations } from '../../db/schema.js';
import { eq, desc, and, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import {
  pgDumpRequestSchema,
  pgDumpListQuerySchema,
  type PgDumpResponse,
  type SystemBackupRun,
} from '@k8s-hosting/api-contracts';
import { createPgDumpJob } from './pg-dump-job-spawner.js';
import { getPlatformApiImage } from '../postgres-restore/service.js';

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
