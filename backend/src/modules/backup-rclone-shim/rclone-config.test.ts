/**
 * Unit tests for the shim config renderer. The renderer is the
 * SINGLE point of truth for what the shim DaemonSet sees — every
 * misrendering would either:
 *   - break a backup silently (wrong credentials reach the upstream)
 *   - leak unencrypted data to the upstream (missing crypt wrapper)
 *   - prevent the shim from booting (malformed rclone.conf)
 *
 * R-X16 architecture: single [upstream] + single [encrypted] crypt
 * remote, no `combine` layer, no `-raw` variants. All classes share
 * one upstream target. Tests cover:
 *   - Empty assignments
 *   - Single + multi-class with shared target
 *   - All four backend types (S3, SFTP, CIFS, NFS)
 *   - The same-target invariant (multi-target → throw)
 *   - Posix-mount + SSH-key materialisation
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

  it('emits the class name (no `:`, no `-raw`) to buckets.txt', () => {
    expect(out.bucketsTxt.split('\n').filter(Boolean)).toEqual(['system']);
    expect(out.assignedClasses).toEqual(['system']);
  });

  it('renders ONE [upstream] + ONE [encrypted] (no combine, no -raw)', () => {
    expect(out.rcloneConf).toContain('[upstream]');
    expect(out.rcloneConf).toContain('[encrypted]');
    // Legacy per-class sections must be gone.
    expect(out.rcloneConf).not.toContain('[system-upstream]');
    expect(out.rcloneConf).not.toContain('[system-raw]');
    expect(out.rcloneConf).not.toContain('[system]');
    // Combine layer is retired.
    expect(out.rcloneConf).not.toContain('[buckets]');
    expect(out.rcloneConf).not.toContain('type = combine');
  });

  it('renders S3-specific fields on [upstream]', () => {
    expect(out.rcloneConf).toContain('type = s3');
    expect(out.rcloneConf).toContain('endpoint = https://fsn1.your-objectstorage.com');
  });

  it('renders [encrypted] as a crypt remote anchored to upstream:bucket/prefix/', () => {
    expect(out.rcloneConf).toMatch(/\[encrypted\][\s\S]*type = crypt/);
    // Bucket+prefix anchor — without this, upstream PUT goes to wrong bucket.
    expect(out.rcloneConf).toContain('remote = upstream:k8s-staging/');
    expect(out.rcloneConf).toContain('filename_encryption = off');
  });

  it('renders the S3 secret_access_key as PLAINTEXT (rclone S3 backend requires plaintext)', () => {
    // rclone's S3 backend does NOT obscure secret_access_key — it reads
    // the value as-is and uses it for SigV4 signing. Earlier versions of
    // this renderer wrongly called rcloneObscure() here, which made
    // every shim-routed S3 call fail with SignatureDoesNotMatch from
    // upstream. See https://rclone.org/s3/#standard-options.
    expect(out.rcloneConf).toContain('secret_access_key = secretpass');
  });

  it('uses force_path_style + no_check_bucket for S3 compatibility', () => {
    expect(out.rcloneConf).toContain('force_path_style = true');
    expect(out.rcloneConf).toContain('no_check_bucket = true');
  });

  it('no posix mounts for S3', () => {
    expect(out.posixMounts).toEqual([]);
  });

  it('honours s3Prefix in the encrypted-remote anchor', () => {
    const t: BackupTargetConfig = { ...s3Target, s3Prefix: 'rt-test' };
    const r = renderShimConfig(FIXED_KEY, [assign('system', t)]);
    expect(r.rcloneConf).toContain('remote = upstream:k8s-staging/rt-test/');
  });
});

describe('renderShimConfig — SFTP', () => {
  const out = renderShimConfig(FIXED_KEY, [assign('system', sftpTarget)]);

  it('renders SFTP-specific fields on [upstream]', () => {
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

  it('references a single Secret-backed key_file at /etc/rclone/ssh-keys/upstream.pem when SSH key is provided', () => {
    const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nABC\n-----END OPENSSH PRIVATE KEY-----';
    const withKey: BackupTargetConfig = {
      ...sftpTarget,
      sshPassword: null,
      sshKey: pem,
    };
    const r = renderShimConfig(FIXED_KEY, [assign('system', withKey)]);
    expect(r.rcloneConf).toContain('key_file = /etc/rclone/ssh-keys/upstream.pem');
    expect(r.rcloneConf).not.toContain('-----BEGIN OPENSSH');
    expect(r.sshKeyMaterializations).toEqual([{ pemContent: pem }]);
  });

  it('empty sshKeyMaterializations when SFTP target uses password auth', () => {
    expect(out.sshKeyMaterializations).toEqual([]);
  });

  it('encodes sshPath into the [encrypted] crypt remote (sftp backend has no `path =` option)', () => {
    // Regression: SFTP targets with a non-empty sshPath used to be
    // silently dropped — all writes landed at the remote-user's
    // $HOME, not the configured subdirectory.
    const withPath: BackupTargetConfig = { ...sftpTarget, sshPath: 'backup/subdir' };
    const r = renderShimConfig(FIXED_KEY, [assign('system', withPath)]);
    expect(r.rcloneConf).toContain('remote = upstream:backup/subdir/');
  });

  it('strips leading/trailing slashes on sshPath', () => {
    const withPath: BackupTargetConfig = { ...sftpTarget, sshPath: '/backup/' };
    const r = renderShimConfig(FIXED_KEY, [assign('system', withPath)]);
    expect(r.rcloneConf).toContain('remote = upstream:backup/');
    // No double-slash artefact at the join point.
    expect(r.rcloneConf).not.toContain('remote = upstream:/');
  });

  it('omits the anchor segment when sshPath is null (writes to $HOME)', () => {
    const noPath: BackupTargetConfig = { ...sftpTarget, sshPath: null };
    const r = renderShimConfig(FIXED_KEY, [assign('system', noPath)]);
    expect(r.rcloneConf).toContain('remote = upstream:\n');
  });
});

describe('renderShimConfig — CIFS', () => {
  const out = renderShimConfig(FIXED_KEY, [assign('mail', cifsTarget)]);

  it('emits a single posix mount entry for CIFS', () => {
    expect(out.posixMounts).toHaveLength(1);
    expect(out.posixMounts[0].storageType).toBe('cifs');
    // R-X16: shared upstream → one fixed mountpoint per shim pod.
    expect(out.posixMounts[0].mountPath).toBe('/mnt/backup-cifs');
  });

  it('renders an alias rclone backend pointing at the mount + cifs_path', () => {
    expect(out.rcloneConf).toContain('[upstream]');
    expect(out.rcloneConf).toContain('type = alias');
    expect(out.rcloneConf).toContain('remote = /mnt/backup-cifs/backup');
  });
});

describe('renderShimConfig — NFS', () => {
  const out = renderShimConfig(FIXED_KEY, [assign('tenant', nfsTarget)]);

  it('emits a single posix mount entry for NFS', () => {
    expect(out.posixMounts).toHaveLength(1);
    expect(out.posixMounts[0].storageType).toBe('nfs');
    expect(out.posixMounts[0].mountPath).toBe('/mnt/backup-nfs');
    expect(out.posixMounts[0].target.nfsExport).toBe('/exports/backup');
  });

  it('points the alias remote at the mount path with no sub-path by default', () => {
    expect(out.rcloneConf).toContain('remote = /mnt/backup-nfs');
    // No subpath appended when nfsPath is null/undefined.
    expect(out.rcloneConf).not.toContain('remote = /mnt/backup-nfs/');
  });

  it('appends nfsPath when provided', () => {
    const withPath: BackupTargetConfig = { ...nfsTarget, nfsPath: 'subdir/here' };
    const r = renderShimConfig(FIXED_KEY, [assign('tenant', withPath)]);
    expect(r.rcloneConf).toContain('remote = /mnt/backup-nfs/subdir/here');
  });

  it('normalises nfsPath with a leading slash', () => {
    const withPath: BackupTargetConfig = { ...nfsTarget, nfsPath: '/subdir' };
    const r = renderShimConfig(FIXED_KEY, [assign('tenant', withPath)]);
    expect(r.rcloneConf).toContain('remote = /mnt/backup-nfs/subdir');
  });
});

describe('renderShimConfig — multi-class with shared target', () => {
  const out = renderShimConfig(FIXED_KEY, [
    assign('mail', s3Target),
    assign('system', s3Target),
    assign('tenant', s3Target),
  ]);

  it('emits one bare class name per assignment (no `:`, no `-raw`)', () => {
    expect(out.bucketsTxt.split('\n').filter(Boolean)).toEqual([
      'mail',
      'system',
      'tenant',
    ]);
  });

  it('renders only ONE [upstream] + ONE [encrypted] section (shared)', () => {
    const upstreamCount = (out.rcloneConf.match(/^\[upstream\]$/gm) ?? []).length;
    const encryptedCount = (out.rcloneConf.match(/^\[encrypted\]$/gm) ?? []).length;
    expect(upstreamCount).toBe(1);
    expect(encryptedCount).toBe(1);
  });

  it('returns assignedClasses in alphabetical order', () => {
    expect(out.assignedClasses).toEqual(['mail', 'system', 'tenant']);
  });

  it('collects exactly one posix mount when the shared target is CIFS', () => {
    const r = renderShimConfig(FIXED_KEY, [
      assign('system', cifsTarget),
      assign('mail', cifsTarget),
    ]);
    expect(r.posixMounts).toHaveLength(1);
  });
});

describe('renderShimConfig — multi-target rejection', () => {
  it('throws when two classes are bound to different upstream targets', () => {
    expect(() =>
      renderShimConfig(FIXED_KEY, [
        assign('system', s3Target),
        assign('mail', sftpTarget),
      ]),
    ).toThrow(/must share one upstream target/);
  });

  it('error message names BOTH targets so the operator can see which to fix', () => {
    try {
      renderShimConfig(FIXED_KEY, [
        assign('system', s3Target),
        assign('mail', sftpTarget),
      ]);
      throw new Error('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain(s3Target.name);
      expect(msg).toContain(sftpTarget.name);
    }
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

  it('is insensitive to assignment order (same target shared across classes)', () => {
    const ordered = [
      assign('system', s3Target),
      assign('tenant', s3Target),
      assign('mail', s3Target),
    ];
    const reordered = [
      assign('mail', s3Target),
      assign('tenant', s3Target),
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
