/**
 * Postgres ObjectStore + ScheduledBackup reconciler (R-X6).
 *
 * Wires the SYSTEM-class shim target binding into the CNPG
 * plugin-barman-cloud backup pipeline:
 *
 *      backup_target_assignments[system] → BACKUP_TARGET_KEY (HKDF)
 *                                       ↓
 *               platform/backup-rclone-shim-creds Secret
 *                  (access_key + secret_key — derived from BACKUP_TARGET_KEY)
 *                                       ↓
 *               platform/system-postgres-objectstore ObjectStore CR
 *                  (endpointURL = http://backup-rclone-shim.platform.svc:9000)
 *                                       ↓
 *           CNPG Cluster `system-db` spec.plugins[barman-cloud] (in DB manifest)
 *                                       ↓
 *               platform/system-db-scheduled-backup ScheduledBackup CR
 *                  (daily 03:00 — barman_object_store + cluster reference)
 *
 * Why one reconciler module per consumer (postgres / etcd / restic /
 * rclone-push): each consumer has a different CR schema and a
 * different cadence. Lumping them into one reconciler would couple
 * unrelated failure modes. Each lives in `backup-rclone-shim/` so
 * the operator-facing module boundary stays "everything backup-shim
 * is here."
 *
 * Failure semantics:
 *   - SYSTEM target unassigned → ScheduledBackup CR `spec.suspend: true`
 *     (CNPG already supports this — no Backup runs but the schedule
 *     stays in the API server for visibility).
 *   - BACKUP_TARGET_KEY missing → log + no-op (the periodic reconciler
 *     will retry once bootstrap.sh seeds the key).
 *   - Plugin Deployment not yet rolled out (404 on Cluster patch) →
 *     log warning; the periodic reconciler retries on next tick.
 */

import { eq, inArray } from 'drizzle-orm';
import type * as k8s from '@kubernetes/client-node';
import type { Logger } from 'pino';

import {
  backupConfigurations,
  backupTargetAssignments,
} from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { JSON_PATCH, MERGE_PATCH } from '../../shared/k8s-patch.js';
import {
  deriveShimAccessKey,
  deriveShimSecretKey,
} from './crypto.js';
import {
  BACKUP_TARGET_KEY_SECRET_NAME,
  FIELD_MANAGER,
  SHIM_NAMESPACE,
  loadBackupTargetKey,
  ShimKeyMissingError,
} from './service.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Namespace where the CNPG Cluster `system-db` lives. Same namespace
 *  hosts the ObjectStore + ScheduledBackup + creds Secret we own. */
export const POSTGRES_NAMESPACE = 'platform';

/** Cluster CR name. Mirrors k8s/base/database.yaml. */
export const POSTGRES_CLUSTER_NAME = 'system-db';

/** ObjectStore CR name — referenced by Cluster.spec.plugins[].parameters.objectStoreName.
 *  Lives in the same namespace as the Cluster (CNPG plugin convention). */
export const POSTGRES_OBJECT_STORE_NAME = 'system-postgres-objectstore';

/** ScheduledBackup CR name. */
export const POSTGRES_SCHEDULED_BACKUP_NAME = 'system-db-scheduled-backup';

/** Secret holding the HKDF-derived shim S3 credentials. CNPG sidecar
 *  reads access_key / secret_key fields to authenticate to the shim. */
export const SHIM_S3_CREDS_SECRET_NAME = 'backup-rclone-shim-creds';

/** Shim ClusterIP endpoint. internalTrafficPolicy: Local routes the
 *  request to the same-node shim pod. The `http://` scheme + :9000
 *  port match the Service manifest (TLS is a follow-up). */
export const SHIM_S3_ENDPOINT_URL = `http://backup-rclone-shim.${SHIM_NAMESPACE}.svc.cluster.local:9000`;

