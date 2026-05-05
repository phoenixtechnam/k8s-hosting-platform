/**
 * System Backup, Phase 1 routes.
 *
 * All endpoints under `/api/v1/system-backup` are super_admin gated
 * EXCEPT the download endpoint which is bearer-token-IS-auth (the
 * one-shot HMAC token in the URL is the only credential).
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authenticate, requireRole, requirePanel } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { systemBackupRuns, auditLogs } from '../../db/schema.js';
import { desc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  exportSecretsBundleRequestSchema,
  type ExportSecretsBundleResponse,
  type SystemBackupRun,
  type SecretsBundleManifestResponse,
} from '@k8s-hosting/api-contracts';
import {
  createSecretsBundleExport,
  claimDownloadToken,
  readManifest,
} from './service.js';

export async function systemBackupRoutes(app: FastifyInstance): Promise<void> {
  // Fail-closed on missing/short JWT_SECRET — without this, download
  // tokens would be signed with a known-zero key in the dev fallback
  // path and any caller could forge. Read EXCLUSIVELY from app.config
  // (the resolved auth source); no env-var fallback.
  const jwtSecret = (app.config as Record<string, unknown>).JWT_SECRET as string | undefined;
  if (!jwtSecret || jwtSecret.length < 32) {
    throw new Error('system-backup: app.config.JWT_SECRET must be set (≥32 chars) for download-token HMAC');
  }
  const effectiveJwtSecret = jwtSecret;

  // The download route bypasses auth (token IS the credential), so it
  // is registered FIRST without the auth hook. Subsequent routes
  // inherit the auth hooks via app.addHook('onRequest', ...) below.
  //
  // Fastify hooks added after a route registration do NOT apply to
  // that route — exactly the property we need here.

  // ── GET /system-backup/secrets/download/:token ────────────────────
  // Single-use, HMAC-signed, no Bearer auth. Token IS the auth.
  app.get('/system-backup/secrets/download/:token', {
    config: {
      // Per-route rate limit. The download endpoint is unauthenticated
      // (token IS auth) so the global rate-limit hook (registered
      // AFTER this route) does not apply. 10 attempts/minute/IP is
      // tight enough to deter token-fishing yet loose enough that a
      // legitimate retry over a flaky network still works.
      rateLimit: { max: 10, timeWindow: '1 minute' },
    },
    schema: {
      tags: ['SystemBackup'],
      summary: 'Single-use bundle download (HMAC token IS auth)',
    },
  }, async (request, reply) => {
    const { token } = request.params as { token: string };
    const auditFailed = (httpStatus: number, errCode: string): Promise<void> =>
      app.db.insert(auditLogs).values({
        id: randomUUID(),
        actionType: 'system_backup_secrets_download_failed',
        resourceType: 'system_backup_run',
        // Token format: <runId>.<expiresMs>.<mac>; runId is the first segment.
        resourceId: token?.split('.')[0]?.slice(0, 36) ?? 'unknown',
        actorId: 'anonymous',
        actorType: 'system',
        httpMethod: 'GET',
        httpPath: '/api/v1/system-backup/secrets/download/[REDACTED]',
        httpStatus,
        changes: { code: errCode },
        ipAddress: clientIp(request),
      })
        .then(() => undefined)
        .catch((err) => app.log.error({ err }, '[system-backup] audit-log failed for failed download'));

    if (!token || token.length < 80 || token.length > 256) {
      await auditFailed(400, 'SYSTEM_BACKUP_INVALID_TOKEN');
      throw new ApiError('SYSTEM_BACKUP_INVALID_TOKEN', 'invalid token format', 400);
    }
    const claim = await claimDownloadToken(app.db, token, effectiveJwtSecret);
    if (!claim) {
      // Distinguish four cases would leak: doesn't exist vs expired vs
      // already-used vs bad mac. Return a single 410 with no detail.
      await auditFailed(410, 'SYSTEM_BACKUP_TOKEN_INVALID');
      throw new ApiError('SYSTEM_BACKUP_TOKEN_INVALID',
        'download token is invalid, expired, or already used', 410);
    }
    // Successful download — audit-log the successful claim with the
    // bundle sha256 + size for forensic correlation.
    await app.db.insert(auditLogs).values({
      id: randomUUID(),
      actionType: 'system_backup_secrets_download',
      resourceType: 'system_backup_run',
      resourceId: token.split('.')[0]?.slice(0, 36) ?? 'unknown',
      actorId: 'token-bearer',
      actorType: 'system',
      httpMethod: 'GET',
      httpPath: '/api/v1/system-backup/secrets/download/[REDACTED]',
      httpStatus: 200,
      changes: { sha256: claim.sha256, sizeBytes: claim.sizeBytes },
      ipAddress: clientIp(request),
    }).catch((err) => app.log.error({ err }, '[system-backup] audit-log failed for successful download'));

    void reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Disposition', `attachment; filename="secrets-bundle-${claim.sha256.slice(0, 12)}.tar.age"`)
      .header('Content-Length', String(claim.sizeBytes))
      .header('X-Content-SHA256', claim.sha256)
      .header('Cache-Control', 'no-store, max-age=0');
    return reply.send(claim.payload);
  });

  // All routes below require super_admin + admin panel.
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requirePanel('admin'));
  app.addHook('onRequest', requireRole('super_admin'));

  // Build K8sClients once per request (cheap; clients are pooled
  // internally by @kubernetes/client-node).
  const k8sFactory = (): ReturnType<typeof createK8sClients> => createK8sClients();

  // ── POST /system-backup/secrets/export ───────────────────────────
  app.post('/system-backup/secrets/export', {
    schema: {
      tags: ['SystemBackup'],
      summary: 'Trigger a secrets-bundle export (super_admin only)',
      security: [{ bearerAuth: [] }],
    },
  }, async (request, reply) => {
    const parsed = exportSecretsBundleRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError('SYSTEM_BACKUP_BAD_REQUEST', parsed.error.message, 400);
    }
    const userId = (request.user as { sub?: string } | undefined)?.sub;
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new ApiError('UNAUTHENTICATED', 'no user id in token', 401);
    }
    const result = await createSecretsBundleExport(
      {
        k8s: k8sFactory(),
        db: app.db,
        jwtSecret: effectiveJwtSecret,
        operatorUserId: userId,
        operatorIp: clientIp(request),
        operatorUserAgent: clientUa(request),
        reason: parsed.data.reason ?? null,
      },
      app.log as unknown as { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void },
    );
    void reply.code(202);
    return success<ExportSecretsBundleResponse>(result);
  });

  // ── GET /system-backup/secrets/manifest ──────────────────────────
  app.get('/system-backup/secrets/manifest', {
    schema: {
      tags: ['SystemBackup'],
      summary: 'List which Secrets/ConfigMaps the next bundle would include (no values)',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const manifest = await readManifest(k8sFactory());
    return success<SecretsBundleManifestResponse>(manifest);
  });

  // Project explicit columns (omit `payload` BYTEA) — list endpoint
  // could return up to 100 rows, each carrying ~100 KiB encrypted
  // bytes that are never serialised to the wire but ARE deserialised
  // into the Drizzle result. Skip the cost.
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
    downloadTokenRaw: systemBackupRuns.downloadTokenRaw,
    downloadUrlExpiresAt: systemBackupRuns.downloadUrlExpiresAt,
    downloadedAt: systemBackupRuns.downloadedAt,
    createdAt: systemBackupRuns.createdAt,
  };

  // ── GET /system-backup/secrets/runs ──────────────────────────────
  app.get('/system-backup/secrets/runs', {
    schema: {
      tags: ['SystemBackup'],
      summary: 'List recent secrets-bundle export runs',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const q = request.query as { limit?: string };
    const limit = Math.min(Math.max(parseInt(q.limit ?? '20', 10) || 20, 1), 100);
    const rows = await app.db
      .select(RUN_COLUMNS)
      .from(systemBackupRuns)
      .where(eq(systemBackupRuns.kind, 'secrets'))
      .orderBy(desc(systemBackupRuns.createdAt))
      .limit(limit);
    // List endpoint never surfaces the download URL — keeps the URL
    // out of cached/logged list responses. Single-row GET below does.
    return success(rows.map((r) => toApiRun(r, /*includeDownloadUrl*/ false)));
  });

  // ── GET /system-backup/secrets/runs/:id ──────────────────────────
  app.get('/system-backup/secrets/runs/:id', {
    schema: {
      tags: ['SystemBackup'],
      summary: 'Get one run; includes one-time download URL when status=succeeded',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const rows = await app.db
      .select(RUN_COLUMNS)
      .from(systemBackupRuns)
      .where(eq(systemBackupRuns.id, id))
      .limit(1);
    const row = rows[0];
    if (!row || row.kind !== 'secrets') {
      throw new ApiError('SYSTEM_BACKUP_RUN_NOT_FOUND', 'run not found', 404);
    }
    return success(toApiRun(row, /*includeDownloadUrl*/ true));
  });
}

interface SystemBackupRunRow {
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
  downloadTokenRaw: string | null;
  downloadUrlExpiresAt: Date | null;
  downloadedAt: Date | null;
  createdAt: Date;
}

function toApiRun(row: SystemBackupRunRow, includeDownloadUrl: boolean): SystemBackupRun {
  let downloadUrl: string | null = null;
  if (
    includeDownloadUrl
    && row.status === 'succeeded'
    && row.downloadedAt === null
    && row.downloadTokenRaw !== null
    && row.downloadUrlExpiresAt
    && row.downloadUrlExpiresAt.getTime() > Date.now()
  ) {
    downloadUrl = `/api/v1/system-backup/secrets/download/${row.downloadTokenRaw}`;
  }
  return {
    id: row.id,
    kind: row.kind as 'secrets',
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
    downloadUrl,
    downloadUrlExpiresAt: row.downloadUrlExpiresAt?.toISOString() ?? null,
    downloadedAt: row.downloadedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
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
