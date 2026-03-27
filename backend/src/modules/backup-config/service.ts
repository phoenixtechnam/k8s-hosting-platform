import { eq, asc } from 'drizzle-orm';
import { backupConfigurations } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { encrypt, decrypt } from '../oidc/crypto.js';
import type { Database } from '../../db/index.js';
import type { CreateBackupConfigInput, UpdateBackupConfigInput } from '@k8s-hosting/api-contracts';

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
  await getRawBackupConfig(db, id);
  await db.delete(backupConfigurations).where(eq(backupConfigurations.id, id));
}

export async function testConnection(db: Database, id: string, encryptionKey: string) {
  const row = await getRawBackupConfig(db, id);

  let status: 'ok' | 'error' = 'ok';
  let message: string | undefined;

  try {
    if (row.storageType === 'ssh') {
      if (!row.sshHost || !row.sshUser || !row.sshKeyEncrypted || !row.sshPath) {
        throw new Error('Incomplete SSH configuration: host, user, key, and path are required');
      }
      // Verify decryption works (validates the key is correct)
      decrypt(row.sshKeyEncrypted, encryptionKey);
    } else if (row.storageType === 's3') {
      if (!row.s3Endpoint || !row.s3Bucket || !row.s3Region || !row.s3AccessKeyEncrypted || !row.s3SecretKeyEncrypted) {
        throw new Error('Incomplete S3 configuration: endpoint, bucket, region, access key, and secret key are required');
      }
      // Verify decryption works
      decrypt(row.s3AccessKeyEncrypted, encryptionKey);
      decrypt(row.s3SecretKeyEncrypted, encryptionKey);
    }
    message = 'Configuration is valid';
  } catch (err) {
    status = 'error';
    message = err instanceof Error ? err.message : 'Unknown error';
  }

  await db.update(backupConfigurations).set({
    lastTestedAt: new Date(),
    lastTestStatus: status,
  }).where(eq(backupConfigurations.id, id));

  return { status, message };
}
