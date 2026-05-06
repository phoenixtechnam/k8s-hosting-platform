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
  readScheduledBackup,
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
      const [cr, sb] = await Promise.all([
        readClusterCR(k8s, c.clusterNamespace, c.clusterName),
        readScheduledBackup(k8s, c.clusterNamespace, c.clusterName),
      ]);
      const status = extractStatus(cr);
      const crHasBackup = Boolean(cr?.spec?.backup?.barmanObjectStore?.destinationPath);
      const dbEnabled = state !== undefined;
      const baseBackupStatus = sb
        ? {
            lastScheduleTime: sb.status?.lastScheduleTime ?? null,
            nextScheduleTime: sb.status?.nextScheduleTime ?? null,
          }
        : null;
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
              archiveTimeout: state.archiveTimeout ?? null,
              baseBackupSchedule: state.baseBackupSchedule ?? null,
              baseBackupRetentionDays: state.baseBackupRetentionDays ?? null,
              baseBackupStatus,
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
        archiveTimeout: parsed.data.archiveTimeout,
        baseBackupSchedule: parsed.data.baseBackupSchedule ?? null,
        baseBackupRetentionDays: parsed.data.baseBackupRetentionDays,
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

  // ── POST /system-backup/wal-archive/pitr-recipe ────────────────
  // Returns the recipe for an operator-driven PITR. Builds a CNPG
  // Cluster CR yaml the operator can apply to a target namespace
  // (or send to bootstrap.sh on a fresh cluster). Phase 5 DR drill
  // automates the full apply+wait+swap sequence.
  app.post('/system-backup/wal-archive/pitr-recipe', {
    schema: {
      tags: ['SystemBackup'],
      summary: 'Build a CNPG recovery Cluster CR yaml for PITR (super_admin)',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const body = request.body as {
      clusterNamespace?: string;
      clusterName?: string;
      targetTime?: string;            // ISO 8601 ("latest" if omitted)
      recoveryClusterName?: string;
    } | null;
    const ns = String(body?.clusterNamespace ?? '');
    const name = String(body?.clusterName ?? '');
    if (!isKnownCluster(ns, name)) {
      throw new ApiError('SYSTEM_WAL_UNKNOWN_CLUSTER',
        `${ns}/${name} is not a known system cluster`, 400);
    }
    const states = await app.db.select().from(systemWalArchiveState);
    const state = states.find((s) => s.clusterNamespace === ns && s.clusterName === name);
    if (!state) {
      throw new ApiError('SYSTEM_WAL_DISABLED',
        'WAL archive not enabled for this cluster — nothing to recover from', 400);
    }
    // recoveryClusterName is freeform input → MUST be a DNS label
    // before we interpolate it into YAML. The default we generate is
    // already DNS-label-shaped (no operator input).
    const dnsLabel = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
    const defaultName = `${name}-rec-${Date.now()}`.slice(0, 63);
    const recoveryName = (() => {
      const v = body?.recoveryClusterName;
      if (typeof v !== 'string' || v.length === 0) return defaultName;
      if (v.length > 63 || !dnsLabel.test(v)) {
        throw new ApiError('SYSTEM_WAL_BAD_REQUEST',
          'recoveryClusterName must be a lowercase DNS label (1-63 chars)', 400);
      }
      return v;
    })();
    // targetTime: ISO 8601 only — restrict shape so it can't break YAML quoting.
    const isoRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})$/;
    const targetTime = (() => {
      const v = body?.targetTime;
      if (typeof v !== 'string' || v.length === 0) return null;
      if (!isoRe.test(v)) {
        throw new ApiError('SYSTEM_WAL_BAD_REQUEST',
          'targetTime must be an ISO 8601 datetime', 400);
      }
      return v;
    })();

    const yaml = [
      `# Apply with: kubectl apply -f <this-file>`,
      `# CNPG will provision a fresh cluster that replays WAL from S3`,
      `# until ${targetTime ? `target time ${targetTime}` : 'the latest archived WAL'}.`,
      `apiVersion: postgresql.cnpg.io/v1`,
      `kind: Cluster`,
      `metadata:`,
      `  name: ${recoveryName}`,
      `  namespace: ${ns}`,
      `spec:`,
      `  instances: 1`,
      `  imageName: ghcr.io/cloudnative-pg/postgresql:17.5`,
      `  bootstrap:`,
      `    recovery:`,
      `      source: ${name}`,
      ...(targetTime ? [`      recoveryTarget:`, `        targetTime: "${targetTime}"`] : []),
      `  externalClusters:`,
      `    - name: ${name}`,
      `      barmanObjectStore:`,
      `        destinationPath: ${state.destinationPath}`,
      `        s3Credentials:`,
      `          accessKeyId:`,
      `            name: backup-credentials`,
      `            key: AWS_ACCESS_KEY_ID`,
      `          secretAccessKey:`,
      `            name: backup-credentials`,
      `            key: AWS_SECRET_ACCESS_KEY`,
      `        wal:`,
      `          compression: gzip`,
      `        data:`,
      `          compression: gzip`,
      `  storage:`,
      `    size: 5Gi`,
      `    storageClass: longhorn-system-local`,
    ].join('\n');

    return success({
      recoveryClusterName: recoveryName,
      namespace: ns,
      targetTime,
      destinationPath: state.destinationPath,
      yaml,
      note: 'Apply + watch the new Cluster come up. Phase 5 DR drill will automate this.',
    });
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
