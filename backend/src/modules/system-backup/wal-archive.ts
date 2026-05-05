/**
 * System Backup Phase 4 — WAL archive runtime config.
 *
 * Toggles CNPG `spec.backup.barmanObjectStore` per cluster from the
 * admin UI. Operator picks an existing S3 backup_configurations row
 * as the destination; CNPG uses barman-cloud to stream WAL + base
 * backups continuously.
 *
 * Cred mirroring is already handled by
 * backend/src/modules/backup-config/longhorn-reconciler.ts which
 * mirrors the active S3 config into:
 *   - longhorn-system/longhorn-backup-credentials
 *   - platform/backup-credentials
 *   - mail/backup-credentials
 * with keys AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY. Our barman
 * config refers to that Secret by name + key — no separate Secret
 * materialisation needed here.
 *
 * SFTP/SSH targets are NOT supported — CNPG barman-cloud only speaks
 * S3. We filter at validation time and the UI hides those rows.
 */

import { eq, and } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { backupConfigurations, systemWalArchiveState, auditLogs } from '../../db/schema.js';
import { MERGE_PATCH } from '../../shared/k8s-patch.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { randomUUID } from 'node:crypto';

export const CNPG_GROUP = 'postgresql.cnpg.io';
export const CNPG_VERSION = 'v1';
const BACKUP_CREDENTIALS_SECRET = 'backup-credentials';

export interface EnableWalArchiveInput {
  readonly db: Database;
  readonly k8s: K8sClients;
  readonly clusterNamespace: string;
  readonly clusterName: string;
  readonly targetConfigId: string;
  readonly retentionDays: number;
  readonly operatorUserId: string;
  readonly operatorIp: string | null;
}

export interface DisableWalArchiveInput {
  readonly db: Database;
  readonly k8s: K8sClients;
  readonly clusterNamespace: string;
  readonly clusterName: string;
  readonly operatorUserId: string;
  readonly operatorIp: string | null;
}

interface BackupConfigForWal {
  readonly id: string;
  readonly storageType: string;
  readonly s3Bucket: string | null;
  readonly s3Prefix: string | null;
  readonly s3Endpoint: string | null;
  readonly s3Region: string | null;
  readonly active: boolean | null;
  readonly name: string | null;
}

async function loadActiveS3Target(
  db: Database, targetConfigId: string,
): Promise<BackupConfigForWal> {
  const rows = await db
    .select({
      id: backupConfigurations.id,
      storageType: backupConfigurations.storageType,
      s3Bucket: backupConfigurations.s3Bucket,
      s3Prefix: backupConfigurations.s3Prefix,
      s3Endpoint: backupConfigurations.s3Endpoint,
      s3Region: backupConfigurations.s3Region,
      active: backupConfigurations.active,
      name: backupConfigurations.name,
    })
    .from(backupConfigurations)
    .where(eq(backupConfigurations.id, targetConfigId))
    .limit(1);
  const cfg = rows[0];
  if (!cfg) throw new Error(`backup_configurations row ${targetConfigId} not found`);
  if (!cfg.active) throw new Error(`backup_configurations row ${targetConfigId} is not active — activate it via /admin/backup-configs/:id/activate first`);
  if (cfg.storageType !== 's3') {
    throw new Error(`backup_configurations row ${targetConfigId} is storageType=${cfg.storageType}; CNPG barman-cloud only supports s3`);
  }
  if (!cfg.s3Bucket) throw new Error(`backup_configurations row ${targetConfigId} has no s3_bucket`);
  return cfg;
}

/**
 * Build the destination path under the operator's bucket. Mirrors the
 * scheme used elsewhere in System Backup: `<prefix>/wal-archive/<ns>-<cluster>/`
 * so multiple clusters can share a target without collision.
 */
export function buildDestinationPath(cfg: BackupConfigForWal, ns: string, cluster: string): string {
  const cleanPrefix = (cfg.s3Prefix ?? '').replace(/^\/+|\/+$/g, '');
  const segment = cleanPrefix ? `${cleanPrefix}/wal-archive/${ns}-${cluster}` : `wal-archive/${ns}-${cluster}`;
  return `s3://${cfg.s3Bucket}/${segment}`;
}

interface ClusterStatus {
  readonly firstRecoverabilityPoint: string | null;
  readonly lastArchivedWal: string | null;
  readonly lastArchivedWalTime: string | null;
  readonly lastFailedArchiveTime: string | null;
  readonly lastFailedArchiveError: string | null;
}

interface ClusterCRSpec {
  readonly spec?: {
    readonly backup?: {
      readonly barmanObjectStore?: { readonly destinationPath?: string };
    };
  };
  readonly status?: {
    readonly firstRecoverabilityPoint?: string;
    readonly lastArchivedWAL?: string;
    readonly lastArchivedWALTime?: string;
    readonly lastFailedArchiveTime?: string;
    readonly conditions?: ReadonlyArray<{ type?: string; reason?: string; message?: string }>;
  };
}

export async function readClusterCR(
  k8s: K8sClients, namespace: string, name: string,
): Promise<ClusterCRSpec | null> {
  try {
    const custom = k8s.custom as unknown as {
      getNamespacedCustomObject: (a: {
        group: string; version: string; namespace: string; plural: string; name: string;
      }) => Promise<ClusterCRSpec>;
    };
    return await custom.getNamespacedCustomObject({
      group: CNPG_GROUP, version: CNPG_VERSION, namespace, plural: 'clusters', name,
    });
  } catch {
    return null;
  }
}

