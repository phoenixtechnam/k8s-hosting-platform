/**
 * System Backup Phase 4 — WAL archive runtime config (Barman Cloud Plugin).
 *
 * Toggles WAL archiving for a CNPG cluster from the admin UI by
 * orchestrating the cnpg-i `barman-cloud.cloudnative-pg.io` plugin.
 *
 * Plugin model (replaces the deprecated in-tree `spec.backup.barmanObjectStore`):
 *   1. ObjectStore CR (group `barmancloud.cnpg.io/v1`) holds the S3
 *      destination + credentials + retention policy.
 *   2. The Cluster CR's `spec.plugins[]` lists `barman-cloud.cloudnative-pg.io`
 *      with `parameters.barmanObjectName: <ObjectStore.metadata.name>` and
 *      `isWALArchiver: true` — this wires the plugin in as the active
 *      WAL archiver.
 *   3. ScheduledBackup CR uses `method: plugin` + `pluginConfiguration.name:
 *      barman-cloud.cloudnative-pg.io` for periodic base backups.
 *
 * In-tree `spec.backup.barmanObjectStore` was deprecated in CNPG 1.26 and
 * is scheduled for removal in 1.30. The new path is also the only one that
 * works with the `minimal-trixie` / `standard-trixie` operand images we
 * adopted on 2026-05-07 (those images do NOT bundle barman-cloud binaries —
 * the plugin runs them as a sidecar).
 *
 * Cred mirroring is unchanged from the in-tree era. backup-config/
 * longhorn-reconciler.ts mirrors the active S3 config Secret into the
 * cluster's namespace under name `backup-credentials` with keys
 * AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY. Both the ObjectStore CR
 * (here) and the legacy reconciler reference it by name.
 *
 * SFTP/SSH targets are NOT supported — barman-cloud only speaks S3.
 * We filter at validation time.
 */

import { eq, and, sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { backupConfigurations, systemWalArchiveState, auditLogs } from '../../db/schema.js';
import { MERGE_PATCH } from '../../shared/k8s-patch.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { randomUUID } from 'node:crypto';

export const CNPG_GROUP = 'postgresql.cnpg.io';
export const CNPG_VERSION = 'v1';
export const BARMAN_GROUP = 'barmancloud.cnpg.io';
export const BARMAN_VERSION = 'v1';
export const BARMAN_PLUGIN_NAME = 'barman-cloud.cloudnative-pg.io';
const BACKUP_CREDENTIALS_SECRET = 'backup-credentials';

// CR-naming scheme. `<cluster>-system-store` is the ObjectStore that
// pairs with `<cluster>-system-backup` (the ScheduledBackup CR). Both
// are owned by platform-api; a Flux-managed schedule (e.g. mail-pg-daily)
// lives alongside without colliding.
const OBJECT_STORE_NAME = (cluster: string): string => `${cluster}-system-store`;
const SCHEDULED_BACKUP_NAME = (cluster: string): string => `${cluster}-system-backup`;

export interface EnableWalArchiveInput {
  readonly db: Database;
  readonly k8s: K8sClients;
  readonly clusterNamespace: string;
  readonly clusterName: string;
  readonly targetConfigId: string;
  readonly retentionDays: number;
  readonly operatorUserId: string;
  readonly operatorIp: string | null;
  readonly archiveTimeout?: string;
  readonly baseBackupSchedule?: string | null;
  readonly baseBackupRetentionDays?: number;
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
    throw new Error(`backup_configurations row ${targetConfigId} is storageType=${cfg.storageType}; barman-cloud plugin only supports s3`);
  }
  if (!cfg.s3Bucket) throw new Error(`backup_configurations row ${targetConfigId} has no s3_bucket`);
  return cfg;
}