/** Plugin name as registered by the upstream Deployment. */
export const BARMAN_PLUGIN_NAME = 'barman-cloud.cloudnative-pg.io';

/** ObjectStore API group + version. */
export const OBJECTSTORE_API_GROUP = 'barmancloud.cnpg.io';
export const OBJECTSTORE_API_VERSION = 'v1';
export const OBJECTSTORE_PLURAL = 'objectstores';

/** CNPG Cluster + ScheduledBackup API. */
export const CNPG_API_GROUP = 'postgresql.cnpg.io';
export const CNPG_API_VERSION = 'v1';
export const SCHEDULED_BACKUP_PLURAL = 'scheduledbackups';
export const CLUSTER_PLURAL = 'clusters';

/** Default daily backup schedule. CNPG uses an extended-cron syntax —
 *  6 fields (seconds first). Operators can override via the future
 *  R-X10 UI; for now the schedule is fixed at 03:00 UTC. */
export const DEFAULT_BACKUP_SCHEDULE = '0 0 3 * * *';

/** Retention policy for barman-cloud (RFC §12 — 30 days). */
export const DEFAULT_RETENTION_POLICY = '30d';

/** Annotation on every reconciler-owned resource so operators can
 *  identify what platform-api manages. */
export const POSTGRES_FIELD_MANAGER = 'platform-api-postgres-objectstore';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PostgresObjectStoreClients {
  readonly core: k8s.CoreV1Api;
  readonly custom: k8s.CustomObjectsApi;
}

export interface PostgresObjectStoreResult {
  readonly state: 'STATE_OK' | 'STATE_MISSING_KEY' | 'STATE_NO_SYSTEM_TARGET' | 'STATE_ERROR';
  readonly errorMessage: string;
  readonly objectStoreApplied: boolean;
  readonly scheduledBackupApplied: boolean;
  readonly scheduledBackupSuspended: boolean;
  readonly credentialsSecretApplied: boolean;
  /** Whether spec.plugins[0].isWALArchiver was patched to `true` on
   *  the CNPG Cluster CR. `false` when SYSTEM is unassigned (prevents
   *  pg_wal accumulation on a no-target cluster). */
  readonly walArchiverEnabled: boolean;
}

