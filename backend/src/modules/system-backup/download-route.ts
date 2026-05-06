/**
 * Public, single-use bundle download — `GET /api/v1/system-backup/secrets/download/:token`.
 *
 * Mirrors the tenant-bundles internal-download-route pattern: the route
 * lives in its OWN Fastify plugin file with NO addHook('onRequest',
 * authenticate). The HMAC-signed token in the path IS the
 * credential. We don't put it in the main system-backup routes.ts
 * because mixing auth-gated and ungated routes in the same plugin
 * makes the auth boundary harder to reason about — and in practice
 * Fastify hook ordering can surprise you.
 *
 * Token format + verification + atomic single-use claim are in
 * service.ts:claimDownloadToken; we only own the HTTP shell here.
 */

import type { FastifyInstance } from 'fastify';
import { ApiError } from '../../shared/errors.js';
import { auditLogs } from '../../db/schema.js';
import { randomUUID } from 'node:crypto';
import { claimDownloadToken } from './service.js';

export async function systemBackupDownloadRoutes(app: FastifyInstance): Promise<void> {
  // Fail-closed JWT_SECRET — same check as the auth-gated module so
  // both halves of System Backup refuse to boot without a real key.
  const jwtSecret = (app.config as Record<string, unknown>).JWT_SECRET as string | undefined;
  if (!jwtSecret || jwtSecret.length < 32) {
    throw new Error('system-backup-download: app.config.JWT_SECRET must be set (≥32 chars)');
  }

  app.get('/system-backup/secrets/download/:token', {
    config: {
      // Per-route rate limit (10/min/IP). The endpoint is
      // unauthenticated — token IS auth — so global rate-limit
      // hooks don't necessarily reach it; explicit cap deters
      // token-fishing.
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
    const claim = await claimDownloadToken(app.db, token, jwtSecret);
    if (!claim) {
      await auditFailed(410, 'SYSTEM_BACKUP_TOKEN_INVALID');
      throw new ApiError('SYSTEM_BACKUP_TOKEN_INVALID',
        'download token is invalid, expired, or already used', 410);
    }

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
}

function clientIp(request: { headers: Record<string, string | string[] | undefined>; ip?: string }): string | null {
  const xff = (request.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim();
  return xff || request.ip || null;
}
