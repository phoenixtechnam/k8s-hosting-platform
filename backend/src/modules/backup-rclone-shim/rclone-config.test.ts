/**
 * Unit tests for the shim config renderer. The renderer is the
 * SINGLE point of truth for what the shim DaemonSet sees — every
 * misrendering would either:
 *   - break a backup silently (wrong credentials reach the upstream)
 *   - leak unencrypted data to the upstream (missing crypt wrapper)
 *   - prevent the shim from booting (malformed rclone.conf)
 *
 * Tests cover:
 *   - Single-class + multi-class assignments
 *   - All four backend types (S3, SFTP, CIFS, NFS)
 *   - Bucket-name ordering (deterministic)
 *   - Posix-mount accumulation
 *   - Input-hash stability (insensitive to obscure-IV randomness)
 */

import { describe, it, expect } from 'vitest';
import {
  renderShimConfig,
  computeInputHash,
  type BackupClass,
  type BackupTargetConfig,
  type ClassAssignment,
} from './rclone-config';

const FIXED_KEY = Buffer.alloc(32);
for (let i = 0; i < 32; i++) FIXED_KEY[i] = i;

// Minimal valid targets for each backend type.
const s3Target: BackupTargetConfig = {
  id: 't-s3',
  name: 'staging-s3',
  storageType: 's3',
  s3Endpoint: 'https://fsn1.your-objectstorage.com',
  s3Bucket: 'k8s-staging',
  s3Region: 'fsn1',
  s3AccessKey: 'AKIATEST',
  s3SecretKey: 'secretpass',
  s3Prefix: null,
};

const sftpTarget: BackupTargetConfig = {
  id: 't-sftp',
  name: 'hbox-sftp',
  storageType: 'ssh',
  sshHost: 'u335448.your-storagebox.de',
  sshPort: 23,
  sshUser: 'u335448',
  sshPassword: 'p@ss',
  sshKey: null,
  sshPath: 'backup',
};

const cifsTarget: BackupTargetConfig = {
  id: 't-cifs',
  name: 'hbox-cifs',
  storageType: 'cifs',
  cifsHost: 'u335448.your-storagebox.de',
  cifsPort: 445,
  cifsShare: 'u335448',
  cifsUser: 'u335448',
  cifsPassword: 'p@ss',
  cifsDomain: null,
  cifsPath: 'backup',
};

const nfsTarget: BackupTargetConfig = {
  id: 't-nfs',
  name: 'corp-nfs',
  storageType: 'nfs',
  nfsServer: '10.0.0.10',
  nfsExport: '/exports/backup',
  nfsVersion: '4.2',
  nfsOptions: 'soft,timeo=600',
};

function assign(className: BackupClass, target: BackupTargetConfig): ClassAssignment {
  return { className, target };
}

