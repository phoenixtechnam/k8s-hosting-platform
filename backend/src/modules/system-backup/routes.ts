/**
 * System Backup, Phase 1 routes (admin-gated half).
 *
 * Every route here requires super_admin. The unauthenticated download
 * endpoint lives in download-route.ts as a sibling Fastify plugin —
 * see that file for why splitting was necessary.
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
  addAllowlistEntryRequestSchema,
  recordDrDrillRunRequestSchema,
  type SecretsAuditResponse,
  type ListAllowlistResponse,
  type ListDrDrillRunsResponse,
  type DrDrillSummaryResponse,
} from '@k8s-hosting/api-contracts';
import {
  createSecretsBundleExport,
  readManifest,
} from './service.js';
import {
  invalidateAuditCache,
  readAllowlist,
  removeAllowlistEntry,
  runSecretsAudit,
  upsertAllowlistEntry,
} from './secrets-audit.js';
import {
  getDrDrillSummary,
  listDrDrillRuns,
  recordDrDrillRun,
} from './dr-drill-runs.js';

export async function systemBackupRoutes(app: FastifyInstance): Promise<void> {
  // Fail-closed on missing/short JWT_SECRET — without this, download
  // tokens would be signed with a weak/predictable key. Read from
  // app.config (the same auth source the rest of the app uses).
  const jwtSecret = (app.config as Record<string, unknown>).JWT_SECRET as string | undefined;
  if (!jwtSecret || jwtSecret.length < 32) {
    throw new Error('system-backup: app.config.JWT_SECRET must be set (≥32 chars) for download-token HMAC');
  }
  const effectiveJwtSecret = jwtSecret;

  // All routes in this plugin require super_admin + admin panel. The
  // download route is in a separate plugin (download-route.ts) so we
  // don't need to thread auth-bypass logic here.
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requirePanel('admin'));
  app.addHook('onRequest', requireRole('super_admin'));

  // Build K8sClients once per request (cheap; tenants are pooled
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
        operatorIp: tenantIp(request),
        operatorUserAgent: tenantUa(request),
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
  // could return up to 100 rows × ~100 KiB encrypted bytes that are
  // never serialised to the wire but WOULD be deserialised into the
  // Drizzle result.
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

  // ─── Secrets coverage audit (DR-bundle Phase 0) ──────────────────
  app.get('/system-backup/secrets-audit', {
    schema: {
      tags: ['SystemBackup'],
      summary: 'Differential audit: every cluster Secret → coverage category',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const data = await runSecretsAudit(k8sFactory());
    return success<SecretsAuditResponse['data']>(data);
  });

  app.post('/system-backup/secrets-audit/refresh', {
    schema: {
      tags: ['SystemBackup'],
      summary: 'Bust the audit cache + recompute on next read',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const userId = (request.user as { sub?: string } | undefined)?.sub ?? 'unknown';
    app.log.warn({ userId }, 'secrets-audit: cache refresh requested');
    invalidateAuditCache();
    const data = await runSecretsAudit(k8sFactory(), { useCache: false });
    return success<SecretsAuditResponse['data']>(data);
  });

  app.get('/system-backup/secrets-audit/allowlist', {
    schema: {
      tags: ['SystemBackup'],
      summary: 'List entries in the secrets-audit-allowlist ConfigMap',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const entries = await readAllowlist(k8sFactory());
    return success<ListAllowlistResponse['data']>({ entries });
  });

  app.post('/system-backup/secrets-audit/allowlist', {
    schema: {
      tags: ['SystemBackup'],
      summary: 'Add (or update reason for) an allowlist entry',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const parsed = addAllowlistEntryRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError('SYSTEM_BACKUP_BAD_REQUEST', parsed.error.message, 400);
    }
    const userId = (request.user as { sub?: string } | undefined)?.sub;
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new ApiError('UNAUTHENTICATED', 'no user id in token', 401);
    }
    app.log.warn(
      { userId, namespace: parsed.data.namespace, name: parsed.data.name },
      'secrets-audit: allowlist entry added',
    );
    const entries = await upsertAllowlistEntry(k8sFactory(), {
      namespace: parsed.data.namespace,
      name: parsed.data.name,
      reason: parsed.data.reason,
      addedBy: userId,
    });
    return success<ListAllowlistResponse['data']>({ entries });
  });

  app.delete<{ Params: { namespace: string; name: string } }>(
    '/system-backup/secrets-audit/allowlist/:namespace/:name',
    {
      schema: {
        tags: ['SystemBackup'],
        summary: 'Remove an allowlist entry',
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => {
      const { namespace, name } = request.params;
      if (!namespace || !name) {
        throw new ApiError('SYSTEM_BACKUP_BAD_REQUEST', 'namespace + name required', 400);
      }
      const userId = (request.user as { sub?: string } | undefined)?.sub ?? 'unknown';
      app.log.warn({ userId, namespace, name }, 'secrets-audit: allowlist entry removed');
      const entries = await removeAllowlistEntry(k8sFactory(), namespace, name);
      return success<ListAllowlistResponse['data']>({ entries });
    },
  );

  // ─── DR drill runs (DR-bundle Phase 1) ───────────────────────────
  app.get('/system-backup/dr-drill/runs', {
    schema: {
      tags: ['SystemBackup'],
      summary: 'List recent DR drill executions',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const limit = Number((request.query as { limit?: string } | undefined)?.limit ?? '12');
    const data = await listDrDrillRuns(app.db, Number.isFinite(limit) ? limit : 12);
    return success<ListDrDrillRunsResponse['data']>(data);
  });

  app.get('/system-backup/dr-drill/summary', {
    schema: {
      tags: ['SystemBackup'],
      summary: 'DR drill rolling summary (pass rate, streak, last success/failure)',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const data = await getDrDrillSummary(app.db);
    return success<DrDrillSummaryResponse['data']>(data);
  });

  app.post('/system-backup/dr-drill/runs', {
    schema: {
      tags: ['SystemBackup'],
      summary: 'Webhook: CI posts drill results here',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const parsed = recordDrDrillRunRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError('SYSTEM_BACKUP_BAD_REQUEST', parsed.error.message, 400);
    }
    const userId = (request.user as { sub?: string } | undefined)?.sub ?? 'unknown';
    app.log.warn(
      { userId, drillId: parsed.data.id, status: parsed.data.status },
      'dr-drill: run recorded',
    );
    const run = await recordDrDrillRun(app.db, parsed.data);
    return success(run);
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
  sourceNamespace?: string | null;
  sourceCluster?: string | null;
  sourceDatabase?: string | null;
  targetConfigId?: string | null;
  bundleId?: string | null;
  artifactName?: string | null;
  jobName?: string | null;
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
    downloadUrl,
    downloadUrlExpiresAt: row.downloadUrlExpiresAt?.toISOString() ?? null,
    downloadedAt: row.downloadedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    sourceNamespace: row.sourceNamespace ?? null,
    sourceCluster: row.sourceCluster ?? null,
    sourceDatabase: row.sourceDatabase ?? null,
    targetConfigId: row.targetConfigId ?? null,
    bundleId: row.bundleId ?? null,
    artifactName: row.artifactName ?? null,
    jobName: row.jobName ?? null,
  };
}

function tenantIp(request: FastifyRequest): string | null {
  const xff = (request.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim();
  return xff || request.ip || null;
}

function tenantUa(request: FastifyRequest): string | null {
  const ua = request.headers['user-agent'];
  if (typeof ua === 'string') return ua.slice(0, 500);
  return null;
}
