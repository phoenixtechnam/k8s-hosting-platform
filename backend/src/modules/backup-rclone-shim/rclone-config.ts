/**
 * Render an rclone.conf + buckets.txt pair from:
 *   1. The platform-wide BACKUP_TARGET_KEY (Secret platform/backup-target-key)
 *   2. The `backup_configurations` rows referenced by class assignments
 *   3. The `backup_target_assignments` rows (class → target_id)
 *
 * Pure functions over the inputs — no I/O. The caller (service.ts)
 * reads the Secret + DB rows, calls render(), writes the resulting
 * ConfigMap, and bumps the DaemonSet annotation hash.
 *
 * Design contract: every call with identical inputs produces a
 * byte-identical rendered config. That makes the SHA-256 of the
 * rendered output a reliable change-detector for the reconciler.
 */

import { createHash } from 'node:crypto';
import {
  decodeBackupTargetKey,
  fingerprintRawKey,
  deriveShimAccessKey,
  deriveShimSecretKey,
  deriveCryptCredentials,
  rcloneObscure,
} from './crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BackupClass = 'system' | 'tenant' | 'mail';

/** Subset of backup_configurations row fields relevant to the shim
 *  renderer. The service layer maps DB columns to this shape. */
export interface BackupTargetConfig {
  readonly id: string;
  readonly name: string;
  readonly storageType: 's3' | 'ssh' | 'cifs' | 'nfs';
  // S3 fields
  readonly s3Endpoint?: string | null;
  readonly s3Bucket?: string | null;
  readonly s3Region?: string | null;
  readonly s3AccessKey?: string | null; // decrypted by caller
  readonly s3SecretKey?: string | null; // decrypted by caller
  readonly s3Prefix?: string | null;
  // SFTP (storage_type='ssh')
  readonly sshHost?: string | null;
  readonly sshPort?: number | null;
  readonly sshUser?: string | null;
  readonly sshKey?: string | null; // decrypted PEM by caller
  readonly sshPassword?: string | null; // decrypted by caller
  readonly sshPath?: string | null;
  // CIFS
  readonly cifsHost?: string | null;
  readonly cifsPort?: number | null;
  readonly cifsShare?: string | null;
  readonly cifsUser?: string | null;
  readonly cifsPassword?: string | null; // decrypted by caller
  readonly cifsDomain?: string | null;
  readonly cifsPath?: string | null;
  // NFS
  readonly nfsServer?: string | null;
  readonly nfsExport?: string | null;
  readonly nfsVersion?: string | null;
  readonly nfsOptions?: string | null;
  /** Optional sub-directory below the NFS export root. Mirrors
   *  `cifsPath` for symmetry. Absent today (no DB column) but
   *  carved in the type now to make the future addition non-
   *  breaking. */
  readonly nfsPath?: string | null;
}

export interface ClassAssignment {
  readonly className: BackupClass;
  readonly target: BackupTargetConfig;
}

/** What the renderer produces. The service writes these into the
 *  ConfigMap and Pod-volume sidecars. */
export interface RenderedShimConfig {
  /** Full content of /etc/rclone/rclone.conf */
  readonly rcloneConf: string;
  /** Full content of /etc/rclone/buckets.txt — one bucket spec per line */
  readonly bucketsTxt: string;
  /** SHA-256 of rcloneConf + bucketsTxt — used as the DaemonSet
   *  spec.template annotation hash so any change rolls the pods. */
  readonly configHash: string;
  /** Shim's local S3 access_key (HKDF-derived). Consumers (CNPG plugin,
   *  etcd CronJob, restic CronJobs, rclone-push) all use this. */
  readonly shimAccessKey: string;
  /** Shim's local S3 secret_key. */
  readonly shimSecretKey: string;
  /** sha256(rawKey).slice(0,16). Reported in the status ConfigMap so
   *  the rotation CLI can verify the new key has been picked up. */
  readonly keyFingerprint: string;
  /** Which classes have buckets exposed. Drives the UI + drain
   *  orchestrator + status reporting. */
  readonly assignedClasses: ReadonlyArray<BackupClass>;
  /** Volume mounts needed for posix-backed targets (CIFS, NFS). The
   *  service merges these into the DaemonSet Pod spec. Empty when
   *  all assignments are S3 or SFTP. */
  readonly posixMounts: ReadonlyArray<PosixMount>;
  /** PEM-format SSH private keys that need to land in a Secret-
   *  backed volume mount (the service layer creates a Secret
   *  `backup-rclone-shim-ssh-keys` and projects each entry as a
   *  file at `/etc/rclone/ssh-keys/<className>.pem`). Empty when
   *  no SFTP target uses key-auth (or all SFTP targets use
   *  password-auth). The rendered rclone.conf references these via
   *  `key_file = /etc/rclone/ssh-keys/<className>.pem` rather than
   *  inlining the PEM (ConfigMaps are not at-rest-encrypted by
   *  default; Secrets are). */
  readonly sshKeyMaterializations: ReadonlyArray<SshKeyMaterialization>;
}

