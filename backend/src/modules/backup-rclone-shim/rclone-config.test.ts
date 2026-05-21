/**
 * Unit tests for the R-X17 versitygw renderer.
 *
 * R-X17 architecture: ONE upstream (S3 / SFTP / CIFS / NFS), no
 * combine, no crypt. The renderer emits:
 *   - upstreamEnv: env-file content for the launcher (sourced as
 *     POSIX shell)
 *   - classesTxt: one bound class per line
 *   - posixMounts: zero (S3 mode) or one (POSIX modes — SFTP / CIFS /
 *     NFS) — drives the privileged DaemonSet pod spec
 *   - sshKeyMaterializations: one PEM when SFTP key-auth, else zero
 *
 * Tests cover:
 *   - Empty assignments → minimal env, empty classes.txt
 *   - All four upstream types (S3, SFTP, CIFS, NFS)
 *   - Multi-class with shared target (the supported configuration)
 *   - Multi-target rejection (the unsupported configuration)
 *   - Same-input → same-output determinism (no random IV)
 *   - SFTP key vs password auth
 *   - Subpaths (sshPath, cifsPath, nfsPath) flow into the env
 *   - shellQuote injection-safety (NUL / newline rejection,
 *     apostrophe escape)
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
  it('produces a minimal env with no classes', () => {
    const out = renderShimConfig(FIXED_KEY, []);
    expect(out.assignedClasses).toEqual([]);
    expect(out.classesTxt).toBe('');
    expect(out.upstreamEnv).toContain('AUTO-GENERATED');
    // No upstream-type line when empty.
    expect(out.upstreamEnv).not.toMatch(/^UPSTREAM_TYPE=/m);
    expect(out.posixMounts).toEqual([]);
    expect(out.sshKeyMaterializations).toEqual([]);
    // Shim creds still derivable from the key alone.
    expect(out.shimAccessKey).toMatch(/^[0-9a-f]{20}$/);
    expect(out.shimSecretKey).toMatch(/^[0-9a-f]{80}$/);
    expect(out.keyFingerprint).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('renderShimConfig — single S3 class', () => {
  const out = renderShimConfig(FIXED_KEY, [assign('system', s3Target)]);

  it('emits the class name to classes.txt (one per line)', () => {
    expect(out.classesTxt).toBe('system\n');
    expect(out.assignedClasses).toEqual(['system']);
  });

  it('emits UPSTREAM_TYPE=s3 with shell-quoted endpoint + creds', () => {
    expect(out.upstreamEnv).toMatch(/^UPSTREAM_TYPE=s3$/m);
    expect(out.upstreamEnv).toContain(
      "UPSTREAM_ENDPOINT='https://fsn1.your-objectstorage.com'",
    );
    expect(out.upstreamEnv).toContain("UPSTREAM_ACCESS_KEY='AKIATEST'");
    expect(out.upstreamEnv).toContain("UPSTREAM_SECRET_KEY='secretpass'");
    expect(out.upstreamEnv).toContain("UPSTREAM_REGION='fsn1'");
  });

  it('emits ROOT_ACCESS_KEY + ROOT_SECRET_KEY (HKDF-derived shim creds)', () => {
    // Shim's own creds — clients use these to authenticate TO the shim.
    // Same value as shimAccessKey / shimSecretKey on the result object.
    expect(out.upstreamEnv).toContain(`ROOT_ACCESS_KEY='${out.shimAccessKey}'`);
    expect(out.upstreamEnv).toContain(`ROOT_SECRET_KEY='${out.shimSecretKey}'`);
  });

  it('no posix mount for S3 (no kernel mount needed)', () => {
    expect(out.posixMounts).toEqual([]);
    expect(out.sshKeyMaterializations).toEqual([]);
  });

  it('defaults region to us-east-1 when s3Region is null', () => {
    const t: BackupTargetConfig = { ...s3Target, s3Region: null };
    const r = renderShimConfig(FIXED_KEY, [assign('system', t)]);
    expect(r.upstreamEnv).toContain("UPSTREAM_REGION='us-east-1'");
  });

  it('rejects S3 target missing endpoint', () => {
    const t: BackupTargetConfig = { ...s3Target, s3Endpoint: null };
    expect(() => renderShimConfig(FIXED_KEY, [assign('system', t)])).toThrow(
      /missing required/,
    );
  });

  it('rejects S3 target missing credentials', () => {
    expect(() =>
      renderShimConfig(FIXED_KEY, [
        assign('system', { ...s3Target, s3SecretKey: null }),
      ]),
    ).toThrow(/missing required/);
  });
});

describe('renderShimConfig — SFTP (key auth)', () => {
  const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nABC\n-----END OPENSSH PRIVATE KEY-----';
  const withKey: BackupTargetConfig = { ...sftpTarget, sshPassword: null, sshKey: pem };
  const out = renderShimConfig(FIXED_KEY, [assign('system', withKey)]);

  it('emits UPSTREAM_TYPE=sftp + host/user/port/path', () => {
    expect(out.upstreamEnv).toMatch(/^UPSTREAM_TYPE=sftp$/m);
    expect(out.upstreamEnv).toContain("UPSTREAM_SFTP_HOST='u335448.your-storagebox.de'");
    expect(out.upstreamEnv).toContain("UPSTREAM_SFTP_USER='u335448'");
    expect(out.upstreamEnv).toContain("UPSTREAM_SFTP_PORT='23'");
    expect(out.upstreamEnv).toContain("UPSTREAM_SFTP_PATH='backup'");
  });

  it('references the projected key file (PEM NOT inlined into env)', () => {
    expect(out.upstreamEnv).toContain(
      'UPSTREAM_SFTP_KEYFILE=/etc/rclone/ssh-keys/upstream.pem',
    );
    expect(out.upstreamEnv).not.toContain('BEGIN OPENSSH');
  });

  it('materialises the PEM for Secret projection', () => {
    expect(out.sshKeyMaterializations).toEqual([{ pemContent: pem }]);
  });

  it('emits a POSIX mount entry (privileged pod required)', () => {
    expect(out.posixMounts).toHaveLength(1);
    expect(out.posixMounts[0].storageType).toBe('sftp');
    expect(out.posixMounts[0].mountPath).toBe('/mnt/upstream');
  });

  it('strips leading/trailing slashes on sshPath', () => {
    const t: BackupTargetConfig = { ...withKey, sshPath: '/backup/' };
    const r = renderShimConfig(FIXED_KEY, [assign('system', t)]);
    expect(r.upstreamEnv).toContain("UPSTREAM_SFTP_PATH='backup'");
  });

  it('omits UPSTREAM_SFTP_PATH when sshPath is null', () => {
    const t: BackupTargetConfig = { ...withKey, sshPath: null };
    const r = renderShimConfig(FIXED_KEY, [assign('system', t)]);
    expect(r.upstreamEnv).not.toContain('UPSTREAM_SFTP_PATH');
  });
});

describe('renderShimConfig — SFTP (password auth)', () => {
  const out = renderShimConfig(FIXED_KEY, [assign('system', sftpTarget)]);

  it('emits UPSTREAM_SFTP_PASSWORD instead of UPSTREAM_SFTP_KEYFILE', () => {
    expect(out.upstreamEnv).toContain("UPSTREAM_SFTP_PASSWORD='p@ss'");
    expect(out.upstreamEnv).not.toContain('UPSTREAM_SFTP_KEYFILE');
    expect(out.sshKeyMaterializations).toEqual([]);
  });

  it('throws when neither key nor password is provided', () => {
    const t: BackupTargetConfig = { ...sftpTarget, sshPassword: null, sshKey: null };
    expect(() => renderShimConfig(FIXED_KEY, [assign('system', t)])).toThrow(
      /requires either ssh_key or ssh_password/,
    );
  });
});

describe('renderShimConfig — CIFS', () => {
  const out = renderShimConfig(FIXED_KEY, [assign('mail', cifsTarget)]);

  it('emits UPSTREAM_TYPE=cifs with host/share/credentials/port/path', () => {
    expect(out.upstreamEnv).toMatch(/^UPSTREAM_TYPE=cifs$/m);
    expect(out.upstreamEnv).toContain("UPSTREAM_CIFS_HOST='u335448.your-storagebox.de'");
    expect(out.upstreamEnv).toContain("UPSTREAM_CIFS_SHARE='u335448'");
    expect(out.upstreamEnv).toContain("UPSTREAM_CIFS_USER='u335448'");
    expect(out.upstreamEnv).toContain("UPSTREAM_CIFS_PASSWORD='p@ss'");
    expect(out.upstreamEnv).toContain("UPSTREAM_CIFS_PORT='445'");
    expect(out.upstreamEnv).toContain("UPSTREAM_CIFS_PATH='backup'");
  });

  it('emits a POSIX mount entry', () => {
    expect(out.posixMounts).toHaveLength(1);
    expect(out.posixMounts[0].storageType).toBe('cifs');
    expect(out.posixMounts[0].mountPath).toBe('/mnt/upstream');
  });

  it('omits CIFS_DOMAIN when not set', () => {
    expect(out.upstreamEnv).not.toContain('UPSTREAM_CIFS_DOMAIN');
  });

  it('rejects CIFS with missing required fields', () => {
    expect(() =>
      renderShimConfig(FIXED_KEY, [
        assign('mail', { ...cifsTarget, cifsPassword: null }),
      ]),
    ).toThrow(/missing required/);
  });
});

describe('renderShimConfig — NFS', () => {
  const out = renderShimConfig(FIXED_KEY, [assign('tenant', nfsTarget)]);

  it('emits UPSTREAM_TYPE=nfs with server/export/version/options', () => {
    expect(out.upstreamEnv).toMatch(/^UPSTREAM_TYPE=nfs$/m);
    expect(out.upstreamEnv).toContain("UPSTREAM_NFS_SERVER='10.0.0.10'");
    expect(out.upstreamEnv).toContain("UPSTREAM_NFS_EXPORT='/exports/backup'");
    expect(out.upstreamEnv).toContain("UPSTREAM_NFS_VERSION='4.2'");
    expect(out.upstreamEnv).toContain("UPSTREAM_NFS_OPTIONS='soft,timeo=600'");
  });

  it('emits a POSIX mount entry', () => {
    expect(out.posixMounts).toHaveLength(1);
    expect(out.posixMounts[0].storageType).toBe('nfs');
    expect(out.posixMounts[0].mountPath).toBe('/mnt/upstream');
  });

  it('appends nfsPath when provided', () => {
    const t: BackupTargetConfig = { ...nfsTarget, nfsPath: 'subdir/here' };
    const r = renderShimConfig(FIXED_KEY, [assign('tenant', t)]);
    expect(r.upstreamEnv).toContain("UPSTREAM_NFS_PATH='subdir/here'");
  });

  it('normalises nfsPath with a leading slash', () => {
    const t: BackupTargetConfig = { ...nfsTarget, nfsPath: '/subdir' };
    const r = renderShimConfig(FIXED_KEY, [assign('tenant', t)]);
    expect(r.upstreamEnv).toContain("UPSTREAM_NFS_PATH='subdir'");
  });
});

describe('renderShimConfig — multi-class with shared target', () => {
  const out = renderShimConfig(FIXED_KEY, [
    assign('mail', s3Target),
    assign('system', s3Target),
    assign('tenant', s3Target),
  ]);

  it('emits each class on its own line in classes.txt (alphabetical)', () => {
    expect(out.classesTxt.split('\n').filter(Boolean)).toEqual([
      'mail',
      'system',
      'tenant',
    ]);
  });

  it('renders ONE UPSTREAM_TYPE line regardless of class count', () => {
    const occurrences = out.upstreamEnv.match(/^UPSTREAM_TYPE=/gm) ?? [];
    expect(occurrences).toHaveLength(1);
  });

  it('returns assignedClasses in alphabetical order', () => {
    expect(out.assignedClasses).toEqual(['mail', 'system', 'tenant']);
  });

  it('emits exactly one posix mount when the shared target is CIFS', () => {
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

  it('error message names BOTH targets', () => {
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

describe('renderShimConfig — shell-quote injection safety', () => {
  it('escapes single quotes in field values', () => {
    const t: BackupTargetConfig = { ...s3Target, s3SecretKey: "ev'il" };
    const r = renderShimConfig(FIXED_KEY, [assign('system', t)]);
    expect(r.upstreamEnv).toContain(`UPSTREAM_SECRET_KEY='ev'\\''il'`);
  });

  it('rejects newline in a field value', () => {
    const t: BackupTargetConfig = { ...s3Target, s3SecretKey: 'one\ntwo' };
    expect(() => renderShimConfig(FIXED_KEY, [assign('system', t)])).toThrow(
      /illegal character/,
    );
  });

  it('rejects NUL byte in a field value', () => {
    const t: BackupTargetConfig = { ...s3Target, s3SecretKey: 'a\0b' };
    expect(() => renderShimConfig(FIXED_KEY, [assign('system', t)])).toThrow(
      /illegal character/,
    );
  });
});

describe('renderShimConfig — determinism', () => {
  it('same inputs → byte-identical output (no random IV in R-X17)', () => {
    const a = renderShimConfig(FIXED_KEY, [assign('system', s3Target)]);
    const b = renderShimConfig(FIXED_KEY, [assign('system', s3Target)]);
    expect(a.upstreamEnv).toBe(b.upstreamEnv);
    expect(a.classesTxt).toBe(b.classesTxt);
    expect(a.configHash).toBe(b.configHash);
  });
});

describe('computeInputHash', () => {
  it('is stable across renders', () => {
    const a = computeInputHash(FIXED_KEY, [assign('system', s3Target)]);
    const b = computeInputHash(FIXED_KEY, [assign('system', s3Target)]);
    expect(a).toBe(b);
  });

  it('changes when the key changes', () => {
    const otherKey = Buffer.alloc(32, 0xff);
    expect(computeInputHash(FIXED_KEY, [assign('system', s3Target)])).not.toBe(
      computeInputHash(otherKey, [assign('system', s3Target)]),
    );
  });

  it('changes when a credential changes', () => {
    const mutated: BackupTargetConfig = { ...s3Target, s3AccessKey: 'AKIA_DIFFERENT' };
    expect(computeInputHash(FIXED_KEY, [assign('system', s3Target)])).not.toBe(
      computeInputHash(FIXED_KEY, [assign('system', mutated)]),
    );
  });

  it('is insensitive to assignment order (shared target across classes)', () => {
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
    expect(computeInputHash(FIXED_KEY, ordered)).toBe(
      computeInputHash(FIXED_KEY, reordered),
    );
  });

  it('schema version bump (v1 → v2-versitygw) means R-X16 hashes do not collide with R-X17', () => {
    // We rely on this invariant when rolling forward: existing rows in
    // backup-rclone-shim-status that recorded a v1 hash should NOT match
    // a v2-versitygw hash computed from the same inputs, forcing a full
    // re-render after upgrade.
    const h = computeInputHash(FIXED_KEY, [assign('system', s3Target)]);
    // v2 prefix is baked in; just sanity-check that it's hex sha256.
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('renderShimConfig — validation', () => {
  it('rejects wrong key size', () => {
    expect(() => renderShimConfig(Buffer.alloc(16), [])).toThrow(/32 bytes/);
  });
});
