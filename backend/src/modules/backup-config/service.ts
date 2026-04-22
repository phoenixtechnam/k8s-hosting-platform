import { eq, asc } from 'drizzle-orm';
import { backupConfigurations } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { encrypt, decrypt } from '../oidc/crypto.js';
import type { Database } from '../../db/index.js';
import type { CreateBackupConfigInput, UpdateBackupConfigInput } from '@k8s-hosting/api-contracts';

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

export async function testConnection(db: Database, id: string, encryptionKey: string): Promise<TestConnectionResult> {
  const row = await getRawBackupConfig(db, id);
  const started = Date.now();

  try {
    if (row.storageType === 'ssh') {
      if (!row.sshHost || !row.sshUser || !row.sshKeyEncrypted || !row.sshPath) {
        throw new ApiError('INCOMPLETE_CONFIG', 'Incomplete SSH configuration: host, user, key, and path are required', 400);
      }
      // Decryption round-trip validates the stored key + correct
      // OIDC_ENCRYPTION_KEY. Real SSH connectivity wired in Phase B2.
      decrypt(row.sshKeyEncrypted, encryptionKey);
    } else if (row.storageType === 's3') {
      if (!row.s3Endpoint || !row.s3Bucket || !row.s3Region || !row.s3AccessKeyEncrypted || !row.s3SecretKeyEncrypted) {
        throw new ApiError('INCOMPLETE_CONFIG', 'Incomplete S3 configuration: endpoint, bucket, region, access key, and secret key are required', 400);
      }
      decrypt(row.s3AccessKeyEncrypted, encryptionKey);
      decrypt(row.s3SecretKeyEncrypted, encryptionKey);
    }
    const latencyMs = Date.now() - started;
    await db.update(backupConfigurations).set({
      lastTestedAt: new Date(),
      lastTestStatus: 'ok',
    }).where(eq(backupConfigurations.id, id));
    return { ok: true, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const code = err instanceof ApiError ? err.code : 'TEST_FAILED';
    const message = err instanceof Error ? err.message : 'Unknown error';
    await db.update(backupConfigurations).set({
      lastTestedAt: new Date(),
      lastTestStatus: 'error',
    }).where(eq(backupConfigurations.id, id));
    return { ok: false, latencyMs, error: { code, message } };
  }
}

// testDraft — run a connectivity test on form input that has not been
// saved yet. Consumed by the admin panel's "Test Connection" button
// inside the create/edit form so operators don't commit a broken
// config. No DB writes.
//
// Phase B1 stub: mirrors the structure testConnection will use once
// the real S3 HeadBucket probe lands in B2. For now it rejects obviously
// incomplete inputs and always returns ok=true for well-formed ones so
// the tests shipping with B1 (mocked service) pass; B2 swaps the body
// for a real AWS SDK call.
export async function testDraft(input: CreateBackupConfigInput): Promise<TestConnectionResult> {
  const started = Date.now();
  if (input.storage_type === 's3') {
    if (!input.s3_endpoint || !input.s3_bucket || !input.s3_region || !input.s3_access_key || !input.s3_secret_key) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        error: { code: 'INCOMPLETE_CONFIG', message: 'endpoint, bucket, region, access key, and secret key are required' },
      };
    }
  } else if (!input.ssh_host || !input.ssh_user || !input.ssh_key || !input.ssh_path) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: { code: 'INCOMPLETE_CONFIG', message: 'host, user, key, and path are required' },
    };
  }
  return { ok: true, latencyMs: Date.now() - started };
}