/**
 * Path scheme: `<prefix>/wal-archive/<ns>-<cluster>/`. Mirrors what
 * other System Backup features use so multiple clusters share a target
 * bucket without collision.
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

interface ClusterPluginEntry {
  readonly name?: string;
  readonly isWALArchiver?: boolean;
  readonly parameters?: Readonly<Record<string, string>>;
}

interface ClusterCRSpec {
  readonly spec?: {
    readonly plugins?: ReadonlyArray<ClusterPluginEntry>;
    readonly postgresql?: {
      readonly parameters?: Readonly<Record<string, string>>;
    };
  };
  readonly status?: {
    readonly firstRecoverabilityPoint?: string;
    readonly conditions?: ReadonlyArray<{ type?: string; status?: string; reason?: string; message?: string; lastTransitionTime?: string }>;
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
  // ContinuousArchiving is the operator-managed condition that surfaces
  // WAL-archive health. The plugin sets this same condition (verified
  // 2026-05-07 against barman-cloud plugin v0.12.0); the in-tree path
  // set it too. So this mapping is plugin-vs-in-tree agnostic.
  const cond = (s.conditions ?? []).find((c) => c.type === 'ContinuousArchiving');
  const isHealthy = cond?.status === 'True' || cond?.reason === 'ContinuousArchivingSuccess';
  const isFailing = cond?.status === 'False' || cond?.reason === 'ContinuousArchivingFailing';
  const transitionTime = cond?.lastTransitionTime ?? null;
  return {
    firstRecoverabilityPoint: s.firstRecoverabilityPoint ?? null,
    // Synthetic — represents archiving health, not a literal WAL filename.
    lastArchivedWal: isHealthy ? (cond?.reason ?? 'ContinuousArchivingSuccess') : null,
    lastArchivedWalTime: isHealthy ? transitionTime : null,
    lastFailedArchiveTime: isFailing ? transitionTime : null,
    lastFailedArchiveError: isFailing ? (cond?.message ?? cond?.reason ?? null) : null,
  };
}

// ─── ObjectStore CR helpers ──────────────────────────────────────────────────

interface ObjectStoreSpecConfig {
  destinationPath: string;
  endpointURL?: string;
  s3Credentials: {
    accessKeyId: { name: string; key: string };
    secretAccessKey: { name: string; key: string };
  };
  wal: { compression: 'gzip' };
  data: { compression: 'gzip' };
}

interface ObjectStoreBody {
  apiVersion: string;
  kind: 'ObjectStore';
  metadata: { name: string; namespace: string; labels?: Record<string, string> };
  spec: {
    configuration: ObjectStoreSpecConfig;
    retentionPolicy?: string;
  };
}

function buildObjectStoreBody(
  namespace: string, cluster: string,
  destinationPath: string, endpointURL: string | null,
  retentionDays: number,
): ObjectStoreBody {
  const config: ObjectStoreSpecConfig = {
    destinationPath,
    s3Credentials: {
      accessKeyId: { name: BACKUP_CREDENTIALS_SECRET, key: 'AWS_ACCESS_KEY_ID' },
      secretAccessKey: { name: BACKUP_CREDENTIALS_SECRET, key: 'AWS_SECRET_ACCESS_KEY' },
    },
    wal: { compression: 'gzip' },
    data: { compression: 'gzip' },
  };
  if (endpointURL) config.endpointURL = endpointURL;
  return {
    apiVersion: `${BARMAN_GROUP}/${BARMAN_VERSION}`,
    kind: 'ObjectStore',
    metadata: {
      name: OBJECT_STORE_NAME(cluster),
      namespace,
      labels: {
        'app.kubernetes.io/part-of': 'hosting-platform',
        'app.kubernetes.io/component': 'system-backup',
        'app.kubernetes.io/managed-by': 'platform-api',
      },
    },
    spec: {
      configuration: config,
      retentionPolicy: `${retentionDays}d`,
    },
  };
}

async function upsertObjectStore(
  k8s: K8sClients, namespace: string, cluster: string,
  destinationPath: string, endpointURL: string | null,
  retentionDays: number,
): Promise<void> {
  const custom = k8s.custom as unknown as {
    getNamespacedCustomObject: (a: { group: string; version: string; namespace: string; plural: string; name: string }) => Promise<unknown>;
    createNamespacedCustomObject: (a: { group: string; version: string; namespace: string; plural: string; body: unknown }) => Promise<unknown>;
    patchNamespacedCustomObject: (a: { group: string; version: string; namespace: string; plural: string; name: string; body: unknown }, opts?: unknown) => Promise<unknown>;
  };
  const name = OBJECT_STORE_NAME(cluster);
  const body = buildObjectStoreBody(namespace, cluster, destinationPath, endpointURL, retentionDays);

  let exists = true;
  try {
    await custom.getNamespacedCustomObject({
      group: BARMAN_GROUP, version: BARMAN_VERSION, namespace,
      plural: 'objectstores', name,
    });
  } catch (err: unknown) {
    const status = (err as { response?: { statusCode?: number }; code?: number })?.response?.statusCode
      ?? (err as { code?: number })?.code;
    if (status !== 404) throw err;
    exists = false;
  }
  if (exists) {
    // MERGE_PATCH on `spec` replaces the configuration + retentionPolicy
    // fields. Safe because we own this CR end-to-end.
    await custom.patchNamespacedCustomObject({
      group: BARMAN_GROUP, version: BARMAN_VERSION, namespace,
      plural: 'objectstores', name,
      body: { spec: body.spec },
    }, MERGE_PATCH);
    return;
  }
  try {
    await custom.createNamespacedCustomObject({
      group: BARMAN_GROUP, version: BARMAN_VERSION, namespace,
      plural: 'objectstores', body,
    });
  } catch (err: unknown) {
    // 409 = race with another concurrent enable. Re-patch.
    const status = (err as { response?: { statusCode?: number }; code?: number })?.response?.statusCode
      ?? (err as { code?: number })?.code;
    if (status !== 409) throw err;
    await custom.patchNamespacedCustomObject({
      group: BARMAN_GROUP, version: BARMAN_VERSION, namespace,
      plural: 'objectstores', name,
      body: { spec: body.spec },
    }, MERGE_PATCH);
  }
}

async function deleteObjectStoreIfPresent(
  k8s: K8sClients, namespace: string, cluster: string,
): Promise<void> {
  try {
    await (k8s.custom as unknown as {
      deleteNamespacedCustomObject: (a: { group: string; version: string; namespace: string; plural: string; name: string }) => Promise<unknown>;
    }).deleteNamespacedCustomObject({
      group: BARMAN_GROUP, version: BARMAN_VERSION, namespace,
      plural: 'objectstores', name: OBJECT_STORE_NAME(cluster),
    });
  } catch (err: unknown) {
    const status = (err as { response?: { statusCode?: number }; code?: number })?.response?.statusCode
      ?? (err as { code?: number })?.code;
    if (status === 404) return;
    throw err;
  }
}

// ─── Cluster CR plugin patch ─────────────────────────────────────────────────

/**
 * Patch the Cluster CR to add (or remove) the barman-cloud plugin entry
 * in `spec.plugins[]`. Read-modify-write so we DON'T clobber other
 * plugins or other Postgres GUCs.
 *
 * Why this matters:
 *   - `spec.plugins` is an array. JSON merge-patch on arrays REPLACES
 *     them. Without read-merge-write, enabling barman would silently
 *     drop any other plugin entry (e.g. a future audit plugin).
 *   - `spec.postgresql.parameters` is an object — JSON merge-patch on
 *     objects DOES merge keys, BUT setting `parameters: {archive_timeout: X}`
 *     replaces only that one key cleanly. PROBLEM: if we set `parameters`
 *     to a partial map AND the existing CR omits some keys we want to
 *     preserve, MERGE_PATCH replaces the WHOLE `parameters` map. Read-
 *     merge-write keeps existing GUCs (max_connections, shared_buffers,
 *     etc.) intact.
 *
 * Caller passes `existingCR` (already read in `enableWalArchive`/
 * `disableWalArchive`) so we don't double-fetch.
 */
