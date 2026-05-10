import { describe, expect, it } from 'vitest';
import {
  resolveBackupTarget,
  type BackupConfigurationRow,
} from './resolve-backup-target.js';

const KEY = '0'.repeat(64);

const baseS3: BackupConfigurationRow = {
  id: 'cfg-1',
  storageType: 's3',
  s3Endpoint: 'https://fsn1.your-objectstorage.com',
  s3Bucket: 'k8s-staging',
  s3Region: 'fsn1',
  s3Prefix: 'tenant-bundles',
  s3AccessKeyEncrypted: 'enc-AK',
  s3SecretKeyEncrypted: 'enc-SK',
  sshHost: null,
  sshPort: null,
  sshUser: null,
  sshKeyEncrypted: null,
  sshPath: null,
};

const baseSsh: BackupConfigurationRow = {
  id: 'cfg-2',
  storageType: 'ssh',
  s3Endpoint: null,
  s3Bucket: null,
  s3Region: null,
  s3Prefix: null,
  s3AccessKeyEncrypted: null,
  s3SecretKeyEncrypted: null,
  sshHost: 'u123.your-storagebox.de',
  sshPort: 23,
  sshUser: 'u123',
  sshKeyEncrypted: 'enc-KEY',
  sshPath: 'platform-backups',
};

const baseHost: BackupConfigurationRow = {
  id: 'cfg-3',
  storageType: 'hostpath',
  s3Endpoint: null,
  s3Bucket: null,
  s3Region: null,
  s3Prefix: null,
  s3AccessKeyEncrypted: null,
  s3SecretKeyEncrypted: null,
  sshHost: null,
  sshPort: null,
  sshUser: null,
  sshKeyEncrypted: null,
  sshPath: null,
  hostpathPath: '/var/lib/platform/backups',
};

const fakeDecrypt = (ct: string) => ct.replace(/^enc-/, 'PLAIN_');

describe('resolveBackupTarget', () => {
  it('shapes an s3 row into a BackupTarget kind=s3', () => {
    const t = resolveBackupTarget(baseS3, { secretsKeyHex: KEY, decryptFn: fakeDecrypt });
    expect(t).toEqual({
      kind: 's3',
      s3Endpoint: 'https://fsn1.your-objectstorage.com',
      s3Bucket: 'k8s-staging',
      s3Region: 'fsn1',
      s3Prefix: 'tenant-bundles',
      s3AccessKey: 'PLAIN_AK',
      s3SecretKey: 'PLAIN_SK',
    });
  });

  it('shapes an ssh row into a BackupTarget kind=ssh with default port 22 if missing', () => {
    const row = { ...baseSsh, sshPort: null };
    const t = resolveBackupTarget(row, { secretsKeyHex: KEY, decryptFn: fakeDecrypt });
    expect(t).toEqual({
      kind: 'ssh',
      sshHost: 'u123.your-storagebox.de',
      sshPort: 22,
      sshUser: 'u123',
      sshKey: 'PLAIN_KEY',
      sshPath: 'platform-backups',
    });
  });

  it('shapes a hostpath row into a BackupTarget kind=hostpath', () => {
    const t = resolveBackupTarget(baseHost, { secretsKeyHex: KEY, decryptFn: fakeDecrypt });
    expect(t).toEqual({ kind: 'hostpath', hostPath: '/var/lib/platform/backups' });
  });

  it('rejects an s3 row that is missing creds', () => {
    expect(() =>
      resolveBackupTarget(
        { ...baseS3, s3AccessKeyEncrypted: null },
        { secretsKeyHex: KEY, decryptFn: fakeDecrypt },
      ),
    ).toThrow(/credentials/);
  });

  it('rejects an s3 row missing endpoint or bucket', () => {
    expect(() =>
      resolveBackupTarget(
        { ...baseS3, s3Endpoint: null },
        { secretsKeyHex: KEY, decryptFn: fakeDecrypt },
      ),
    ).toThrow(/endpoint/);
    expect(() =>
      resolveBackupTarget(
        { ...baseS3, s3Bucket: null },
        { secretsKeyHex: KEY, decryptFn: fakeDecrypt },
      ),
    ).toThrow(/bucket/);
  });

  it('rejects an ssh row missing required fields', () => {
    expect(() =>
      resolveBackupTarget(
        { ...baseSsh, sshKeyEncrypted: null },
        { secretsKeyHex: KEY, decryptFn: fakeDecrypt },
      ),
    ).toThrow(/SSH/);
    expect(() =>
      resolveBackupTarget(
        { ...baseSsh, sshPath: null },
        { secretsKeyHex: KEY, decryptFn: fakeDecrypt },
      ),
    ).toThrow(/SSH/);
  });

  it('translates decrypt errors into CONFIG_INVALID rather than leaking', () => {
    const failing = (() => {
      throw new Error('GCM tag mismatch');
    }) as never;
    expect(() => resolveBackupTarget(baseS3, { secretsKeyHex: KEY, decryptFn: failing })).toThrow(
      /S3 credential decryption failed/,
    );
    expect(() => resolveBackupTarget(baseSsh, { secretsKeyHex: KEY, decryptFn: failing })).toThrow(
      /SSH key decryption failed/,
    );
  });

  it('rejects unknown storage types', () => {
    expect(() =>
      resolveBackupTarget(
        { ...baseS3, storageType: 'azure' },
        { secretsKeyHex: KEY, decryptFn: fakeDecrypt },
      ),
    ).toThrow(/azure/);
  });

  it('rejects hostpath rows with no path', () => {
    expect(() =>
      resolveBackupTarget(
        { ...baseHost, hostpathPath: null },
        { secretsKeyHex: KEY, decryptFn: fakeDecrypt },
      ),
    ).toThrow(/hostpath/);
  });
});