interface SystemTargetView {
  readonly targetId: string;
  readonly storageType: string;
  readonly enabled: number;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * One reconcile pass. Idempotent — re-running with unchanged inputs
 * results in no apiserver mutations (server-side apply with the same
 * managed-field set is a no-op).
 *
 * Order matters: Secret first (creds the ObjectStore references must
 * exist before the plugin tries to use them), then ObjectStore, then
 * ScheduledBackup. The CNPG Cluster CR's spec.plugins[] entry is a
 * STATIC piece of the database.yaml manifest — Flux applies it. This
 * reconciler does NOT patch the Cluster.
 */
export async function reconcilePostgresObjectStore(
  db: Database,
  clients: PostgresObjectStoreClients,
  log: Pick<Logger, 'info' | 'warn' | 'error'>,
): Promise<PostgresObjectStoreResult> {
  // ─── 1. Load BACKUP_TARGET_KEY ───────────────────────────────────
  let keyInput: { rawKey: Buffer; fingerprint: string };
  try {
    keyInput = await loadBackupTargetKey(clients.core, SHIM_NAMESPACE, { log });
  } catch (err) {
    if (err instanceof ShimKeyMissingError) {
      log.warn(
        { err: err.message },
        'postgres-objectstore: BACKUP_TARGET_KEY missing — no-op (will retry)',
      );
      return {
        state: 'STATE_MISSING_KEY',
        errorMessage: err.message,
        objectStoreApplied: false,
        scheduledBackupApplied: false,
        scheduledBackupSuspended: false,
        credentialsSecretApplied: false,
        walArchiverEnabled: false,
      };
    }
    throw err;
  }

  // ─── 2. Load SYSTEM target binding ───────────────────────────────
  const target = await loadSystemTarget(db);
  const suspended = target === null;

  // ─── 3. Materialise the shim creds Secret in the cluster ns ─────
  let credentialsSecretApplied = false;
  try {
    await materializeShimCredsSecret(
      clients.core,
      log,
      keyInput.rawKey,
    );
    credentialsSecretApplied = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg }, 'postgres-objectstore: shim creds Secret failed');
    return {
      state: 'STATE_ERROR',
      errorMessage: msg,
      objectStoreApplied: false,
      scheduledBackupApplied: false,
      scheduledBackupSuspended: false,
      credentialsSecretApplied: false,
      walArchiverEnabled: false,
    };
  }

  // ─── 4. Materialise ObjectStore CR ───────────────────────────────
  let objectStoreApplied = false;
  try {
    await materializeObjectStore(clients.custom, log);
    objectStoreApplied = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg }, 'postgres-objectstore: ObjectStore apply failed');
    return {
      state: 'STATE_ERROR',
      errorMessage: msg,
      objectStoreApplied: false,
      scheduledBackupApplied: false,
      scheduledBackupSuspended: false,
      credentialsSecretApplied,
      walArchiverEnabled: false,
    };
  }

  // ─── 5. Materialise ScheduledBackup CR (suspended when no target) ─
  let scheduledBackupApplied = false;
  try {
    await materializeScheduledBackup(clients.custom, log, { suspended });
    scheduledBackupApplied = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg }, 'postgres-objectstore: ScheduledBackup apply failed');
    return {
      state: 'STATE_ERROR',
      errorMessage: msg,
      objectStoreApplied,
      scheduledBackupApplied: false,
      scheduledBackupSuspended: false,
      credentialsSecretApplied,
      walArchiverEnabled: false,
    };
  }

  // ─── 6. Toggle isWALArchiver on the Cluster CR ──────────────────
  // When SYSTEM is unassigned, isWALArchiver must be `false` (or
  // absent) — otherwise the archive_command fails every checkpoint
  // and pg_wal/ fills until the volume runs out of disk. The
  // database.yaml manifest INTENTIONALLY omits isWALArchiver so the
  // reconciler is the sole owner of the field. Flux ssa: merge
  // preserves fields not in the source manifest.
  let walArchiverEnabled = false;
  try {
    walArchiverEnabled = !suspended;
    await patchClusterWalArchiver(clients.custom, log, walArchiverEnabled);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg }, 'postgres-objectstore: Cluster isWALArchiver patch failed');
    return {
      state: 'STATE_ERROR',
      errorMessage: msg,
      objectStoreApplied,
      scheduledBackupApplied,
      scheduledBackupSuspended: suspended,
      credentialsSecretApplied,
      walArchiverEnabled: false,
    };
  }

  return {
    state: target === null ? 'STATE_NO_SYSTEM_TARGET' : 'STATE_OK',
    errorMessage: '',
    objectStoreApplied,
    scheduledBackupApplied,
    scheduledBackupSuspended: suspended,
    credentialsSecretApplied,
    walArchiverEnabled,
  };
}

// ---------------------------------------------------------------------------
// DB query — SYSTEM target binding
// ---------------------------------------------------------------------------

async function loadSystemTarget(db: Database): Promise<SystemTargetView | null> {
  const rows = await db
    .select({
      targetId: backupTargetAssignments.targetId,
      storageType: backupConfigurations.storageType,
      enabled: backupConfigurations.enabled,
    })
    .from(backupTargetAssignments)
    .innerJoin(
      backupConfigurations,
      eq(backupConfigurations.id, backupTargetAssignments.targetId),
    )
    .where(
      inArray(backupTargetAssignments.snapshotClass, ['system']),
    )
    .orderBy(backupTargetAssignments.priority)
    .limit(1);
  if (rows.length === 0) return null;
  const row = rows[0];
  if (row.enabled !== 1) return null;
  return {
    targetId: row.targetId,
    storageType: row.storageType,
    enabled: row.enabled,
  };
}