async function patchClusterPlugin(
  k8s: K8sClients,
  namespace: string,
  cluster: string,
  existingCR: ClusterCRSpec,
  enable: boolean,
  archiveTimeout?: string,
): Promise<void> {
  // Merge plugins: keep entries with name !== BARMAN_PLUGIN_NAME, then
  // (when enabling) append our entry.
  const otherPlugins = (existingCR.spec?.plugins ?? [])
    .filter((p) => p.name !== BARMAN_PLUGIN_NAME);
  const mergedPlugins: ClusterPluginEntry[] = enable
    ? [...otherPlugins, {
        name: BARMAN_PLUGIN_NAME,
        isWALArchiver: true,
        parameters: { barmanObjectName: OBJECT_STORE_NAME(cluster) },
      }]
    : [...otherPlugins];

  const spec: Record<string, unknown> = { plugins: mergedPlugins };

  if (archiveTimeout) {
    // Merge into existing parameters so unrelated GUCs survive.
    const existingParams = existingCR.spec?.postgresql?.parameters ?? {};
    spec.postgresql = {
      parameters: { ...existingParams, archive_timeout: archiveTimeout },
    };
  }

  await (k8s.custom as unknown as {
    patchNamespacedCustomObject: (a: {
      group: string; version: string; namespace: string; plural: string; name: string; body: unknown;
    }, opts?: unknown) => Promise<unknown>;
  }).patchNamespacedCustomObject({
    group: CNPG_GROUP, version: CNPG_VERSION, namespace,
    plural: 'clusters', name: cluster,
    body: { spec },
  }, MERGE_PATCH);
}

