import { eq, asc } from 'drizzle-orm';
import { backupConfigurations } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { encrypt, decrypt } from '../oidc/crypto.js';
import type { Database } from '../../db/index.js';
import type { CreateBackupConfigInput, UpdateBackupConfigInput } from '@k8s-hosting/api-contracts';
import { probeS3 } from './s3-probe.js';
import type { LonghornBackupTargetInput } from './longhorn-reconciler.js';

// Connectivity-test result returned by testConnection + testDraft. A real
// HeadBucket / SSH probe is wired in Phase B2; the shape is committed now
// so the admin panel can already consume it.
export interface TestConnectionResult {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly error?: { readonly code: string; readonly message: string };
}

function sanitizeConfig(row: typeof backupConfigurations.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    storageType: row.storageType,
    sshHost: row.sshHost ?? null,
    sshPort: row.sshPort ?? null,
    sshUser: row.sshUser ?? null,
    sshPath: row.sshPath ?? null,
    s3Endpoint: row.s3Endpoint ?? null,
    s3Bucket: row.s3Bucket ?? null,
    s3Region: row.s3Region ?? null,
    s3Prefix: row.s3Prefix ?? null,
    retentionDays: row.retentionDays,
    scheduleExpression: row.scheduleExpression,
    enabled: row.enabled,
    active: row.active,
    lastTestedAt: row.lastTestedAt,
    lastTestStatus: row.lastTestStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listBackupConfigs(db: Database) {
  const rows = await db.select().from(backupConfigurations).orderBy(asc(backupConfigurations.name));
  return rows.map(sanitizeConfig);
}

export async function getBackupConfig(db: Database, id: string) {
  const [row] = await db.select().from(backupConfigurations).where(eq(backupConfigurations.id, id));
  if (!row) {
    throw new ApiError('BACKUP_CONFIG_NOT_FOUND', `Backup configuration '${id}' not found`, 404);
  }
  return sanitizeConfig(row);
}

async function getRawBackupConfig(db: Database, id: string) {
  const [row] = await db.select().from(backupConfigurations).where(eq(backupConfigurations.id, id));
  if (!row) {
    throw new ApiError('BACKUP_CONFIG_NOT_FOUND', `Backup configuration '${id}' not found`, 404);
  }
  return row;
}

export async function createBackupConfig(db: Database, input: CreateBackupConfigInput, encryptionKey: string) {
  const id = crypto.randomUUID();

  if (input.storage_type === 'ssh') {
    await db.insert(backupConfigurations).values({
      id,
      name: input.name,
      storageType: 'ssh',
      sshHost: input.ssh_host,
      sshPort: input.ssh_port ?? 22,
      sshUser: input.ssh_user,
      sshKeyEncrypted: encrypt(input.ssh_key, encryptionKey),
      sshPath: input.ssh_path,
      retentionDays: input.retention_days ?? 30,
      scheduleExpression: input.schedule_expression ?? '0 2 * * *',
      enabled: input.enabled !== false ? 1 : 0,
    });
  } else {
    await db.insert(backupConfigurations).values({
      id,
      name: input.name,
      storageType: 's3',
      s3Endpoint: input.s3_endpoint,
      s3Bucket: input.s3_bucket,
      s3Region: input.s3_region,
      s3AccessKeyEncrypted: encrypt(input.s3_access_key, encryptionKey),
      s3SecretKeyEncrypted: encrypt(input.s3_secret_key, encryptionKey),
      s3Prefix: input.s3_prefix ?? null,
      retentionDays: input.retention_days ?? 30,
      scheduleExpression: input.schedule_expression ?? '0 2 * * *',
      enabled: input.enabled !== false ? 1 : 0,
    });
  }

  return getBackupConfig(db, id);
}

export async function updateBackupConfig(db: Database, id: string, input: UpdateBackupConfigInput, encryptionKey: string) {
  await getRawBackupConfig(db, id);

  const updateValues: Record<string, unknown> = {};

  if (input.name !== undefined) updateValues.name = input.name;
  if (input.ssh_host !== undefined) updateValues.sshHost = input.ssh_host;
  if (input.ssh_port !== undefined) updateValues.sshPort = input.ssh_port;
  if (input.ssh_user !== undefined) updateValues.sshUser = input.ssh_user;
  if (input.ssh_key !== undefined) updateValues.sshKeyEncrypted = encrypt(input.ssh_key, encryptionKey);
  if (input.ssh_path !== undefined) updateValues.sshPath = input.ssh_path;
  if (input.s3_endpoint !== undefined) updateValues.s3Endpoint = input.s3_endpoint;
  if (input.s3_bucket !== undefined) updateValues.s3Bucket = input.s3_bucket;
  if (input.s3_region !== undefined) updateValues.s3Region = input.s3_region;
  if (input.s3_access_key !== undefined) updateValues.s3AccessKeyEncrypted = encrypt(input.s3_access_key, encryptionKey);
  if (input.s3_secret_key !== undefined) updateValues.s3SecretKeyEncrypted = encrypt(input.s3_secret_key, encryptionKey);
  if (input.s3_prefix !== undefined) updateValues.s3Prefix = input.s3_prefix;
  if (input.retention_days !== undefined) updateValues.retentionDays = input.retention_days;
  if (input.schedule_expression !== undefined) updateValues.scheduleExpression = input.schedule_expression;
  if (input.enabled !== undefined) updateValues.enabled = input.enabled ? 1 : 0;

  if (Object.keys(updateValues).length > 0) {
    await db.update(backupConfigurations).set(updateValues).where(eq(backupConfigurations.id, id));
  }

  return getBackupConfig(db, id);
}

export async function deleteBackupConfig(db: Database, id: string) {
  const row = await getRawBackupConfig(db, id);
  if (row.active) {
    throw new ApiError(
      'BACKUP_CONFIG_ACTIVE',
      'Cannot delete the active backup target. Deactivate it first.',
      409,
    );
  }
  await db.delete(backupConfigurations).where(eq(backupConfigurations.id, id));
}

// activateBackupConfig — swap the `active` flag so this row becomes
// THE cluster backup target. Because the partial unique index enforces
// at-most-one-active, we explicitly clear other rows in the same
// transaction.
//
// Does NOT call the Longhorn reconciler directly — the route does that
// after activation succeeds. Separating DB and cluster writes lets tests
// exercise activation without mocking the k8s client.
//
// Accepts BOTH s3 and ssh kinds. SSH configs don't drive Longhorn's
// BackupTarget CR (Longhorn upstream is S3-only); they populate the
// platform-ns backup-credentials Secret with SSH_* keys + TARGET_KIND=ssh
// so the DR CronJobs (secrets-backup, hostpath-snapshot, etc.) can rsync
// over SSH instead of aws-cli.
export async function activateBackupConfig(db: Database, id: string) {
  const row = await getRawBackupConfig(db, id);
  if (row.storageType !== 's3' && row.storageType !== 'ssh') {
    throw new ApiError(
      'UNSUPPORTED_PROVIDER',
      `Unsupported backup target kind: ${row.storageType}`,
      400,
    );
  }
  // Completeness check before flipping the flag — a half-filled row
  // activating would corrupt the reconcile. Mirror the testConnection
  // checks so the admin panel gives matching feedback.
  if (row.storageType === 's3') {
    if (!row.s3Endpoint || !row.s3Bucket || !row.s3Region || !row.s3AccessKeyEncrypted || !row.s3SecretKeyEncrypted) {
      throw new ApiError('INCOMPLETE_CONFIG', 'S3 config missing required fields (endpoint, bucket, region, access/secret key)', 400);
    }
  } else {
    if (!row.sshHost || !row.sshUser || !row.sshPath || !row.sshKeyEncrypted) {
      throw new ApiError('INCOMPLETE_CONFIG', 'SSH config missing required fields (host, user, path, key)', 400);
    }
  }
  await db.transaction(async (tx) => {
    await tx.update(backupConfigurations)
      .set({ active: false })
      .where(eq(backupConfigurations.active, true));
    await tx.update(backupConfigurations)
      .set({ active: true })
      .where(eq(backupConfigurations.id, id));
  });
  return getBackupConfig(db, id);
}

// deactivateBackupConfig — flip active off. The Longhorn reconciler
// is called by the route to clear the BackupTarget CR.
export async function deactivateBackupConfig(db: Database, id: string) {
  await getRawBackupConfig(db, id);
  await db.update(backupConfigurations)
    .set({ active: false })
    .where(eq(backupConfigurations.id, id));
  return getBackupConfig(db, id);
}

// getActiveBackupConfig — returns decrypted creds for the currently
// active config, or null. Consumed by the Longhorn reconciler to
// refresh the Secret on application startup / periodic reconcile.
//
// The return shape is a discriminated union on `kind`, matching the
// reconciler's LonghornBackupTargetInput so the route can pass the
// result straight through without remapping.
export type ActiveBackupConfig = LonghornBackupTargetInput & { readonly id: string };

export async function getActiveBackupConfig(db: Database, encryptionKey: string): Promise<ActiveBackupConfig | null> {
  const [row] = await db.select()
    .from(backupConfigurations)
    .where(eq(backupConfigurations.active, true))
    .limit(1);
  if (!row) return null;

  if (row.storageType === 's3') {
    if (!row.s3Endpoint || !row.s3Bucket || !row.s3Region || !row.s3AccessKeyEncrypted || !row.s3SecretKeyEncrypted) {
      throw new ApiError('ACTIVE_CONFIG_INCOMPLETE', 'Active S3 backup target is missing required fields', 500);
    }
    return {
      kind: 's3',
      id: row.id,
      endpoint: row.s3Endpoint,
      region: row.s3Region,
      bucket: row.s3Bucket,
      accessKeyId: decrypt(row.s3AccessKeyEncrypted, encryptionKey),
      secretAccessKey: decrypt(row.s3SecretKeyEncrypted, encryptionKey),
      pathPrefix: row.s3Prefix ?? undefined,
    };
  }

  if (row.storageType === 'ssh') {
    if (!row.sshHost || !row.sshUser || !row.sshPath || !row.sshKeyEncrypted) {
      throw new ApiError('ACTIVE_CONFIG_INCOMPLETE', 'Active SSH backup target is missing required fields', 500);
    }
    return {
      kind: 'ssh',
      id: row.id,
      host: row.sshHost,
      port: row.sshPort ?? 22,
      user: row.sshUser,
      path: row.sshPath,
      privateKey: decrypt(row.sshKeyEncrypted, encryptionKey),
    };
  }

  throw new ApiError('ACTIVE_CONFIG_INCOMPLETE', `Active backup target has unknown kind: ${row.storageType}`, 500);
}

export async function testConnection(db: Database, id: string, encryptionKey: string): Promise<TestConnectionResult> {
  const row = await getRawBackupConfig(db, id);

  let result: TestConnectionResult;
  if (row.storageType === 'ssh') {
    if (!row.sshHost || !row.sshUser || !row.sshKeyEncrypted || !row.sshPath) {
      result = {
        ok: false,
        latencyMs: 0,
        error: {
          code: 'INCOMPLETE_CONFIG',
          message: 'Incomplete SSH configuration: host, user, key, and path are required',
        },
      };
    } else {
      // SSH probe not yet wired — decrypt as a smoke-test so we at least
      // catch encryption-key mismatches. Phase C/future work can dial a
      // TCP connection + exec a listing here.
      try {
        decrypt(row.sshKeyEncrypted, encryptionKey);
        result = { ok: true, latencyMs: 0 };
      } catch (err) {
        result = {
          ok: false,
          latencyMs: 0,
          error: { code: 'DECRYPT_FAILED', message: err instanceof Error ? err.message : 'Unknown error' },
        };
      }
    }
  } else {
    if (!row.s3Endpoint || !row.s3Bucket || !row.s3Region || !row.s3AccessKeyEncrypted || !row.s3SecretKeyEncrypted) {
      result = {
        ok: false,
        latencyMs: 0,
        error: {
          code: 'INCOMPLETE_CONFIG',
          message: 'Incomplete S3 configuration: endpoint, bucket, region, access key, and secret key are required',
        },
      };
    } else {
      try {
        const accessKeyId = decrypt(row.s3AccessKeyEncrypted, encryptionKey);
        const secretAccessKey = decrypt(row.s3SecretKeyEncrypted, encryptionKey);
        result = await probeS3({
          endpoint: row.s3Endpoint,
          region: row.s3Region,
          accessKeyId,
          secretAccessKey,
          bucket: row.s3Bucket,
        });
      } catch (err) {
        result = {
          ok: false,
          latencyMs: 0,
          error: { code: 'DECRYPT_FAILED', message: err instanceof Error ? err.message : 'Unknown error' },
        };
      }
    }
  }

  await db.update(backupConfigurations).set({
    lastTestedAt: new Date(),
    lastTestStatus: result.ok ? 'ok' : 'error',
  }).where(eq(backupConfigurations.id, id));

  return result;
}

// testDraft — run a connectivity test on form input that has not been
// saved yet. Consumed by the admin panel's "Test Connection" button
// inside the create/edit form so operators don't commit a broken
// config. No DB writes.
export async function testDraft(input: CreateBackupConfigInput): Promise<TestConnectionResult> {
  if (input.storage_type === 's3') {
    if (!input.s3_endpoint || !input.s3_bucket || !input.s3_region || !input.s3_access_key || !input.s3_secret_key) {
      return {
        ok: false,
        latencyMs: 0,
        error: { code: 'INCOMPLETE_CONFIG', message: 'endpoint, bucket, region, access key, and secret key are required' },
      };
    }
    return probeS3({
      endpoint: input.s3_endpoint,
      region: input.s3_region,
      accessKeyId: input.s3_access_key,
      secretAccessKey: input.s3_secret_key,
      bucket: input.s3_bucket,
    });
  }
  if (!input.ssh_host || !input.ssh_user || !input.ssh_key || !input.ssh_path) {
    return {
      ok: false,
      latencyMs: 0,
      error: { code: 'INCOMPLETE_CONFIG', message: 'host, user, key, and path are required' },
    };
  }
  // SSH probe intentionally minimal — real SSH dial + directory test
  // belongs with the SSH-backed backup writer (out of scope for this
  // Longhorn-first rollout). The UI already surfaces this as a best-
  // effort check.
  return { ok: true, latencyMs: 0 };
}
