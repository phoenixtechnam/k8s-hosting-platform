import { describe, it, expect } from 'vitest';
import { buildResticSecretEnv } from './mail-target-sync.js';
import { encrypt } from '../oidc/crypto.js';
import type { backupConfigurations } from '../../db/schema.js';

// 32-byte zero key for deterministic test ciphertext. Real installs
// inject PLATFORM_ENCRYPTION_KEY at deploy time.
const TEST_KEY = '0'.repeat(64);
const STABLE_PASSWORD = 'restic-test-password-32-chars-ok';

type BackupConfig = typeof backupConfigurations.$inferSelect;

// Minimal stub config row — only the fields buildResticSecretEnv
// reads need to be set. Anything else can stay null/undefined.
function baseConfig(): BackupConfig {
  return {
    id: 'b1',
    name: 'test-target',
    storageType: 's3',
    enabled: 1,
    active: false,
    retentionDays: 30,
    scheduleExpression: '0 2 * * *',
    s3Endpoint: null,
    s3Bucket: null,
    s3Prefix: null,
    s3Region: null,
    s3AccessKeyEncrypted: null,
    s3SecretKeyEncrypted: null,
    s3PathStyle: 0,
    sshHost: null,
    sshPort: null,
    sshUser: null,
    sshPath: null,
    sshKeyEncrypted: null,
    sshPasswordEncrypted: null,
    cifsHost: null,
    cifsShare: null,
    cifsUser: null,
    cifsPasswordEncrypted: null,
    cifsDomain: null,
    cifsPath: null,
    cifsVersion: null,
    lastSpeedtestAt: null,
    lastSpeedtestUploadMbps: null,
    lastSpeedtestDownloadMbps: null,
    lastSpeedtestLatencyMs: null,
    lastSpeedtestPayloadBytes: null,
    lastSpeedtestError: null,
    createdAt: new Date('2026-05-18T00:00:00Z'),
    updatedAt: new Date('2026-05-18T00:00:00Z'),
  } as unknown as BackupConfig;
}

describe('buildResticSecretEnv — byte-equal regression locks', () => {
  // These tests pin the exact env-var bytes the restic upload sidecar
  // sees for each storage type. The values were captured from the
  // pre-refactor `buildResticSecretData` in snapshot-settings.ts so
  // a regression here breaks existing restic repos (every restic
  // operation reads RESTIC_REPOSITORY exactly).

  it('s3 with custom endpoint produces stable repo URL + creds', () => {
    const cfg = baseConfig();
    cfg.storageType = 's3';
    cfg.s3Endpoint = 'https://fsn1.your-objectstorage.com';
    cfg.s3Bucket = 'my-bucket';
    cfg.s3Prefix = 'backups';
    cfg.s3AccessKeyEncrypted = encrypt('access-key-id', TEST_KEY);
    cfg.s3SecretKeyEncrypted = encrypt('secret-access-key', TEST_KEY);

    const env = buildResticSecretEnv(cfg, TEST_KEY, STABLE_PASSWORD);

    expect(env).toEqual({
      RESTIC_REPOSITORY: 's3:https://fsn1.your-objectstorage.com/my-bucket/backups/mail-snapshots',
      RESTIC_PASSWORD: STABLE_PASSWORD,
      AWS_ACCESS_KEY_ID: 'access-key-id',
      AWS_SECRET_ACCESS_KEY: 'secret-access-key',
    });
  });

  it('s3 without endpoint falls back to AWS path', () => {
    const cfg = baseConfig();
    cfg.storageType = 's3';
    cfg.s3Endpoint = null;
    cfg.s3Bucket = 'phx-snapshots';
    cfg.s3Prefix = null;

    const env = buildResticSecretEnv(cfg, TEST_KEY, STABLE_PASSWORD);

    expect(env.RESTIC_REPOSITORY).toBe('s3:s3.amazonaws.com/phx-snapshots/mail-snapshots');
    expect(env.AWS_ACCESS_KEY_ID).toBe('');
    expect(env.AWS_SECRET_ACCESS_KEY).toBe('');
  });

  it('ssh produces sftp URL with mail-snapshots subdir', () => {
    const cfg = baseConfig();
    cfg.storageType = 'ssh';
    cfg.sshHost = 'u123.your-storagebox.de';
    cfg.sshPort = 23;
    cfg.sshUser = 'u123';
    cfg.sshPath = '/home/u123';

    const env = buildResticSecretEnv(cfg, TEST_KEY, STABLE_PASSWORD);

    expect(env).toEqual({
      RESTIC_REPOSITORY: 'sftp:u123@u123.your-storagebox.de:/home/u123/mail-snapshots',
      RESTIC_PASSWORD: STABLE_PASSWORD,
      SFTP_HOST: 'u123.your-storagebox.de',
      SFTP_PORT: '23',
    });
  });

  it('ssh strips a trailing /mail-snapshots to avoid path doubling', () => {
    const cfg = baseConfig();
    cfg.storageType = 'ssh';
    cfg.sshHost = 'storage.example';
    cfg.sshPort = 22;
    cfg.sshUser = 'backup';
    cfg.sshPath = '/srv/restic/mail-snapshots';

    const env = buildResticSecretEnv(cfg, TEST_KEY, STABLE_PASSWORD);

    expect(env.RESTIC_REPOSITORY).toBe('sftp:backup@storage.example:/srv/restic/mail-snapshots');
  });

  it('ssh with default port + user when fields are null', () => {
    const cfg = baseConfig();
    cfg.storageType = 'ssh';
    cfg.sshHost = 'h.example';
    // sshPort + sshUser left null — defaults must match the pre-refactor
    // values (port 22, user root, sshPath defaults to /mail-snapshots
    // which gets stripped then re-appended, yielding the documented
    // double-slash quirk that real restic repos out there depend on).

    const env = buildResticSecretEnv(cfg, TEST_KEY, STABLE_PASSWORD);

    expect(env.RESTIC_REPOSITORY).toBe('sftp:root@h.example://mail-snapshots');
    expect(env.SFTP_PORT).toBe('22');
  });

  it('cifs routes to local mount path', () => {
    const cfg = baseConfig();
    cfg.storageType = 'cifs';
    cfg.cifsHost = 'host.example';
    cfg.cifsShare = 'backups';

    const env = buildResticSecretEnv(cfg, TEST_KEY, STABLE_PASSWORD);

    expect(env).toEqual({
      RESTIC_REPOSITORY: '/mnt/stalwart-cifs-blobstore/mail-snapshots',
      RESTIC_PASSWORD: STABLE_PASSWORD,
    });
  });

  it('hostpath / unknown storage_type returns empty repo (sidecar skip path)', () => {
    const cfg = baseConfig();
    cfg.storageType = 'hostpath';

    const env = buildResticSecretEnv(cfg, TEST_KEY, STABLE_PASSWORD);

    expect(env).toEqual({
      RESTIC_REPOSITORY: '',
      RESTIC_PASSWORD: STABLE_PASSWORD,
    });
  });
});