// ─── ScheduledBackup CR helpers ──────────────────────────────────────────────

interface ScheduledBackupCR {
  readonly status?: {
    readonly lastScheduleTime?: string;
    readonly nextScheduleTime?: string;
  };
}

export async function readScheduledBackup(
  k8s: K8sClients, namespace: string, cluster: string,
): Promise<ScheduledBackupCR | null> {
  try {
    const custom = k8s.custom as unknown as {
      getNamespacedCustomObject: (a: {
        group: string; version: string; namespace: string; plural: string; name: string;
      }) => Promise<ScheduledBackupCR>;
    };
    return await custom.getNamespacedCustomObject({
      group: CNPG_GROUP, version: CNPG_VERSION, namespace,
      plural: 'scheduledbackups', name: SCHEDULED_BACKUP_NAME(cluster),
    });
  } catch {
    return null;
  }
}

async function upsertScheduledBackup(
  k8s: K8sClients, namespace: string, cluster: string, schedule: string,
): Promise<void> {
  const custom = k8s.custom as unknown as {
    getNamespacedCustomObject: (a: { group: string; version: string; namespace: string; plural: string; name: string }) => Promise<unknown>;
    createNamespacedCustomObject: (a: { group: string; version: string; namespace: string; plural: string; body: unknown }) => Promise<unknown>;
    patchNamespacedCustomObject: (a: { group: string; version: string; namespace: string; plural: string; name: string; body: unknown }, opts?: unknown) => Promise<unknown>;
  };
  const name = SCHEDULED_BACKUP_NAME(cluster);
  const body = {
    apiVersion: `${CNPG_GROUP}/${CNPG_VERSION}`,
    kind: 'ScheduledBackup',
    metadata: {
      name, namespace,
      labels: {
        'app.kubernetes.io/part-of': 'hosting-platform',
        'app.kubernetes.io/component': 'system-backup',
        'app.kubernetes.io/managed-by': 'platform-api',
      },
    },
    spec: {
      cluster: { name: cluster },
      method: 'plugin',
      pluginConfiguration: { name: BARMAN_PLUGIN_NAME },
      schedule,
      backupOwnerReference: 'self',
      // Triggers a base backup immediately after enable so operators
      // don't wait for the next cron tick.
      immediate: true,
    },
  };

  let exists = true;
  try {
    await custom.getNamespacedCustomObject({
      group: CNPG_GROUP, version: CNPG_VERSION, namespace,
      plural: 'scheduledbackups', name,
    });
  } catch (err: unknown) {
    const status = (err as { response?: { statusCode?: number }; code?: number })?.response?.statusCode
      ?? (err as { code?: number })?.code;
    if (status !== 404) throw err;
    exists = false;
  }
  if (exists) {
    // Patch schedule + ensure method=plugin (handles migration from a
    // legacy method=barmanObjectStore CR left over from in-tree era).
    await custom.patchNamespacedCustomObject({
      group: CNPG_GROUP, version: CNPG_VERSION, namespace,
      plural: 'scheduledbackups', name,
      body: {
        spec: {
          schedule,
          method: 'plugin',
          pluginConfiguration: { name: BARMAN_PLUGIN_NAME },
        },
      },
    }, MERGE_PATCH);
    return;
  }
  try {
    await custom.createNamespacedCustomObject({
      group: CNPG_GROUP, version: CNPG_VERSION, namespace,
      plural: 'scheduledbackups', body,
    });
  } catch (err: unknown) {
    const status = (err as { response?: { statusCode?: number }; code?: number })?.response?.statusCode
      ?? (err as { code?: number })?.code;
    if (status !== 409) throw err;
    await custom.patchNamespacedCustomObject({
      group: CNPG_GROUP, version: CNPG_VERSION, namespace,
      plural: 'scheduledbackups', name,
      body: {
        spec: {
          schedule,
          method: 'plugin',
          pluginConfiguration: { name: BARMAN_PLUGIN_NAME },
        },
      },
    }, MERGE_PATCH);
  }
}