// ---------------------------------------------------------------------------
// Shim creds Secret (in cluster ns)
// ---------------------------------------------------------------------------

async function materializeShimCredsSecret(
  core: k8s.CoreV1Api,
  log: Pick<Logger, 'info' | 'warn'>,
  rawKey: Buffer,
): Promise<void> {
  const accessKey = deriveShimAccessKey(rawKey);
  const secretKey = deriveShimSecretKey(rawKey);
  const dataB64 = {
    access_key: Buffer.from(accessKey, 'utf8').toString('base64'),
    secret_key: Buffer.from(secretKey, 'utf8').toString('base64'),
  };

  let exists = false;
  try {
    await core.readNamespacedSecret({
      name: SHIM_S3_CREDS_SECRET_NAME,
      namespace: POSTGRES_NAMESPACE,
    } as unknown as Parameters<typeof core.readNamespacedSecret>[0]);
    exists = true;
  } catch (err) {
    const code = (err as { statusCode?: number; code?: number })?.statusCode
      ?? (err as { code?: number })?.code;
    if (code !== 404) throw err;
  }

  if (!exists) {
    try {
      await core.createNamespacedSecret({
        namespace: POSTGRES_NAMESPACE,
        body: {
          metadata: {
            name: SHIM_S3_CREDS_SECRET_NAME,
            namespace: POSTGRES_NAMESPACE,
            labels: {
              app: 'backup-rclone-shim',
              'app.kubernetes.io/part-of': 'hosting-platform',
              'app.kubernetes.io/component': 'backup',
              'app.kubernetes.io/managed-by': POSTGRES_FIELD_MANAGER,
            },
          },
          type: 'Opaque',
          data: dataB64,
        },
      } as unknown as Parameters<typeof core.createNamespacedSecret>[0]);
      log.info(
        { name: SHIM_S3_CREDS_SECRET_NAME },
        'postgres-objectstore: shim creds Secret created',
      );
      return;
    } catch (err) {
      const code = (err as { statusCode?: number; code?: number })?.statusCode
        ?? (err as { code?: number })?.code;
      // 409 → concurrent creator won the create race (startup
      // setImmediate + manual trigger overlap). Treat as success and
      // fall through to patch so data converges. Without this guard
      // the second reconciler crashes with an opaque STATE_ERROR.
      if (code !== 409) throw err;
      log.info(
        { name: SHIM_S3_CREDS_SECRET_NAME },
        'postgres-objectstore: shim creds Secret 409 on create — concurrent creator won; falling through to patch',
      );
    }
  }

  // Merge-patch `data` rather than JSON-Patch replace because:
  //   - replace fails 422 if the Secret was somehow created without
  //     a `data` field (operator hand-edit)
  //   - merge with the full data map still atomically replaces every
  //     key we manage, and absent-from-manifest keys are left alone
  //     (intentional — the Secret is reconciler-owned, no operator
  //     additions are expected, but the path stays safe under weird
  //     starting states).
  await core.patchNamespacedSecret(
    {
      name: SHIM_S3_CREDS_SECRET_NAME,
      namespace: POSTGRES_NAMESPACE,
      body: { data: dataB64 },
    } as unknown as Parameters<typeof core.patchNamespacedSecret>[0],
    MERGE_PATCH,
  );
}

// ---------------------------------------------------------------------------
// ObjectStore CR
// ---------------------------------------------------------------------------

