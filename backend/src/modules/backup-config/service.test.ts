import { describe, it, expect, vi } from 'vitest';
import { encrypt, decrypt } from '../oidc/crypto.js';
import {
  createBackupConfig,
  listBackupConfigs,
  getBackupConfig,
  updateBackupConfig,
  deleteBackupConfig,
  testConnection,
} from './service.js';

const ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const SSH_ROW = {
  id: 'cfg-1',
  name: 'SSH Backup',
  storageType: 'ssh' as const,
  sshHost: 'backup.example.com',
  sshPort: 22,
  sshUser: 'backupuser',
  sshKeyEncrypted: encrypt('private-key-data', ENCRYPTION_KEY),
  sshPath: '/backups',
  s3Endpoint: null,
  s3Bucket: null,
  s3Region: null,
  s3AccessKeyEncrypted: null,
  s3SecretKeyEncrypted: null,
  s3Prefix: null,
  retentionDays: 30,
  scheduleExpression: '0 2 * * *',
  enabled: 1,
  lastTestedAt: null,
  lastTestStatus: null,
  createdAt: new Date('2025-01-01'),
  updatedAt: new Date('2025-01-01'),
};

const S3_ROW = {
  id: 'cfg-2',
  name: 'S3 Backup',
  storageType: 's3' as const,
  sshHost: null,
  sshPort: null,
  sshUser: null,
  sshKeyEncrypted: null,
  sshPath: null,
  s3Endpoint: 'https://s3.example.com',
  s3Bucket: 'my-backups',
  s3Region: 'eu-west-1',
  s3AccessKeyEncrypted: encrypt('AKIAIOSFODNN7EXAMPLE', ENCRYPTION_KEY),
  s3SecretKeyEncrypted: encrypt('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', ENCRYPTION_KEY),
  s3Prefix: 'prod/',
  retentionDays: 60,
  scheduleExpression: '0 3 * * *',
  enabled: 1,
  lastTestedAt: null,
  lastTestStatus: null,
  createdAt: new Date('2025-01-01'),
  updatedAt: new Date('2025-01-01'),
};

function createMockDb(rows: unknown[] = []) {
  let selectCallCount = 0;
  const selectResults = Array.isArray(rows) ? rows : [rows];

  const whereFn = vi.fn().mockImplementation(() => {
    selectCallCount++;
    // First where() call in create is for getRaw, subsequent ones for getBackupConfig
    return Promise.resolve(selectResults);
  });
  const orderByFn = vi.fn().mockReturnValue(Promise.resolve(selectResults));
  const fromFn = vi.fn().mockReturnValue({ where: whereFn, orderBy: orderByFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });

  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
  const updateFn = vi.fn().mockReturnValue({ set: updateSet });

  const deleteWhere = vi.fn().mockResolvedValue(undefined);
  const deleteFn = vi.fn().mockReturnValue({ where: deleteWhere });

  const insertValues = vi.fn().mockResolvedValue(undefined);
  const insertFn = vi.fn().mockReturnValue({ values: insertValues });

  return {
    db: {
      select: selectFn,
      insert: insertFn,
      update: updateFn,
      delete: deleteFn,
    } as unknown as Parameters<typeof listBackupConfigs>[0],
    mocks: { selectFn, insertFn, updateFn, deleteFn, insertValues, updateSet, updateWhere, deleteWhere, whereFn },
  };
}