async function deleteScheduledBackupIfPresent(
  k8s: K8sClients, namespace: string, cluster: string,
): Promise<void> {
  const name = SCHEDULED_BACKUP_NAME(cluster);
  try {
    await (k8s.custom as unknown as {
      deleteNamespacedCustomObject: (a: { group: string; version: string; namespace: string; plural: string; name: string }) => Promise<unknown>;
    }).deleteNamespacedCustomObject({
      group: CNPG_GROUP, version: CNPG_VERSION, namespace, plural: 'scheduledbackups', name,
    });
  } catch (err: unknown) {
    const status = (err as { response?: { statusCode?: number }; code?: number })?.response?.statusCode
      ?? (err as { code?: number })?.code;
    if (status === 404) return;
    throw err;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function enableWalArchive(input: EnableWalArchiveInput): Promise<{ destinationPath: string }> {
  const {
    db, k8s, clusterNamespace, clusterName, targetConfigId,
    retentionDays, operatorUserId, operatorIp,
    archiveTimeout, baseBackupSchedule, baseBackupRetentionDays,
  } = input;

  const cr = await readClusterCR(k8s, clusterNamespace, clusterName);
  if (!cr) throw new Error(`CNPG cluster ${clusterNamespace}/${clusterName} not found`);

  const cfg = await loadActiveS3Target(db, targetConfigId);
  const destinationPath = buildDestinationPath(cfg, clusterNamespace, clusterName);

  // Concurrent-enable serialization: pg_advisory_xact_lock keyed on
  // (cluster_namespace, cluster_name) — keys must be int8 so we hash
  // the string. Two concurrent super_admin enables on the SAME cluster
  // serialize behind the lock; the second one observes the row written
  // by the first via the read-before-write at the top of the
  // transaction. Lock auto-released at transaction end (xact-scoped).
  //
  // hashtextextended() returns int8 from a string — stable across
  // PG versions for the same input. Two-arg form (key1, key2) keys
  // the lock on two int4-shaped values; we pass (low32, high32) of
  // the int8 hash so two clusters with similar names don't collide.
  const lockHashSql = sql`hashtextextended(${`${clusterNamespace}/${clusterName}`}, 0)`;
  const advisoryLock = sql`SELECT pg_advisory_xact_lock(${lockHashSql})`;

  // Ordering matters: ObjectStore must exist before the Cluster references
  // it via spec.plugins (otherwise the operator validates and rejects the
  // Cluster patch with a dangling reference).
  await upsertObjectStore(k8s, clusterNamespace, clusterName, destinationPath, cfg.s3Endpoint ?? null, retentionDays);
  await patchClusterPlugin(k8s, clusterNamespace, clusterName, cr, /* enable */ true, archiveTimeout);

  if (baseBackupSchedule) {
    await upsertScheduledBackup(k8s, clusterNamespace, clusterName, baseBackupSchedule);
  } else {
    // Operator un-checked the periodic-base-backup option — remove the
    // ScheduledBackup we previously may have created so we don't keep
    // taking base backups against the operator's intent.
    await deleteScheduledBackupIfPresent(k8s, clusterNamespace, clusterName);
  }

  await db.transaction(async (tx) => {
    await tx.execute(advisoryLock);

    // Capture the previous state row BEFORE overwriting so the audit
    // log records the delta (security-reviewer MEDIUM: forensics gap
    // when a super_admin silently re-points archiving to a different
    // bucket — without this snapshot the prior target is lost).
    const priorRows = await tx
      .select({
        targetConfigId: systemWalArchiveState.targetConfigId,
        destinationPath: systemWalArchiveState.destinationPath,
        retentionDays: systemWalArchiveState.retentionDays,
      })
      .from(systemWalArchiveState)
      .where(and(
        eq(systemWalArchiveState.clusterNamespace, clusterNamespace),
        eq(systemWalArchiveState.clusterName, clusterName),
      ))
      .limit(1);
    const prior = priorRows[0] ?? null;

    await tx
      .insert(systemWalArchiveState)
      .values({
        clusterNamespace,
        clusterName,
        targetConfigId,
        retentionDays,
        destinationPath,
        operatorUserId,
        archiveTimeout: archiveTimeout ?? null,
        baseBackupSchedule: baseBackupSchedule ?? null,
        baseBackupRetentionDays: baseBackupRetentionDays ?? null,
      })
      .onConflictDoUpdate({
        target: [systemWalArchiveState.clusterNamespace, systemWalArchiveState.clusterName],
        set: {
          targetConfigId,
          retentionDays,
          destinationPath,
          operatorUserId,
          archiveTimeout: archiveTimeout ?? null,
          baseBackupSchedule: baseBackupSchedule ?? null,
          baseBackupRetentionDays: baseBackupRetentionDays ?? null,
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
      changes: {
        targetConfigId, retentionDays, destinationPath,
        archiveTimeout: archiveTimeout ?? null,
        baseBackupSchedule: baseBackupSchedule ?? null,
        baseBackupRetentionDays: baseBackupRetentionDays ?? null,
        plugin: BARMAN_PLUGIN_NAME,
        // Delta from prior state (null on first-ever enable).
        previousTargetConfigId: prior?.targetConfigId ?? null,
        previousDestinationPath: prior?.destinationPath ?? null,
        previousRetentionDays: prior?.retentionDays ?? null,
      },
      ipAddress: operatorIp ?? null,
    });
  });

  return { destinationPath };
}

export async function disableWalArchive(input: DisableWalArchiveInput): Promise<void> {
  const { db, k8s, clusterNamespace, clusterName, operatorUserId, operatorIp } = input;
  const cr = await readClusterCR(k8s, clusterNamespace, clusterName);
  if (!cr) throw new Error(`CNPG cluster ${clusterNamespace}/${clusterName} not found`);

  // Reverse-order of enable: detach plugin from Cluster first (stops new
  // archive operations), then delete ScheduledBackup, then ObjectStore.
  // We don't touch spec.postgresql.parameters.archive_timeout — Postgres
  // still archives WAL locally even with no plugin attached; that's
  // harmless and reversible.
  await patchClusterPlugin(k8s, clusterNamespace, clusterName, cr, /* enable */ false);
  await deleteScheduledBackupIfPresent(k8s, clusterNamespace, clusterName);
  await deleteObjectStoreIfPresent(k8s, clusterNamespace, clusterName);

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