function buildObjectStoreSpec(): Record<string, unknown> {
  return {
    configuration: {
      destinationPath: 's3://system/postgres',
      endpointURL: SHIM_S3_ENDPOINT_URL,
      // The shim's HKDF-derived creds — host application reads them
      // from the Secret we just materialised.
      s3Credentials: {
        accessKeyId: {
          name: SHIM_S3_CREDS_SECRET_NAME,
          key: 'access_key',
        },
        secretAccessKey: {
          name: SHIM_S3_CREDS_SECRET_NAME,
          key: 'secret_key',
        },
      },
      // zstd compression — barman-cloud default for new objectstores
      // since cnpg-i 0.10. Same compression for WAL + data.
      wal: { compression: 'zstd', maxParallel: 8 },
      data: { compression: 'zstd' },
    },
    // 30-day rolling retention (RFC §12).
    retentionPolicy: DEFAULT_RETENTION_POLICY,
  };
}

async function materializeObjectStore(
  custom: k8s.CustomObjectsApi,
  log: Pick<Logger, 'info' | 'warn'>,
): Promise<void> {
  const spec = buildObjectStoreSpec();
  const body = {
    apiVersion: `${OBJECTSTORE_API_GROUP}/${OBJECTSTORE_API_VERSION}`,
    kind: 'ObjectStore',
    metadata: {
      name: POSTGRES_OBJECT_STORE_NAME,
      namespace: POSTGRES_NAMESPACE,
      labels: {
        app: 'backup-rclone-shim',
        'app.kubernetes.io/part-of': 'hosting-platform',
        'app.kubernetes.io/component': 'backup',
        'app.kubernetes.io/managed-by': POSTGRES_FIELD_MANAGER,
      },
    },
    spec,
  };

  let exists = false;
  try {
    await custom.getNamespacedCustomObject({
      group: OBJECTSTORE_API_GROUP,
      version: OBJECTSTORE_API_VERSION,
      namespace: POSTGRES_NAMESPACE,
      plural: OBJECTSTORE_PLURAL,
      name: POSTGRES_OBJECT_STORE_NAME,
    } as unknown as Parameters<typeof custom.getNamespacedCustomObject>[0]);
    exists = true;
  } catch (err) {
    const code = (err as { statusCode?: number; code?: number })?.statusCode
      ?? (err as { code?: number })?.code;
    if (code !== 404) throw err;
  }

  if (!exists) {
    await custom.createNamespacedCustomObject({
      group: OBJECTSTORE_API_GROUP,
      version: OBJECTSTORE_API_VERSION,
      namespace: POSTGRES_NAMESPACE,
      plural: OBJECTSTORE_PLURAL,
      body,
    } as unknown as Parameters<typeof custom.createNamespacedCustomObject>[0]);
    log.info(
      { name: POSTGRES_OBJECT_STORE_NAME },
      'postgres-objectstore: ObjectStore CR created',
    );
    return;
  }

  // Update via merge-patch on spec only. We don't replace the whole
  // CR because that would clobber operator-added annotations on the
  // managed object.
  await custom.patchNamespacedCustomObject(
    {
      group: OBJECTSTORE_API_GROUP,
      version: OBJECTSTORE_API_VERSION,
      namespace: POSTGRES_NAMESPACE,
      plural: OBJECTSTORE_PLURAL,
      name: POSTGRES_OBJECT_STORE_NAME,
      body: { spec },
    } as unknown as Parameters<typeof custom.patchNamespacedCustomObject>[0],
    MERGE_PATCH,
  );
}

// ---------------------------------------------------------------------------
// ScheduledBackup CR
// ---------------------------------------------------------------------------

interface ScheduledBackupOpts {
  readonly suspended: boolean;
}

function buildScheduledBackupSpec(opts: ScheduledBackupOpts): Record<string, unknown> {
  return {
    schedule: DEFAULT_BACKUP_SCHEDULE,
    backupOwnerReference: 'self',
    immediate: false,
    cluster: {
      name: POSTGRES_CLUSTER_NAME,
    },
    // method=plugin tells CNPG to delegate to plugin-barman-cloud;
    // the pluginConfiguration field points at our ObjectStore CR.
    method: 'plugin',
    pluginConfiguration: {
      name: BARMAN_PLUGIN_NAME,
      parameters: {
        objectStoreName: POSTGRES_OBJECT_STORE_NAME,
      },
    },
    // When the operator unassigns the SYSTEM target, suspend the
    // schedule instead of deleting the CR — keeps the operator
    // surface alive for observability + makes re-enabling trivial.
    suspend: opts.suspended,
  };
}

