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
  deriveSharedCryptCredentials,
  rcloneObscure,
} from './crypto.js';

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
   *  all assignments are S3 or SFTP. With the unified architecture
   *  (R-X16) at most one PosixMount exists — all classes share the
   *  same upstream target. The array shape is kept so callers
   *  iterating over it don't need branching. */
  readonly posixMounts: ReadonlyArray<PosixMount>;
  /** PEM-format SSH private keys that need to land in a Secret-
   *  backed volume mount (the service layer creates a Secret
   *  `backup-rclone-shim-ssh-keys` and projects each entry as a
   *  file at `/etc/rclone/ssh-keys/upstream.pem`). Empty when the
   *  SFTP target uses password auth, or the upstream is not SFTP.
   *  Array (rather than scalar) because the same Secret-projection
   *  contract still applies to multi-key configs introduced later. */
  readonly sshKeyMaterializations: ReadonlyArray<SshKeyMaterialization>;
}

export interface SshKeyMaterialization {
  readonly pemContent: string;
}

export interface PosixMount {
  /** Where the shim's launcher.sh sees this mount, e.g.
   *  `/mnt/backup-nfs`. The rclone.conf's `[upstream]` block uses
   *  `type=alias, remote=<mountPath><subpath>`. */
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

  // 3. Validate: all assignments must share the SAME upstream target.
  // The unified architecture (one [upstream] + one [encrypted] crypt
  // wrapper, no combine) serves all classes through a SINGLE rclone
  // serve s3 process. Multiple distinct upstream targets would
  // require multiple rclone processes (one per upstream) — operators
  // wanting that should run separate shim DaemonSets per target.
  // Surfaced 2026-05-20: rclone serve s3 + combine + crypt has a
  // LIST traversal bug that broke barman-cloud-backup-show and every
  // restic enumeration. Dropping combine fixes LIST; the constraint
  // documented here is the price.
  const sections: string[] = [];
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
      '#',
      '# Architecture: ONE [upstream] + ONE [encrypted] crypt remote.',
      '# Top-level dirs inside [encrypted]: become buckets when callers',
      '# write to them via the served s3 endpoint. Class names',
      '# (system / tenant / mail) are reserved by convention.',
      '',
    ].join('\n'),
  );

  if (sorted.length === 0) {
    // No assignments — emit a minimal config (header only). The
    // launcher.sh detects an empty buckets.txt and sleeps until the
    // reconciler renders content.
    return {
      rcloneConf: sections.join('\n'),
      bucketsTxt: '',
      configHash: createHash('sha256').update(sections.join('\n')).digest('hex'),
      shimAccessKey,
      shimSecretKey,
      keyFingerprint,
      assignedClasses,
      posixMounts,
      sshKeyMaterializations,
    };
  }

  // Enforce same-upstream-target invariant. Two targets match when
  // their target ID is the same (the row's primary key). Operators
  // can bind multiple classes to the SAME target — that's the common
  // case — but cannot mix classes across different targets in one
  // shim DaemonSet.
  const firstTarget = sorted[0].target;
  for (const { className, target } of sorted) {
    if (target.id !== firstTarget.id) {
      throw new Error(
        `backup-rclone-shim: class '${className}' is bound to target '${target.name}' (${target.id}), but other classes are bound to '${firstTarget.name}' (${firstTarget.id}). All shim classes must share one upstream target. Either rebind all classes to the same target, or deploy separate shim DaemonSets per target.`,
      );
    }
  }

  // Render the SINGLE upstream + crypt pair. The crypt's `remote =`
  // points at the upstream's bucket+prefix anchor — without this,
  // rclone's S3 backend would treat the first path segment of any
  // write as the upstream bucket name, returning NoSuchBucket on
  // every PUT. See upstreamRemotePath().
  const target = firstTarget;
  const upstreamSection = renderUpstreamSection(target);
  sections.push(upstreamSection.section);
  if (upstreamSection.posixMount) {
    posixMounts.push(upstreamSection.posixMount);
  }
  if (upstreamSection.sshKey) {
    sshKeyMaterializations.push(upstreamSection.sshKey);
  }

  const crypt = deriveSharedCryptCredentials(rawKey);
  const upstreamPath = upstreamRemotePath(target);
  sections.push(renderEncryptedSection(crypt, upstreamPath));

  // buckets.txt is now a list of CLASS NAMES (no `:` suffix, no
  // `-raw` variants). The launcher uses it for two things:
  //  1) Sanity check that at least one class is assigned (non-empty
  //     buckets.txt → bind exists → reconciler completed).
  //  2) Operator-readable record of which classes this shim serves.
  // The launcher always runs `rclone serve s3 encrypted:` — top-
  // level dirs inside the served tree become buckets automatically
  // when callers write to them, so no static bucket list is needed.
  for (const { className } of sorted) {
    assignedClasses.push(className);
  }
  const bucketLines: string[] = [...assignedClasses];

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

