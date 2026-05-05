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
import { systemBackupRuns } from '../../db/schema.js';
import { desc, eq } from 'drizzle-orm';
import {
  exportSecretsBundleRequestSchema,
  type ExportSecretsBundleResponse,
  type SystemBackupRun,
  type SecretsBundleManifestResponse,
} from '@k8s-hosting/api-contracts';
import {
  createSecretsBundleExport,
  pendingTokenForRun,
  claimDownloadToken,
  readManifest,
} from './service.js';

export async function systemBackupRoutes(app: FastifyInstance): Promise<void> {
  // The download route bypasses auth (token IS the credential), so it
  // is registered FIRST without the auth hook. Subsequent routes
  // inherit the auth hooks via app.addHook('onRequest', ...) below.
  //
  // Fastify hooks added after a route registration do NOT apply to
  // that route — exactly the property we need here.

  // ── GET /system-backup/secrets/download/:token ────────────────────
  // Single-use, HMAC-signed, no Bearer auth. Token IS the auth.
  app.get('/system-backup/secrets/download/:token', {
    schema: {
      tags: ['SystemBackup'],
      summary: 'Single-use bundle download (HMAC token IS auth)',
    },
  }, async (request, reply) => {
    const { token } = request.params as { token: string };
    if (!token || token.length < 80 || token.length > 256) {
      throw new ApiError('SYSTEM_BACKUP_INVALID_TOKEN', 'invalid token format', 400);
    }
    const claim = await claimDownloadToken(app.db, token);
    if (!claim) {
      // Distinguish four cases would leak: doesn't exist vs expired vs
      // already-used vs bad mac. Return a single 410 with no detail.
      throw new ApiError('SYSTEM_BACKUP_TOKEN_INVALID',
        'download token is invalid, expired, or already used', 410);
    }
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

  const jwtSecret = (app.config as Record<string, unknown>).JWT_SECRET as string | undefined ?? process.env.JWT_SECRET;
  if (!jwtSecret || jwtSecret.length < 32) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('system-backup: JWT_SECRET must be set (≥32 chars) for download-token HMAC');
    }
    app.log.warn('system-backup: JWT_SECRET missing/short — download tokens will fail in production');
  }
  const effectiveJwtSecret = jwtSecret && jwtSecret.length >= 32 ? jwtSecret : '0'.repeat(64);

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
    if (!userId) {
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
      .select()
      .from(systemBackupRuns)
      .where(eq(systemBackupRuns.kind, 'secrets'))
      .orderBy(desc(systemBackupRuns.createdAt))
      .limit(limit);
    return success(rows.map((r) => toApiRun(r, /*includeFreshDownload*/ false)));
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
      .select()
      .from(systemBackupRuns)
      .where(eq(systemBackupRuns.id, id))
      .limit(1);
    const row = rows[0];
    if (!row || row.kind !== 'secrets') {
      throw new ApiError('SYSTEM_BACKUP_RUN_NOT_FOUND', 'run not found', 404);
    }
    return success(toApiRun(row, /*includeFreshDownload*/ true));
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
  payload: Buffer | null;
  downloadTokenHash: string | null;
  downloadUrlExpiresAt: Date | null;
  downloadedAt: Date | null;
  createdAt: Date;
}

function toApiRun(row: SystemBackupRunRow, includeFreshDownload: boolean): SystemBackupRun {
  // Build the download URL only on the GET-by-id path AND only when
  // the unhashed token is still in our in-process map. List endpoints
  // never surface the URL — even rapid double-fetches by the same
  // operator can't accidentally consume the one-shot.
  let downloadUrl: string | null = null;
  if (
    includeFreshDownload
    && row.status === 'succeeded'
    && row.downloadedAt === null
    && row.downloadUrlExpiresAt
    && row.downloadUrlExpiresAt.getTime() > Date.now()
  ) {
    const pending = pendingTokenForRun(row.id);
    if (pending) {
      downloadUrl = `/api/v1/system-backup/secrets/download/${pending.token}`;
    }
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