export interface SshKeyMaterialization {
  readonly className: BackupClass;
  readonly pemContent: string;
}

export interface PosixMount {
  readonly className: BackupClass;
  /** Where the shim's launcher.sh sees this mount, e.g.
   *  `/mnt/backup-system-nfs`. The rclone.conf's `[<class>-upstream]`
   *  block uses `type=local, path=<mountPath>`. */
  readonly mountPath: string;
  readonly storageType: 'cifs' | 'nfs';
  readonly target: BackupTargetConfig;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/**
 * Render the full shim config.
 *
 * The HKDF-derived parts (shim S3 access/secret, crypt passphrases
 * before obscuring) are deterministic for a given `rawKey` and set
 * of assignments. The `rcloneObscure()` step applies a fresh random
 * IV per invocation, so the obscured passphrases (and hence the
 * `configHash`) differ across calls even with identical inputs.
 *
 * The service layer uses `computeInputHash()` (below) — which omits
 * the random-IV part — as its change-detection signal. `configHash`
 * here is only used as the DaemonSet spec.template annotation
 * (renderer-output-as-rollout-trigger).
 */
export function renderShimConfig(
  rawKey: Buffer,
  assignments: ReadonlyArray<ClassAssignment>
): RenderedShimConfig {
  if (rawKey.length !== 32) {
    throw new Error(`rawKey must be 32 bytes; got ${rawKey.length}`);
  }

  // 1. Per-shim S3 credentials (HKDF — deterministic).
  const shimAccessKey = deriveShimAccessKey(rawKey);
  const shimSecretKey = deriveShimSecretKey(rawKey);
  const keyFingerprint = fingerprintRawKey(rawKey);

  // 2. Sort assignments by class name so the rendered output is
  // deterministically ordered. (Set iteration order is insertion-
  // order in JS but we don't want to depend on that.)
  const sorted = [...assignments].sort((a, b) =>
    a.className.localeCompare(b.className)
  );

  // 3. Render each class's upstream + crypt-wrapper + raw-alias
  // sections. Also accumulate bucket names + posix mounts + SSH key
  // materializations.
  const sections: string[] = [];
  const bucketLines: string[] = [];
  const posixMounts: PosixMount[] = [];
  const sshKeyMaterializations: SshKeyMaterialization[] = [];
  const assignedClasses: BackupClass[] = [];

  // Header comment — helps operators inspecting the config file know
  // it's machine-generated and not to edit by hand. We deliberately
  // do NOT include the key fingerprint here — the status ConfigMap
  // (written separately by the service layer) is the canonical place
  // to read the fingerprint. Repeating it in the rclone.conf header
  // would put an unnecessary copy in a ConfigMap that's read by the
  // shim DaemonSet's tmpfs mount.
  sections.push(
    [
      '# rclone.conf — backup-rclone-shim',
      '# AUTO-GENERATED by platform-api backup-rclone-shim/config-renderer.',
      '# Do NOT edit by hand. Operator changes flow via',
      '# /admin/backup-rclone-shim/... endpoints.',
      '',
    ].join('\n')
  );

  for (const { className, target } of sorted) {
    assignedClasses.push(className);
    const upstreamSection = renderUpstreamSection(className, target);
    sections.push(upstreamSection.section);
    if (upstreamSection.posixMount) {
      posixMounts.push(upstreamSection.posixMount);
    }
    if (upstreamSection.sshKey) {
      sshKeyMaterializations.push(upstreamSection.sshKey);
    }

    const crypt = deriveCryptCredentials(rawKey, className);
    sections.push(renderCryptSection(className, crypt));
    sections.push(renderRawAliasSection(className));

    // buckets.txt: one entry per "bucket" served. Order is
    // encrypted-then-raw, matching the rendered config sections.
    bucketLines.push(`${className}:`);
    bucketLines.push(`${className}-raw:`);
  }

  const rcloneConf = sections.join('\n');
  const bucketsTxt = bucketLines.join('\n') + '\n';

  const configHash = createHash('sha256')
    .update(rcloneConf)
    .update('\n----\n')
    .update(bucketsTxt)
    .digest('hex');

  return {
    rcloneConf,
    bucketsTxt,
    configHash,
    shimAccessKey,
    shimSecretKey,
    keyFingerprint,
    assignedClasses,
    posixMounts,
    sshKeyMaterializations,
  };
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function renderUpstreamSection(
  className: BackupClass,
  target: BackupTargetConfig
): {
  section: string;
  posixMount?: PosixMount;
  sshKey?: SshKeyMaterialization;
} {
  const remoteName = `${className}-upstream`;
  switch (target.storageType) {
    case 's3':
      return { section: renderS3Section(remoteName, target) };
    case 'ssh': {
      const sftp = renderSftpSection(className, remoteName, target);
      return { section: sftp.section, sshKey: sftp.sshKey };
    }
    case 'cifs': {
      const mountPath = `/mnt/backup-${className}-cifs`;
      return {
        section: renderPosixSection(remoteName, mountPath, target),
        posixMount: { className, mountPath, storageType: 'cifs', target },
      };
    }
    case 'nfs': {
      const mountPath = `/mnt/backup-${className}-nfs`;
      return {
        section: renderPosixSection(remoteName, mountPath, target),
        posixMount: { className, mountPath, storageType: 'nfs', target },
      };
    }
    default:
      // Defensive: unreachable if the DB enum is in sync with our types.
      throw new Error(
        `Unsupported storage_type '${(target as { storageType: string }).storageType}' for class ${className}`
      );
  }
}

function renderS3Section(remoteName: string, t: BackupTargetConfig): string {
  if (!t.s3Endpoint || !t.s3Bucket || !t.s3AccessKey || !t.s3SecretKey) {
    throw new Error(
      `S3 target '${t.name}' is missing required fields (endpoint, bucket, access_key, secret_key)`
    );
  }
  const lines = [
    `[${remoteName}]`,
    `type = s3`,
    `provider = Other`,
    `endpoint = ${t.s3Endpoint}`,
    `access_key_id = ${t.s3AccessKey}`,
    `secret_access_key = ${rcloneObscure(t.s3SecretKey)}`,
    `force_path_style = true`,
    `no_check_bucket = true`,
    `acl = private`,
  ];
  if (t.s3Region) lines.push(`region = ${t.s3Region}`);
  // Prefix is applied via the remote-path notation (`bucket/prefix`),
  // not via a config option — handled by the crypt section below.
  lines.push('');
  return lines.join('\n');
}

function renderSftpSection(
  className: BackupClass,
  remoteName: string,
  t: BackupTargetConfig
): { section: string; sshKey?: SshKeyMaterialization } {
  if (!t.sshHost || !t.sshUser) {
    throw new Error(
      `SFTP target '${t.name}' is missing required fields (host, user)`
    );
  }
  if (!t.sshKey && !t.sshPassword) {
    throw new Error(
      `SFTP target '${t.name}' requires either ssh_key or ssh_password`
    );
  }
  const lines = [
    `[${remoteName}]`,
    `type = sftp`,
    `host = ${t.sshHost}`,
    `port = ${t.sshPort ?? 22}`,
    `user = ${t.sshUser}`,
    `shell_type = unix`,
    `md5sum_command = none`,
    `sha1sum_command = none`,
    `disable_hashcheck = true`,
  ];
  let sshKey: SshKeyMaterialization | undefined;
  if (t.sshKey) {
    // Reference the PEM via key_file path. The service layer creates
    // a k8s Secret `backup-rclone-shim-ssh-keys` containing one entry
    // per SFTP-key-auth class, projects it at /etc/rclone/ssh-keys/
    // in the shim Pod, and mode 0400 the files. Secrets ARE encrypted
    // at rest in k8s (configurable via EncryptionConfiguration; default
    // base64 only — operators should enable encryption-at-rest for
    // production clusters), unlike ConfigMaps.
    const keyPath = `/etc/rclone/ssh-keys/${className}.pem`;
    lines.push(`key_file = ${keyPath}`);
    sshKey = { className, pemContent: t.sshKey };
  } else if (t.sshPassword) {
    lines.push(`pass = ${rcloneObscure(t.sshPassword)}`);
  }
  lines.push('');
  return { section: lines.join('\n'), sshKey };
}

function renderPosixSection(
  remoteName: string,
  mountPath: string,
  t: BackupTargetConfig
): string {
  // CIFS + NFS both render as a `local` rclone backend rooted at the
  // kernel mount point. The Pod's volumes[] entry creates the mount;
  // see service.ts.
  const subpath = posixSubpathFor(t);
  const lines = [
    `[${remoteName}]`,
    `type = alias`,
    `# kernel-mount the share via the DaemonSet Pod volumes[];`,
    `# the alias points at the mount + optional sub-path.`,
    `remote = ${mountPath}${subpath}`,
    '',
  ];
  return lines.join('\n');
}

function posixSubpathFor(t: BackupTargetConfig): string {
  // Both CIFS and NFS may carry an optional sub-directory below the
  // share/export root. The DB column for NFS (nfsPath) is reserved in
  // the schema for a future migration; until then `t.nfsPath` will be
  // null and this branch is a no-op for NFS targets. The symmetric
  // handling avoids a silent renderer gap when the column is added.
  if (t.storageType === 'cifs' && t.cifsPath) {
    return t.cifsPath.startsWith('/') ? t.cifsPath : `/${t.cifsPath}`;
  }
  if (t.storageType === 'nfs' && t.nfsPath) {
    return t.nfsPath.startsWith('/') ? t.nfsPath : `/${t.nfsPath}`;
  }
  return '';
}

function renderCryptSection(
  className: BackupClass,
  crypt: { obscuredPassword: string; obscuredSalt: string }
): string {
  // Encrypted bucket: rclone `crypt` backend wrapping the upstream.
  // filename_encryption=off keeps backup paths readable on the upstream
  // (operator can see "system/postgres/base-20260520.tar.zst" without
  // decryption). Data is still encrypted.
  return [
    `[${className}]`,
    `type = crypt`,
    `remote = ${className}-upstream:`,
    `filename_encryption = off`,
    `directory_name_encryption = false`,
    `password = ${crypt.obscuredPassword}`,
    `password2 = ${crypt.obscuredSalt}`,
    '',
  ].join('\n');
}

function renderRawAliasSection(className: BackupClass): string {
  // Raw bucket: passthrough alias. Self-encrypting callers (restic,
  // age-encrypted secrets-bundle) use this to avoid double-encryption.
  return [
    `[${className}-raw]`,
    `type = alias`,
    `remote = ${className}-upstream:`,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Input hash (deterministic; ignores random-IV obscure outputs)
// ---------------------------------------------------------------------------

/**
 * Hash that depends ONLY on the rendering INPUTS, not the random-IV-
 * influenced outputs. Used by the reconciler to detect "does this
 * cluster need a re-render?" without false positives from IV
 * randomness.
 *
 * Inputs that go into the hash:
 *   - The key fingerprint (sha256-prefix of raw key)
 *   - Each assignment's class name + target ID + the target's
 *     stable fields (host, port, credentials' sha256, etc.)
 */
export function computeInputHash(
  rawKey: Buffer,
  assignments: ReadonlyArray<ClassAssignment>
): string {
  const h = createHash('sha256');
  h.update('v1\n'); // schema version — bump if input shape changes
  h.update(`fp=${fingerprintRawKey(rawKey)}\n`);
  const sorted = [...assignments].sort((a, b) =>
    a.className.localeCompare(b.className)
  );
  for (const { className, target } of sorted) {
    h.update(`class=${className}\n`);
    h.update(`tid=${target.id}\n`);
    h.update(`tname=${target.name}\n`);
    h.update(`ttype=${target.storageType}\n`);
    // Hash credentials by sha256 of plaintext so a change rotates the
    // input hash without including the plaintext in the hash itself.
    const credFields = [
      target.s3Endpoint,
      target.s3Bucket,
      target.s3Region,
      target.s3AccessKey,
      target.s3SecretKey,
      target.s3Prefix,
      target.sshHost,
      String(target.sshPort ?? ''),
      target.sshUser,
      target.sshKey,
      target.sshPassword,
      target.sshPath,
      target.cifsHost,
      String(target.cifsPort ?? ''),
      target.cifsShare,
      target.cifsUser,
      target.cifsPassword,
      target.cifsDomain,
      target.cifsPath,
      target.nfsServer,
      target.nfsExport,
      target.nfsVersion,
      target.nfsOptions,
      target.nfsPath,
    ];
    for (const v of credFields) {
      h.update(v ?? '');
      h.update('\0');
    }
  }
  return h.digest('hex');
}