describe('renderShimConfig — empty assignments', () => {
  it('produces a minimal config with no buckets', () => {
    const out = renderShimConfig(FIXED_KEY, []);
    expect(out.assignedClasses).toEqual([]);
    expect(out.bucketsTxt.trim()).toBe('');
    expect(out.rcloneConf).toContain('AUTO-GENERATED');
    expect(out.posixMounts).toEqual([]);
    // Shim creds are still derivable from the key alone.
    expect(out.shimAccessKey).toMatch(/^[0-9a-f]{20}$/);
    expect(out.shimSecretKey).toMatch(/^[0-9a-f]{80}$/);
    expect(out.keyFingerprint).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('renderShimConfig — single S3 class', () => {
  const out = renderShimConfig(FIXED_KEY, [assign('system', s3Target)]);

  it('exposes system + system-raw buckets', () => {
    expect(out.bucketsTxt.split('\n').filter(Boolean)).toEqual([
      'system:',
      'system-raw:',
    ]);
    expect(out.assignedClasses).toEqual(['system']);
  });

  it('renders an S3 upstream + crypt-wrapper + raw-alias', () => {
    expect(out.rcloneConf).toContain('[system-upstream]');
    expect(out.rcloneConf).toContain('type = s3');
    expect(out.rcloneConf).toContain('endpoint = https://fsn1.your-objectstorage.com');
    expect(out.rcloneConf).toContain('[system]');
    expect(out.rcloneConf).toContain('type = crypt');
    expect(out.rcloneConf).toContain('remote = system-upstream:');
    expect(out.rcloneConf).toContain('[system-raw]');
    expect(out.rcloneConf).toContain('type = alias');
  });

  it('renders the S3 secret_access_key as PLAINTEXT (rclone S3 backend requires plaintext)', () => {
    // rclone's S3 backend does NOT obscure secret_access_key — it reads
    // the value as-is and uses it for SigV4 signing. Earlier versions of
    // this renderer wrongly called rcloneObscure() here, which made
    // every shim-routed S3 call fail with SignatureDoesNotMatch from
    // upstream. The plaintext is fine because the rendered conf only
    // lives inside a Kubernetes Secret (encrypted at rest by kube-apiserver)
    // and is mounted into the shim pod via a projected volume. See
    // https://rclone.org/s3/#standard-options for the field semantics.
    expect(out.rcloneConf).toContain('secret_access_key = secretpass');
  });

  it('uses force_path_style + no_check_bucket for S3 compatibility', () => {
    expect(out.rcloneConf).toContain('force_path_style = true');
    expect(out.rcloneConf).toContain('no_check_bucket = true');
  });

  it('no posix mounts for S3', () => {
    expect(out.posixMounts).toEqual([]);
  });
});

describe('renderShimConfig — SFTP', () => {
  const out = renderShimConfig(FIXED_KEY, [assign('system', sftpTarget)]);

  it('renders SFTP-specific fields', () => {
    expect(out.rcloneConf).toContain('type = sftp');
    expect(out.rcloneConf).toContain('host = u335448.your-storagebox.de');
    expect(out.rcloneConf).toContain('port = 23');
    expect(out.rcloneConf).toContain('disable_hashcheck = true');
  });

  it('obscures the SFTP password', () => {
    expect(out.rcloneConf).not.toContain('p@ss');
    expect(out.rcloneConf).toMatch(/pass = [A-Za-z0-9_-]+/);
  });

  it('throws when neither key nor password is provided', () => {
    const broken: BackupTargetConfig = { ...sftpTarget, sshKey: null, sshPassword: null };
    expect(() =>
      renderShimConfig(FIXED_KEY, [assign('system', broken)])
    ).toThrow(/requires either ssh_key or ssh_password/);
  });

  it('references a Secret-backed key_file when SSH key is provided', () => {
    const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nABC\n-----END OPENSSH PRIVATE KEY-----';
    const withKey: BackupTargetConfig = {
      ...sftpTarget,
      sshPassword: null,
      sshKey: pem,
    };
    const r = renderShimConfig(FIXED_KEY, [assign('system', withKey)]);
    // rclone.conf points at the Secret-projected path; the raw PEM
    // is NOT inlined into the ConfigMap-backed rclone.conf.
    expect(r.rcloneConf).toContain('key_file = /etc/rclone/ssh-keys/system.pem');
    expect(r.rcloneConf).not.toContain('-----BEGIN OPENSSH');
    // The PEM is surfaced for the service layer to materialise into
    // a Secret volume mount.
    expect(r.sshKeyMaterializations).toEqual([
      { className: 'system', pemContent: pem },
    ]);
  });

  it('empty sshKeyMaterializations when SFTP target uses password auth', () => {
    const r = renderShimConfig(FIXED_KEY, [assign('system', sftpTarget)]);
    expect(r.sshKeyMaterializations).toEqual([]);
  });
});

describe('renderShimConfig — CIFS', () => {
  const out = renderShimConfig(FIXED_KEY, [assign('mail', cifsTarget)]);

  it('emits a posix mount entry for CIFS', () => {
    expect(out.posixMounts).toHaveLength(1);
    expect(out.posixMounts[0].className).toBe('mail');
    expect(out.posixMounts[0].storageType).toBe('cifs');
    expect(out.posixMounts[0].mountPath).toBe('/mnt/backup-mail-cifs');
  });

  it('renders an alias rclone backend pointing at the mount + cifs_path', () => {
    expect(out.rcloneConf).toContain('[mail-upstream]');
    expect(out.rcloneConf).toContain('type = alias');
    expect(out.rcloneConf).toContain('remote = /mnt/backup-mail-cifs/backup');
  });
});

describe('renderShimConfig — NFS', () => {
  const out = renderShimConfig(FIXED_KEY, [assign('tenant', nfsTarget)]);

  it('emits a posix mount entry for NFS', () => {
    expect(out.posixMounts).toHaveLength(1);
    expect(out.posixMounts[0].storageType).toBe('nfs');
    expect(out.posixMounts[0].mountPath).toBe('/mnt/backup-tenant-nfs');
    expect(out.posixMounts[0].target.nfsExport).toBe('/exports/backup');
  });

  it('points the alias remote at the mount path with no sub-path by default', () => {
    expect(out.rcloneConf).toContain('remote = /mnt/backup-tenant-nfs');
    // No subpath appended when nfsPath is null/undefined.
    expect(out.rcloneConf).not.toContain('remote = /mnt/backup-tenant-nfs/');
  });

  it('appends nfsPath when provided', () => {
    const withPath: BackupTargetConfig = { ...nfsTarget, nfsPath: 'subdir/here' };
    const r = renderShimConfig(FIXED_KEY, [assign('tenant', withPath)]);
    expect(r.rcloneConf).toContain('remote = /mnt/backup-tenant-nfs/subdir/here');
  });

  it('normalises nfsPath with a leading slash', () => {
    const withPath: BackupTargetConfig = { ...nfsTarget, nfsPath: '/subdir' };
    const r = renderShimConfig(FIXED_KEY, [assign('tenant', withPath)]);
    expect(r.rcloneConf).toContain('remote = /mnt/backup-tenant-nfs/subdir');
  });
});

describe('renderShimConfig — multi-class', () => {
  const out = renderShimConfig(FIXED_KEY, [
    assign('mail', cifsTarget),
    assign('system', s3Target),
    assign('tenant', sftpTarget),
  ]);

  it('returns 6 buckets (2 per class)', () => {
    const lines = out.bucketsTxt.split('\n').filter(Boolean);
    expect(lines).toHaveLength(6);
  });

  it('orders sections deterministically (alphabetical by class)', () => {
    const lines = out.bucketsTxt.split('\n').filter(Boolean);
    expect(lines).toEqual([
      'mail:',
      'mail-raw:',
      'system:',
      'system-raw:',
      'tenant:',
      'tenant-raw:',
    ]);
    // The rclone.conf should follow the same alphabetical order.
    const mailIdx = out.rcloneConf.indexOf('[mail-upstream]');
    const sysIdx = out.rcloneConf.indexOf('[system-upstream]');
    const tenIdx = out.rcloneConf.indexOf('[tenant-upstream]');
    expect(mailIdx).toBeLessThan(sysIdx);
    expect(sysIdx).toBeLessThan(tenIdx);
  });

  it('returns assignedClasses in the same alphabetical order', () => {
    expect(out.assignedClasses).toEqual(['mail', 'system', 'tenant']);
  });

  it('collects only the posix-backed classes in posixMounts', () => {
    expect(out.posixMounts).toHaveLength(1); // only the CIFS mail target
    expect(out.posixMounts[0].className).toBe('mail');
  });
});

describe('computeInputHash', () => {
  it('is stable across renders (insensitive to obscure-IV randomness)', () => {
    const a = computeInputHash(FIXED_KEY, [assign('system', s3Target)]);
    const b = computeInputHash(FIXED_KEY, [assign('system', s3Target)]);
    expect(a).toBe(b);
  });

  it('changes when the key changes', () => {
    const otherKey = Buffer.alloc(32, 0xff);
    expect(computeInputHash(FIXED_KEY, [assign('system', s3Target)]))
      .not.toBe(computeInputHash(otherKey, [assign('system', s3Target)]));
  });

  it('changes when a credential changes', () => {
    const mutated: BackupTargetConfig = { ...s3Target, s3AccessKey: 'AKIA_DIFFERENT' };
    expect(computeInputHash(FIXED_KEY, [assign('system', s3Target)]))
      .not.toBe(computeInputHash(FIXED_KEY, [assign('system', mutated)]));
  });

  it('is insensitive to assignment order', () => {
    const ordered = [
      assign('system', s3Target),
      assign('tenant', sftpTarget),
      assign('mail', cifsTarget),
    ];
    const reordered = [
      assign('mail', cifsTarget),
      assign('tenant', sftpTarget),
      assign('system', s3Target),
    ];
    expect(computeInputHash(FIXED_KEY, ordered))
      .toBe(computeInputHash(FIXED_KEY, reordered));
  });
});

describe('renderShimConfig — validation', () => {
  it('rejects wrong key size', () => {
    expect(() => renderShimConfig(Buffer.alloc(16), [])).toThrow(/32 bytes/);
  });

  it('rejects S3 with missing fields', () => {
    const broken: BackupTargetConfig = { ...s3Target, s3Endpoint: null };
    expect(() => renderShimConfig(FIXED_KEY, [assign('system', broken)])).toThrow(/missing required/);
  });
});