async function materializeScheduledBackup(
  custom: k8s.CustomObjectsApi,
  log: Pick<Logger, 'info' | 'warn'>,
  opts: ScheduledBackupOpts,
): Promise<void> {
  const spec = buildScheduledBackupSpec(opts);
  const body = {
    apiVersion: `${CNPG_API_GROUP}/${CNPG_API_VERSION}`,
    kind: 'ScheduledBackup',
    metadata: {
      name: POSTGRES_SCHEDULED_BACKUP_NAME,
      namespace: POSTGRES_NAMESPACE,
      labels: {
        app: 'backup-rclone-shim',
        'app.kubernetes.io/part-of': 'hosting-platform',
        'app.kubernetes.io/component': 'backup',
        'app.kubernetes.io/managed-by': POSTGRES_FIELD_MANAGER,
      },
    },
    spec,
  };

  let exists = false;
  try {
    await custom.getNamespacedCustomObject({
      group: CNPG_API_GROUP,
      version: CNPG_API_VERSION,
      namespace: POSTGRES_NAMESPACE,
      plural: SCHEDULED_BACKUP_PLURAL,
      name: POSTGRES_SCHEDULED_BACKUP_NAME,
    } as unknown as Parameters<typeof custom.getNamespacedCustomObject>[0]);
    exists = true;
  } catch (err) {
    const code = (err as { statusCode?: number; code?: number })?.statusCode
      ?? (err as { code?: number })?.code;
    if (code !== 404) throw err;
  }

  if (!exists) {
    await custom.createNamespacedCustomObject({
      group: CNPG_API_GROUP,
      version: CNPG_API_VERSION,
      namespace: POSTGRES_NAMESPACE,
      plural: SCHEDULED_BACKUP_PLURAL,
      body,
    } as unknown as Parameters<typeof custom.createNamespacedCustomObject>[0]);
    log.info(
      { name: POSTGRES_SCHEDULED_BACKUP_NAME, suspended: opts.suspended },
      'postgres-objectstore: ScheduledBackup CR created',
    );
    return;
  }

  await custom.patchNamespacedCustomObject(
    {
      group: CNPG_API_GROUP,
      version: CNPG_API_VERSION,
      namespace: POSTGRES_NAMESPACE,
      plural: SCHEDULED_BACKUP_PLURAL,
      name: POSTGRES_SCHEDULED_BACKUP_NAME,
      body: { spec },
    } as unknown as Parameters<typeof custom.patchNamespacedCustomObject>[0],
    MERGE_PATCH,
  );
}

// ---------------------------------------------------------------------------
// Cluster CR — dynamic isWALArchiver patch
// ---------------------------------------------------------------------------

interface ClusterPluginEntry {
  name?: string;
  isWALArchiver?: boolean;
  parameters?: Record<string, string>;
}

interface ClusterCRView {
  spec?: {
    plugins?: ClusterPluginEntry[];
  };
}

/**
 * Patch the CNPG Cluster CR's `spec.plugins[].isWALArchiver` to
 * match the desired state (true when SYSTEM bound, false otherwise).
 * Uses JSON-Patch with array index addressing for atomic per-entry
 * mutation; merge-patch on an array would replace the whole array
 * which would clobber any other plugins the operator may have added.
 *
 * If the cluster's `spec.plugins[]` doesn't yet include the
 * barman-cloud entry (fresh install before Flux first-applies the
 * database.yaml manifest), this function logs + returns without
 * raising — the next reconciler tick converges once Flux applies.
 */