function renderUpstreamSection(target: BackupTargetConfig): {
  section: string;
  posixMount?: PosixMount;
  sshKey?: SshKeyMaterialization;
} {
  // Fixed remote name `upstream` (was `<className>-upstream` in the
  // legacy combine architecture). Single shared upstream, single
  // crypt wrapper on top.
  const remoteName = 'upstream';
  switch (target.storageType) {
    case 's3':
      return { section: renderS3Section(remoteName, target) };
    case 'ssh': {
      const sftp = renderSftpSection(remoteName, target);
      return { section: sftp.section, sshKey: sftp.sshKey };
    }
    case 'cifs': {
      const mountPath = `/mnt/backup-cifs`;
      return {
        section: renderPosixSection(remoteName, mountPath, target),
        posixMount: { mountPath, storageType: 'cifs', target },
      };
    }
    case 'nfs': {
      const mountPath = `/mnt/backup-nfs`;
      return {
        section: renderPosixSection(remoteName, mountPath, target),
        posixMount: { mountPath, storageType: 'nfs', target },
      };
    }
    default:
      // Defensive: unreachable if the DB enum is in sync with our types.
      throw new Error(
        `Unsupported storage_type '${(target as { storageType: string }).storageType}'`,
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
    // rclone's S3 backend stores secret_access_key as PLAINTEXT, NOT obscured.
    // Only crypt's password/password2 and sftp's `pass` go through obscure.
    // We previously called rcloneObscure() here, which made rclone sign every
    // upstream request with the literal obscured string — upstream Ceph
    // returned SignatureDoesNotMatch (403) on every shim-routed call.
    // The secret only lives in a Kubernetes Secret (kubectl-encrypted at
    // rest), so the obscure step gave zero confidentiality anyway. See
    // https://rclone.org/s3/#standard-options — `secret_access_key` is a
    // plain string field.
    `secret_access_key = ${t.s3SecretKey}`,
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
    // Single shim, single SFTP key — file named `upstream.pem` to match
    // the consolidated upstream remote naming.
    const keyPath = `/etc/rclone/ssh-keys/upstream.pem`;
    lines.push(`key_file = ${keyPath}`);
    sshKey = { pemContent: t.sshKey };
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

/**
 * Build the path component to append to `<className>-upstream:` so that
 * crypt + alias writes land in the correct bucket+prefix on the upstream
 * provider. Trailing slash is significant — without it, rclone treats
 * the segment as a file name and overwrites/erroneously-strips.
 */
function upstreamRemotePath(t: BackupTargetConfig): string {
  if (t.storageType === 's3' && t.s3Bucket) {
    const prefix = t.s3Prefix?.replace(/^\/+|\/+$/g, '') ?? '';
    return prefix.length > 0
      ? `${t.s3Bucket}/${prefix}/`
      : `${t.s3Bucket}/`;
  }
  if (t.storageType === 'ssh' && t.sshPath) {
    // rclone's sftp backend does NOT expose a `path =` config option —
    // the working directory is the remote-user's $HOME. Operators who
    // want backups in a subdirectory (e.g. `backup/` on a Hetzner
    // Storage Box) must encode that as part of the crypt's `remote =`
    // line: `remote = upstream:backup/`. Strip leading/trailing
    // slashes and append a trailing slash so crypt treats it as a
    // directory (without the trailing slash rclone would treat
    // `backup` as a file name on first write).
    const sub = t.sshPath.replace(/^\/+|\/+$/g, '');
    return sub.length > 0 ? `${sub}/` : '';
  }
  // CIFS, NFS have their paths baked into the alias `remote =` line
  // built by renderPosixSection (mount path + optional sub-path); no
  // extra anchor component needed at the crypt layer.
  return '';
}

function renderEncryptedSection(
  crypt: { obscuredPassword: string; obscuredSalt: string },
  upstreamPath: string,
): string {
  // Single crypt remote layered on top of the upstream's bucket+prefix
  // anchor. `rclone serve s3 encrypted:` then serves the top-level
  // directories inside this remote as S3 buckets — class names
  // (system / tenant / mail) become buckets when callers first write
  // to them.
  //
  // filename_encryption=off keeps backup paths readable on the upstream
  // (operator can see "system/postgres/base-20260520.tar.zst" without
  // decryption). Data is still encrypted.
  //
  // Self-encrypting callers (restic, age-encrypted secrets-bundle)
  // double-encrypt through this layer. Cost is negligible — AES-CTR
  // with AES-NI is ~1 GB/s per core. The R-X10 launcher previously
  // exposed `<class>-raw` passthrough aliases to avoid the second
  // pass; we dropped those because they required a combine layer
  // that broke rclone's LIST traversal.
  return [
    `[encrypted]`,
    `type = crypt`,
    `remote = upstream:${upstreamPath}`,
    `filename_encryption = off`,
    `directory_name_encryption = false`,
    `password = ${crypt.obscuredPassword}`,
    `password2 = ${crypt.obscuredSalt}`,
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