describe('createBackupConfig', () => {
  it('should create an SSH config and encrypt credentials', async () => {
    const { db, mocks } = createMockDb([SSH_ROW]);
    const result = await createBackupConfig(db, {
      storage_type: 'ssh',
      name: 'SSH Backup',
      ssh_host: 'backup.example.com',
      ssh_port: 22,
      ssh_user: 'backupuser',
      ssh_key: 'private-key-data',
      ssh_path: '/backups',
      retention_days: 30,
      schedule_expression: '0 2 * * *',
      enabled: true,
    }, ENCRYPTION_KEY);

    expect(mocks.insertValues).toHaveBeenCalledOnce();
    const insertedValues = mocks.insertValues.mock.calls[0][0];
    // Encrypted field should not equal plaintext
    expect(insertedValues.sshKeyEncrypted).not.toBe('private-key-data');
    expect(insertedValues.sshKeyEncrypted).toContain(':');
    // Decrypting should yield original
    expect(decrypt(insertedValues.sshKeyEncrypted, ENCRYPTION_KEY)).toBe('private-key-data');
    // Result should not contain encrypted fields
    expect(result).not.toHaveProperty('sshKeyEncrypted');
    expect(result.name).toBe('SSH Backup');
    expect(result.storageType).toBe('ssh');
  });

  it('should create an S3 config and encrypt credentials', async () => {
    const { db, mocks } = createMockDb([S3_ROW]);
    const result = await createBackupConfig(db, {
      storage_type: 's3',
      name: 'S3 Backup',
      s3_endpoint: 'https://s3.example.com',
      s3_bucket: 'my-backups',
      s3_region: 'eu-west-1',
      s3_access_key: 'AKIAIOSFODNN7EXAMPLE',
      s3_secret_key: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      s3_prefix: 'prod/',
      retention_days: 60,
      schedule_expression: '0 3 * * *',
      enabled: true,
    }, ENCRYPTION_KEY);

    expect(mocks.insertValues).toHaveBeenCalledOnce();
    const insertedValues = mocks.insertValues.mock.calls[0][0];
    expect(insertedValues.s3AccessKeyEncrypted).not.toBe('AKIAIOSFODNN7EXAMPLE');
    expect(decrypt(insertedValues.s3AccessKeyEncrypted, ENCRYPTION_KEY)).toBe('AKIAIOSFODNN7EXAMPLE');
    expect(decrypt(insertedValues.s3SecretKeyEncrypted, ENCRYPTION_KEY)).toBe('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
    expect(result).not.toHaveProperty('s3AccessKeyEncrypted');
    expect(result).not.toHaveProperty('s3SecretKeyEncrypted');
    expect(result.name).toBe('S3 Backup');
    expect(result.storageType).toBe('s3');
  });
});

describe('listBackupConfigs', () => {
  it('should return configs with sensitive fields masked', async () => {
    const { db } = createMockDb([SSH_ROW, S3_ROW]);
    const result = await listBackupConfigs(db);

    expect(result).toHaveLength(2);
    for (const config of result) {
      expect(config).not.toHaveProperty('sshKeyEncrypted');
      expect(config).not.toHaveProperty('s3AccessKeyEncrypted');
      expect(config).not.toHaveProperty('s3SecretKeyEncrypted');
    }
    expect(result[0].name).toBe('SSH Backup');
    expect(result[1].name).toBe('S3 Backup');
  });
});

describe('getBackupConfig', () => {
  it('should return a single config without encrypted fields', async () => {
    const { db } = createMockDb([SSH_ROW]);
    const result = await getBackupConfig(db, 'cfg-1');

    expect(result.id).toBe('cfg-1');
    expect(result).not.toHaveProperty('sshKeyEncrypted');
  });

  it('should throw BACKUP_CONFIG_NOT_FOUND for missing id', async () => {
    const { db } = createMockDb([]);
    await expect(getBackupConfig(db, 'missing')).rejects.toMatchObject({
      code: 'BACKUP_CONFIG_NOT_FOUND',
      status: 404,
    });
  });
});

describe('updateBackupConfig', () => {
  it('should re-encrypt changed credentials', async () => {
    const { db, mocks } = createMockDb([SSH_ROW]);
    await updateBackupConfig(db, 'cfg-1', {
      ssh_key: 'new-private-key',
    }, ENCRYPTION_KEY);

    expect(mocks.updateSet).toHaveBeenCalledOnce();
    const setValues = mocks.updateSet.mock.calls[0][0];
    expect(setValues.sshKeyEncrypted).toBeDefined();
    expect(decrypt(setValues.sshKeyEncrypted, ENCRYPTION_KEY)).toBe('new-private-key');
  });

  it('should update non-sensitive fields without touching encrypted columns', async () => {
    const { db, mocks } = createMockDb([SSH_ROW]);
    await updateBackupConfig(db, 'cfg-1', {
      name: 'Updated Name',
      retention_days: 60,
    }, ENCRYPTION_KEY);

    const setValues = mocks.updateSet.mock.calls[0][0];
    expect(setValues.name).toBe('Updated Name');
    expect(setValues.retentionDays).toBe(60);
    expect(setValues.sshKeyEncrypted).toBeUndefined();
  });
});

describe('deleteBackupConfig', () => {
  it('should delete the config', async () => {
    const { db, mocks } = createMockDb([SSH_ROW]);
    await deleteBackupConfig(db, 'cfg-1');

    expect(mocks.deleteWhere).toHaveBeenCalledOnce();
  });

  it('should throw BACKUP_CONFIG_NOT_FOUND for missing id', async () => {
    const { db } = createMockDb([]);
    await expect(deleteBackupConfig(db, 'missing')).rejects.toMatchObject({
      code: 'BACKUP_CONFIG_NOT_FOUND',
      status: 404,
    });
  });
});

describe('testConnection', () => {
  it('should return ok for a valid SSH config', async () => {
    const { db } = createMockDb([SSH_ROW]);
    const result = await testConnection(db, 'cfg-1', ENCRYPTION_KEY);

    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  it('should return ok for a valid S3 config', async () => {
    const { db } = createMockDb([S3_ROW]);
    const result = await testConnection(db, 'cfg-2', ENCRYPTION_KEY);

    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('should return error for incomplete SSH config', async () => {
    const incompleteRow = { ...SSH_ROW, sshHost: null };
    const { db } = createMockDb([incompleteRow]);
    const result = await testConnection(db, 'cfg-1', ENCRYPTION_KEY);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INCOMPLETE_CONFIG');
    expect(result.error?.message).toContain('Incomplete SSH configuration');
  });

  it('should return error for incomplete S3 config', async () => {
    const incompleteRow = { ...S3_ROW, s3AccessKeyEncrypted: null };
    const { db } = createMockDb([incompleteRow]);
    const result = await testConnection(db, 'cfg-2', ENCRYPTION_KEY);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INCOMPLETE_CONFIG');
    expect(result.error?.message).toContain('Incomplete S3 configuration');
  });
});

describe('testDraft', () => {
  it('returns ok for a well-formed S3 input', async () => {
    const result = await (await import('./service.js')).testDraft({
      storage_type: 's3',
      name: 'draft',
      s3_endpoint: 'https://s3.example.com',
      s3_bucket: 'bucket',
      s3_region: 'us-east-1',
      s3_access_key: 'A'.repeat(20),
      s3_secret_key: 'S'.repeat(40),
      retention_days: 30,
      schedule_expression: '0 2 * * *',
      enabled: true,
    });
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('returns INCOMPLETE_CONFIG for S3 input missing creds', async () => {
    const result = await (await import('./service.js')).testDraft({
      storage_type: 's3',
      name: 'draft',
      s3_endpoint: 'https://s3.example.com',
      s3_bucket: 'bucket',
      s3_region: 'us-east-1',
      // missing s3_access_key + s3_secret_key — not caught by Zod (they
      // have `.min(1)`) if the caller fakes the object, but our service
      // guard still rejects them so the draft API never pretends the
      // test succeeded without credentials.
      s3_access_key: '',
      s3_secret_key: '',
      retention_days: 30,
      schedule_expression: '0 2 * * *',
      enabled: true,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INCOMPLETE_CONFIG');
  });

  it('returns INCOMPLETE_CONFIG for SSH input missing fields', async () => {
    const result = await (await import('./service.js')).testDraft({
      storage_type: 'ssh',
      name: 'draft',
      ssh_host: '',
      ssh_port: 22,
      ssh_user: 'backup',
      ssh_key: 'key',
      ssh_path: '/backups',
      retention_days: 30,
      schedule_expression: '0 2 * * *',
      enabled: true,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INCOMPLETE_CONFIG');
  });
});
