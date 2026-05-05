/**
 * Phase 4 — WAL archive routes (super_admin only).
 *
 *   GET  /api/v1/system-backup/wal-archive/clusters
 *   POST /api/v1/system-backup/wal-archive/enable
 *   POST /api/v1/system-backup/wal-archive/disable
 *
 * Two known clusters are listed by default (platform/postgres,
 * mail/mail-pg). The list endpoint augments DB intent with a
 * snapshot of the CNPG CR's `.status` so operators see the actual
 * archive health (last archived WAL, errors).
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authenticate, requireRole, requirePanel } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { backupConfigurations, systemWalArchiveState } from '../../db/schema.js';
import { inArray } from 'drizzle-orm';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import {
  walArchiveEnableRequestSchema,
  walArchiveDisableRequestSchema,
  type WalArchiveActionResponse,
  type WalArchiveCluster,
  type WalArchiveListResponse,
} from '@k8s-hosting/api-contracts';
import {
  enableWalArchive,
  disableWalArchive,
  readClusterCR,
  extractStatus,
} from './wal-archive.js';

// Hardcoded list — same as the SystemDatabasesTab. Two known system
// CNPG clusters; new clusters added here when the platform grows.
const KNOWN_CLUSTERS = [
  { clusterNamespace: 'platform', clusterName: 'postgres' },
  { clusterNamespace: 'mail',     clusterName: 'mail-pg' },
] as const;

export async function systemBackupWalArchiveRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requirePanel('admin'));
  app.addHook('onRequest', requireRole('super_admin'));

  // ── GET /system-backup/wal-archive/clusters ────────────────────
  app.get('/system-backup/wal-archive/clusters', {
    schema: {
      tags: ['SystemBackup'],
      summary: 'List system CNPG clusters with WAL archive state + status',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const k8s = createK8sClients();

    const states = await app.db.select().from(systemWalArchiveState);
    const stateByKey = new Map<string, typeof states[number]>(
      states.map((s) => [`${s.clusterNamespace}/${s.clusterName}`, s]),
    );

    // Resolve target names in one query (small list).
    const targetIds = [...new Set(states.map((s) => s.targetConfigId))];
    const targets = targetIds.length > 0
      ? await app.db
        .select({ id: backupConfigurations.id, name: backupConfigurations.name })
        .from(backupConfigurations)
        .where(inArray(backupConfigurations.id, targetIds))
      : [];
    const nameById = new Map(targets.map((t) => [t.id, t.name] as const));

    const out: WalArchiveCluster[] = await Promise.all(KNOWN_CLUSTERS.map(async (c) => {
      const key = `${c.clusterNamespace}/${c.clusterName}`;
      const state = stateByKey.get(key);
      const cr = await readClusterCR(k8s, c.clusterNamespace, c.clusterName);
      const status = extractStatus(cr);
      // Cross-check: `enabled` is true only when BOTH the DB row
      // AND the CR's spec.backup.barmanObjectStore exist. This catches
      // out-of-band CR edits (e.g. someone removed the section via
      // Flux) so the UI doesn't lie about the archive being on.
      const crHasBackup = Boolean(cr?.spec?.backup?.barmanObjectStore?.destinationPath);
      const dbEnabled = state !== undefined;
      return {
        clusterNamespace: c.clusterNamespace,
        clusterName: c.clusterName,
        enabled: dbEnabled && crHasBackup,
        state: state
          ? {
              targetConfigId: state.targetConfigId,
              targetName: nameById.get(state.targetConfigId) ?? null,
              retentionDays: state.retentionDays,
              destinationPath: state.destinationPath,
              enabledAt: state.enabledAt.toISOString(),
            }
          : null,
        status,
      };
    }));

    return success<WalArchiveListResponse>(out);
  });

  // ── POST /system-backup/wal-archive/enable ─────────────────────
  app.post('/system-backup/wal-archive/enable', {
    schema: {
      tags: ['SystemBackup'],
      summary: 'Turn on continuous WAL archive for a CNPG cluster',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const parsed = walArchiveEnableRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError('SYSTEM_WAL_BAD_REQUEST', parsed.error.message, 400);
    }
    const userId = (request.user as { sub?: string } | undefined)?.sub;
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new ApiError('UNAUTHENTICATED', 'no user id in token', 401);
    }
    if (!isKnownCluster(parsed.data.clusterNamespace, parsed.data.clusterName)) {
      throw new ApiError('SYSTEM_WAL_UNKNOWN_CLUSTER',
        `${parsed.data.clusterNamespace}/${parsed.data.clusterName} is not a known system cluster`, 400);
    }

    try {
      const result = await enableWalArchive({
        db: app.db,
        k8s: createK8sClients(),
        clusterNamespace: parsed.data.clusterNamespace,
        clusterName: parsed.data.clusterName,
        targetConfigId: parsed.data.targetConfigId,
        retentionDays: parsed.data.retentionDays,
        operatorUserId: userId,
        operatorIp: clientIp(request),
      });
      return success<WalArchiveActionResponse>({
        clusterNamespace: parsed.data.clusterNamespace,
        clusterName: parsed.data.clusterName,
        enabled: true,
        destinationPath: result.destinationPath,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ApiError('SYSTEM_WAL_ENABLE_FAILED', msg, 500);
    }
  });

  // ── POST /system-backup/wal-archive/disable ────────────────────
  app.post('/system-backup/wal-archive/disable', {
    schema: {
      tags: ['SystemBackup'],
      summary: 'Turn off continuous WAL archive for a CNPG cluster',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const parsed = walArchiveDisableRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError('SYSTEM_WAL_BAD_REQUEST', parsed.error.message, 400);
    }
    const userId = (request.user as { sub?: string } | undefined)?.sub;
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new ApiError('UNAUTHENTICATED', 'no user id in token', 401);
    }
    if (!isKnownCluster(parsed.data.clusterNamespace, parsed.data.clusterName)) {
      throw new ApiError('SYSTEM_WAL_UNKNOWN_CLUSTER',
        `${parsed.data.clusterNamespace}/${parsed.data.clusterName} is not a known system cluster`, 400);
    }

    try {
      await disableWalArchive({
        db: app.db,
        k8s: createK8sClients(),
        clusterNamespace: parsed.data.clusterNamespace,
        clusterName: parsed.data.clusterName,
        operatorUserId: userId,
        operatorIp: clientIp(request),
      });
      return success<WalArchiveActionResponse>({
        clusterNamespace: parsed.data.clusterNamespace,
        clusterName: parsed.data.clusterName,
        enabled: false,
        destinationPath: null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ApiError('SYSTEM_WAL_DISABLE_FAILED', msg, 500);
    }
  });

}

function isKnownCluster(ns: string, name: string): boolean {
  return KNOWN_CLUSTERS.some((c) => c.clusterNamespace === ns && c.clusterName === name);
}

// Fastify is configured with trustProxy globally, so request.ip is
// already the real client IP (last hop outside trustProxy chain).
// Don't re-parse X-Forwarded-For — that would re-introduce a spoofing
// surface for super_admins manipulating their own audit trail.
function clientIp(request: FastifyRequest): string | null {
  return request.ip || null;
}