export function extractStatus(cr: ClusterCRSpec | null): ClusterStatus | null {
  if (!cr) return null;
  const s = cr.status ?? {};
  const archiveCondition = (s.conditions ?? []).find((c) => c.type === 'ContinuousArchiving');
  return {
    firstRecoverabilityPoint: s.firstRecoverabilityPoint ?? null,
    lastArchivedWal: s.lastArchivedWAL ?? null,
    lastArchivedWalTime: s.lastArchivedWALTime ?? null,
    lastFailedArchiveTime: s.lastFailedArchiveTime ?? null,
    lastFailedArchiveError: archiveCondition?.reason === 'ContinuousArchivingFailing'
      ? (archiveCondition.message ?? null)
      : null,
  };
}

/**
 * Patch the CNPG Cluster CR to enable WAL archive. Uses MERGE_PATCH —
 * we only set the `spec.backup` subtree, Flux owns the rest. Disable
 * passes `spec.backup: null` to remove the field cleanly.
 */
async function patchClusterBackupConfig(
  k8s: K8sClients,
  namespace: string,
  name: string,
  body: Record<string, unknown>,
): Promise<void> {
  await (k8s.custom as unknown as {
    patchNamespacedCustomObject: (a: {
      group: string; version: string; namespace: string; plural: string; name: string; body: unknown;
    }, opts?: unknown) => Promise<unknown>;
  }).patchNamespacedCustomObject({
    group: CNPG_GROUP, version: CNPG_VERSION, namespace, plural: 'clusters', name, body,
  }, MERGE_PATCH);
}

export async function enableWalArchive(input: EnableWalArchiveInput): Promise<{ destinationPath: string }> {
  const { db, k8s, clusterNamespace, clusterName, targetConfigId, retentionDays, operatorUserId, operatorIp } = input;

  // Validate the cluster exists before we touch anything else.
  const cr = await readClusterCR(k8s, clusterNamespace, clusterName);
  if (!cr) throw new Error(`CNPG cluster ${clusterNamespace}/${clusterName} not found`);

  const cfg = await loadActiveS3Target(db, targetConfigId);
  const destinationPath = buildDestinationPath(cfg, clusterNamespace, clusterName);

  const patch = {
    spec: {
      backup: {
        retentionPolicy: `${retentionDays}d`,
        barmanObjectStore: {
          destinationPath,
          ...(cfg.s3Endpoint ? { endpointURL: cfg.s3Endpoint } : {}),
          s3Credentials: {
            accessKeyId: { name: BACKUP_CREDENTIALS_SECRET, key: 'AWS_ACCESS_KEY_ID' },
            secretAccessKey: { name: BACKUP_CREDENTIALS_SECRET, key: 'AWS_SECRET_ACCESS_KEY' },
          },
          wal: { compression: 'gzip' },
          data: { compression: 'gzip' },
        },
      },
    },
  };

  // Order: patch CR first, then write DB. If the DB tx fails after a
  // successful CR patch, the cross-check in GET /wal-archive/clusters
  // (`enabled = dbEnabled && crHasBackup`) will surface the resulting
  // drift as `enabled=false, state=null` — operator sees the
  // inconsistency and can either disable (CR cleanup) or re-enable
  // (re-runs DB write). Reverse order would orphan a state row
  // pointing at a CR that was never patched.
  await patchClusterBackupConfig(k8s, clusterNamespace, clusterName, patch);

  await db.transaction(async (tx) => {
    await tx
      .insert(systemWalArchiveState)
      .values({
        clusterNamespace,
        clusterName,
        targetConfigId,
        retentionDays,
        destinationPath,
        operatorUserId,
      })
      .onConflictDoUpdate({
        target: [systemWalArchiveState.clusterNamespace, systemWalArchiveState.clusterName],
        set: {
          targetConfigId,
          retentionDays,
          destinationPath,
          operatorUserId,
          enabledAt: new Date(),
        },
      });
    await tx.insert(auditLogs).values({
      id: randomUUID(),
      actionType: 'system_wal_archive_enable',
      resourceType: 'cnpg_cluster',
      resourceId: `${clusterNamespace}/${clusterName}`,
      actorId: operatorUserId,
      actorType: 'user',
      httpMethod: 'POST',
      httpPath: '/api/v1/system-backup/wal-archive/enable',
      httpStatus: 200,
      changes: { targetConfigId, retentionDays, destinationPath },
      ipAddress: operatorIp ?? null,
    });
  });

  return { destinationPath };
}

export async function disableWalArchive(input: DisableWalArchiveInput): Promise<void> {
  const { db, k8s, clusterNamespace, clusterName, operatorUserId, operatorIp } = input;
  const cr = await readClusterCR(k8s, clusterNamespace, clusterName);
  if (!cr) throw new Error(`CNPG cluster ${clusterNamespace}/${clusterName} not found`);

  // RFC 7396 merge: setting a field to null removes it. We strip the
  // entire spec.backup so disable returns the CR to default (no backup).
  const patch = { spec: { backup: null } };
  await patchClusterBackupConfig(k8s, clusterNamespace, clusterName, patch);

  await db.transaction(async (tx) => {
    await tx
      .delete(systemWalArchiveState)
      .where(and(
        eq(systemWalArchiveState.clusterNamespace, clusterNamespace),
        eq(systemWalArchiveState.clusterName, clusterName),
      ));
    await tx.insert(auditLogs).values({
      id: randomUUID(),
      actionType: 'system_wal_archive_disable',
      resourceType: 'cnpg_cluster',
      resourceId: `${clusterNamespace}/${clusterName}`,
      actorId: operatorUserId,
      actorType: 'user',
      httpMethod: 'POST',
      httpPath: '/api/v1/system-backup/wal-archive/disable',
      httpStatus: 200,
      changes: null,
      ipAddress: operatorIp ?? null,
    });
  });
}