export async function patchClusterWalArchiver(
  custom: k8s.CustomObjectsApi,
  log: Pick<Logger, 'info' | 'warn'>,
  enabled: boolean,
): Promise<void> {
  let cluster: ClusterCRView;
  try {
    cluster = (await custom.getNamespacedCustomObject({
      group: CNPG_API_GROUP,
      version: CNPG_API_VERSION,
      namespace: POSTGRES_NAMESPACE,
      plural: CLUSTER_PLURAL,
      name: POSTGRES_CLUSTER_NAME,
    } as unknown as Parameters<typeof custom.getNamespacedCustomObject>[0])) as ClusterCRView;
  } catch (err) {
    const code = (err as { statusCode?: number; code?: number })?.statusCode
      ?? (err as { code?: number })?.code;
    if (code === 404) {
      log.warn(
        { name: POSTGRES_CLUSTER_NAME, enabled },
        'postgres-objectstore: Cluster CR not yet applied — skipping isWALArchiver patch',
      );
      return;
    }
    throw err;
  }

  const plugins = cluster.spec?.plugins ?? [];
  const idx = plugins.findIndex((p) => p.name === BARMAN_PLUGIN_NAME);
  if (idx < 0) {
    log.warn(
      { name: POSTGRES_CLUSTER_NAME, enabled },
      'postgres-objectstore: Cluster CR has no barman-cloud plugin entry — skipping isWALArchiver patch (Flux not yet synced)',
    );
    return;
  }

  // Skip the patch when already at the desired state — saves an
  // apiserver round-trip and reduces the chance of the resourceVersion
  // contention that JSON-Patch is sensitive to.
  if (Boolean(plugins[idx].isWALArchiver) === enabled) {
    return;
  }

  const op = [
    {
      op: 'replace' as const,
      path: `/spec/plugins/${idx}/isWALArchiver`,
      value: enabled,
    },
  ];
  try {
    await custom.patchNamespacedCustomObject(
      {
        group: CNPG_API_GROUP,
        version: CNPG_API_VERSION,
        namespace: POSTGRES_NAMESPACE,
        plural: CLUSTER_PLURAL,
        name: POSTGRES_CLUSTER_NAME,
        body: op as unknown as object,
      } as unknown as Parameters<typeof custom.patchNamespacedCustomObject>[0],
      JSON_PATCH,
    );
    log.info(
      { name: POSTGRES_CLUSTER_NAME, enabled },
      'postgres-objectstore: Cluster CR isWALArchiver toggled',
    );
  } catch (err) {
    const code = (err as { statusCode?: number; code?: number })?.statusCode
      ?? (err as { code?: number })?.code;
    if (code === 422) {
      // `replace` requires the path to exist. The path
      // `/spec/plugins/${idx}/isWALArchiver` may not exist if Flux
      // applied the manifest WITHOUT the field (intentional — we
      // own it). Retry as add.
      const addOp = [
        {
          op: 'add' as const,
          path: `/spec/plugins/${idx}/isWALArchiver`,
          value: enabled,
        },
      ];
      await custom.patchNamespacedCustomObject(
        {
          group: CNPG_API_GROUP,
          version: CNPG_API_VERSION,
          namespace: POSTGRES_NAMESPACE,
          plural: CLUSTER_PLURAL,
          name: POSTGRES_CLUSTER_NAME,
          body: addOp as unknown as object,
        } as unknown as Parameters<typeof custom.patchNamespacedCustomObject>[0],
        JSON_PATCH,
      );
      log.info(
        { name: POSTGRES_CLUSTER_NAME, enabled },
        'postgres-objectstore: Cluster CR isWALArchiver added (path did not exist; retried as add)',
      );
      return;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Re-exports for the scheduler / tests
// ---------------------------------------------------------------------------

export {
  BACKUP_TARGET_KEY_SECRET_NAME,
  loadBackupTargetKey,
};
