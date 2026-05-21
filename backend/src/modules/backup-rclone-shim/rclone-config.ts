/**
 * Render the shim config (R-X17 — versitygw architecture).
 *
 * Inputs:
 *   1. The platform-wide BACKUP_TARGET_KEY (Secret platform/backup-target-key)
 *   2. The `backup_configurations` rows referenced by class assignments
 *   3. The `backup_target_assignments` rows (class → target_id)
 *
 * Outputs:
 *   - `upstreamEnv` — env-file content for the shim launcher.sh. Encodes
 *     the operator-selected upstream (S3 / SFTP / CIFS / NFS) plus the
 *     shim's own HKDF-derived S3 credentials that clients use to
 *     authenticate to the shim.
 *   - `classesTxt` — one bound class per line (`system\ntenant\nmail`).
 *     The launcher validates each line against a strict allowlist
 *     before pre-creating buckets on POSIX-mode upstreams.
 *   - `posixMounts` — one entry when the upstream is CIFS/NFS/SFTP;
 *     drives the DaemonSet's privileged-mode + volume layout.
 *   - `sshKeyMaterializations` — SFTP PEM material to project into a
 *     Secret-backed volume (file mounted at /etc/rclone/ssh-keys/upstream.pem).
 *
 * Pure functions over the inputs — no I/O. The caller (reconciler.ts)
 * reads the Secret + DB rows, calls render(), writes the resulting
 * ConfigMap + Secret + DaemonSet patch.
 *
 * Why versitygw vs. rclone serve s3:
 *   rclone's ListObjectsV2 returns CommonPrefixes WITHOUT a trailing
 *   slash, which barman-cloud-backup-show + restic + boto3 rely on
 *   to recognise backup directories. versitygw emits the trailing
 *   slash correctly. The combine + crypt layering we previously used
 *   to multiplex per-class buckets is also gone — versitygw POSIX
 *   exposes top-level dirs as buckets natively, and versitygw S3 is
 *   a direct proxy (operator creates one upstream bucket per class).
 *
 * Encryption model (R-X17 difference vs. R-X16):
 *   No rclone-crypt layer. Self-encrypting callers (restic, age, age-
 *   encrypted secrets-bundle) encrypt with their own keys. Postgres
 *   backups can use barman-cloud `--encryption AES256` (SSE-S3) or
 *   `--sse-c-key-base64` (customer-managed key, sent per-request).
 *   See BACKUP_ARCHITECTURE_RFC §13a-iii for the per-caller crypto
 *   matrix.
 */

import { createHash } from 'node:crypto';
import {
  decodeBackupTargetKey,
  fingerprintRawKey,
  deriveShimAccessKey,
  deriveShimSecretKey,
} from './crypto.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BackupClass = 'system' | 'tenant' | 'mail';

/** Subset of backup_configurations row fields relevant to the shim
 *  renderer. The service layer maps DB columns to this shape and
 *  decrypts encrypted columns before passing them in. */
export interface BackupTargetConfig {
  readonly id: string;
  readonly name: string;
  readonly storageType: 's3' | 'ssh' | 'cifs' | 'nfs';
  // S3 fields
  readonly s3Endpoint?: string | null;
  readonly s3Bucket?: string | null;
  readonly s3Region?: string | null;
  readonly s3AccessKey?: string | null;
  readonly s3SecretKey?: string | null;
  readonly s3Prefix?: string | null;
  /** When true (default), pass `--use-path-style` to versitygw. When
   *  false, omit it so versitygw uses virtual-hosted-style URLs
   *  (`bucket.endpoint`). Required for AWS S3 in regions that no longer
   *  accept path-style. Null/undefined = legacy rows = treat as true. */
  readonly s3UsePathStyle?: boolean | null;
  // SFTP (storage_type='ssh')
  readonly sshHost?: string | null;
  readonly sshPort?: number | null;
  readonly sshUser?: string | null;
  readonly sshKey?: string | null;
  readonly sshPassword?: string | null;
  readonly sshPath?: string | null;
  // CIFS
  readonly cifsHost?: string | null;
  readonly cifsPort?: number | null;
  readonly cifsShare?: string | null;
  readonly cifsUser?: string | null;
  readonly cifsPassword?: string | null;
  readonly cifsDomain?: string | null;
  readonly cifsPath?: string | null;
  // NFS
  readonly nfsServer?: string | null;
  readonly nfsExport?: string | null;
  readonly nfsVersion?: string | null;
  readonly nfsOptions?: string | null;
  readonly nfsPath?: string | null;
}

export interface ClassAssignment {
  readonly className: BackupClass;
  readonly target: BackupTargetConfig;
}

/** What the renderer produces. The service writes these into the
 *  Secret + ConfigMap + DaemonSet patch. */
export interface RenderedShimConfig {
  /** env-file content for the shim launcher (UPSTREAM_TYPE + per-type
   *  fields + the shim's ROOT_ACCESS_KEY / ROOT_SECRET_KEY). Written
   *  to the credentials Secret (NOT a ConfigMap — contains the
   *  upstream provider's plaintext secret_access_key). */
  readonly upstreamEnv: string;
  /** One bound class per line. Written to the ConfigMap as
   *  `classes.txt`. */
  readonly classesTxt: string;
  /** SHA-256 of upstreamEnv + classesTxt — used as the DaemonSet
   *  spec.template annotation hash so any change rolls the pods. */
  readonly configHash: string;
  /** Shim's own S3 access_key (HKDF-derived). Clients use this to
   *  authenticate to the shim's S3 endpoint. The same value goes into
   *  the `backup-rclone-shim-creds` Secret that callers (CNPG plugin,
   *  etcd CronJob, restic CronJobs, rclone-push) consume. */
  readonly shimAccessKey: string;
  /** Shim's own S3 secret_key. */
  readonly shimSecretKey: string;
  /** sha256(rawKey).slice(0,16). Reported in the status ConfigMap so
   *  the rotation CLI can verify the new key has been picked up. */
  readonly keyFingerprint: string;
  /** Which classes have an upstream bound. Drives the UI + drain
   *  orchestrator + status reporting. */
  readonly assignedClasses: ReadonlyArray<BackupClass>;
  /** Volume mounts needed for posix-backed targets (CIFS, NFS, SFTP).
   *  R-X17: SFTP is now a POSIX mount via sshfs (FUSE), so all three
   *  remote types are uniformly "POSIX upstream". The service merges
   *  these into the DaemonSet Pod spec — privileged mode is enabled
   *  iff this array is non-empty. */
  readonly posixMounts: ReadonlyArray<PosixMount>;
  /** PEM-format SSH private keys to project into a Secret volume at
   *  /etc/rclone/ssh-keys/upstream.pem. Empty when SFTP target uses
   *  password auth, or the upstream is not SFTP. */
  readonly sshKeyMaterializations: ReadonlyArray<SshKeyMaterialization>;
}

export interface SshKeyMaterialization {
  readonly pemContent: string;
}

export interface PosixMount {
  /** Always `/mnt/upstream` in R-X17 — the launcher mounts the
   *  single shared upstream at one fixed mount point. The shape is
   *  retained as a record so the DaemonSet patcher knows to add the
   *  CAP_SYS_ADMIN / privileged bits + the mount-helper volume. */
  readonly mountPath: string;
  readonly storageType: 'sftp' | 'cifs' | 'nfs';
  readonly target: BackupTargetConfig;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

const MOUNT_POINT = '/mnt/upstream';

/**
 * Render the shim config from a 32-byte BACKUP_TARGET_KEY and a list
 * of class→target assignments.
 *
 * Constraint: all assignments must share one upstream target. The
 * shim runs ONE versitygw instance per pod which serves ONE upstream;
 * multi-target operators deploy separate shim DaemonSets per tier.
 * Multi-target binding → throw at render time with an actionable
 * error.
 */
export function renderShimConfig(
  rawKey: Buffer,
  assignments: ReadonlyArray<ClassAssignment>,
): RenderedShimConfig {
  if (rawKey.length !== 32) {
    throw new Error(`rawKey must be 32 bytes; got ${rawKey.length}`);
  }

  const shimAccessKey = deriveShimAccessKey(rawKey);
  const shimSecretKey = deriveShimSecretKey(rawKey);
  const keyFingerprint = fingerprintRawKey(rawKey);

  const sorted = [...assignments].sort((a, b) =>
    a.className.localeCompare(b.className),
  );

  // Empty assignments → minimal env (no upstream) + empty classes.txt.
  // The launcher detects this and sleeps until the reconciler renders
  // real content.
  if (sorted.length === 0) {
    const upstreamEnv = renderEnvHeader();
    return {
      upstreamEnv,
      classesTxt: '',
      configHash: createHash('sha256').update(upstreamEnv).digest('hex'),
      shimAccessKey,
      shimSecretKey,
      keyFingerprint,
      assignedClasses: [],
      posixMounts: [],
      sshKeyMaterializations: [],
    };
  }

  // Enforce same-upstream-target invariant.
  const firstTarget = sorted[0].target;
  for (const { className, target } of sorted) {
    if (target.id !== firstTarget.id) {
      throw new Error(
        `backup-rclone-shim: class '${className}' is bound to target '${target.name}' (${target.id}), but other classes are bound to '${firstTarget.name}' (${firstTarget.id}). All shim classes must share one upstream target. Either rebind all classes to the same target, or deploy separate shim DaemonSets per target.`,
      );
    }
  }

  const target = firstTarget;
  const assignedClasses = sorted.map((s) => s.className);

  const { envBody, posixMount, sshKey } = renderUpstreamEnv(
    target,
    shimAccessKey,
    shimSecretKey,
  );

  const upstreamEnv = renderEnvHeader() + envBody;
  const classesTxt = assignedClasses.join('\n') + '\n';

  const configHash = createHash('sha256')
    .update(upstreamEnv)
    .update('\n----\n')
    .update(classesTxt)
    .digest('hex');

  return {
    upstreamEnv,
    classesTxt,
    configHash,
    shimAccessKey,
    shimSecretKey,
    keyFingerprint,
    assignedClasses,
    posixMounts: posixMount ? [posixMount] : [],
    sshKeyMaterializations: sshKey ? [sshKey] : [],
  };
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function renderEnvHeader(): string {
  return [
    '# upstream.env — backup-rclone-shim',
    '# AUTO-GENERATED by platform-api backup-rclone-shim/config-renderer.',
    '# Do NOT edit by hand. Operator changes flow via',
    '# /admin/backup-rclone-shim/... endpoints.',
    '#',
    '# Sourced by /etc/shim/launcher.sh (POSIX shell `set -a; . upstream.env; set +a`).',
    '# Values must NOT contain newlines or shell-meta chars; the renderer',
    '# enforces this via the input-validation layer (zod schemas at the',
    '# Drizzle row mapping in service.ts).',
    '',
  ].join('\n');
}

function renderUpstreamEnv(
  target: BackupTargetConfig,
  rootAccessKey: string,
  rootSecretKey: string,
): {
  envBody: string;
  posixMount?: PosixMount;
  sshKey?: SshKeyMaterialization;
} {
  // ROOT_ACCESS_KEY / ROOT_SECRET_KEY are the shim's OWN credentials
  // that clients authenticate with. Same regardless of upstream type.
  const lines: string[] = [
    shellQuote('ROOT_ACCESS_KEY', rootAccessKey),
    shellQuote('ROOT_SECRET_KEY', rootSecretKey),
  ];

  switch (target.storageType) {
    case 's3':
      return { envBody: renderS3Env(target, lines) };
    case 'ssh':
      return renderSftpEnv(target, lines);
    case 'cifs':
      return renderCifsEnv(target, lines);
    case 'nfs':
      return renderNfsEnv(target, lines);
    default:
      throw new Error(
        `Unsupported storage_type '${(target as { storageType: string }).storageType}'`,
      );
  }
}

function renderS3Env(
  t: BackupTargetConfig,
  prefix: ReadonlyArray<string>,
): string {
  if (!t.s3Endpoint || !t.s3AccessKey || !t.s3SecretKey) {
    throw new Error(
      `S3 target '${t.name}' is missing required fields (endpoint, access_key, secret_key)`,
    );
  }
  // S3 mode: versitygw is a passthrough proxy. The operator must
  // pre-create upstream buckets named `system`, `tenant`, `mail` on
  // their S3 provider (Hetzner / AWS / MinIO / etc.). versitygw does
  // not rewrite bucket names — the per-class isolation is operator-
  // managed via the upstream provider's bucket-level ACLs / policies.
  // s3UsePathStyle: legacy rows (null/undefined) treated as true; only
  // an explicit false suppresses --use-path-style. The launcher reads
  // this env var; values not literally 'true' or 'false' are rejected.
  const usePathStyle = t.s3UsePathStyle === false ? 'false' : 'true';
  return (
    [
      ...prefix,
      'UPSTREAM_TYPE=s3',
      shellQuote('UPSTREAM_ENDPOINT', t.s3Endpoint),
      shellQuote('UPSTREAM_ACCESS_KEY', t.s3AccessKey),
      shellQuote('UPSTREAM_SECRET_KEY', t.s3SecretKey),
      shellQuote('UPSTREAM_REGION', t.s3Region ?? 'us-east-1'),
      shellQuote('UPSTREAM_USE_PATH_STYLE', usePathStyle),
      '',
    ].join('\n')
  );
}

function renderSftpEnv(
  t: BackupTargetConfig,
  prefix: ReadonlyArray<string>,
): {
  envBody: string;
  posixMount: PosixMount;
  sshKey?: SshKeyMaterialization;
} {
  if (!t.sshHost || !t.sshUser) {
    throw new Error(
      `SFTP target '${t.name}' is missing required fields (host, user)`,
    );
  }
  if (!t.sshKey && !t.sshPassword) {
    throw new Error(
      `SFTP target '${t.name}' requires either ssh_key or ssh_password`,
    );
  }
  const lines: string[] = [
    ...prefix,
    'UPSTREAM_TYPE=sftp',
    shellQuote('UPSTREAM_SFTP_HOST', t.sshHost),
    shellQuote('UPSTREAM_SFTP_USER', t.sshUser),
    shellQuote('UPSTREAM_SFTP_PORT', String(t.sshPort ?? 22)),
  ];
  if (t.sshPath) lines.push(shellQuote('UPSTREAM_SFTP_PATH', stripSlashes(t.sshPath)));
  let sshKey: SshKeyMaterialization | undefined;
  if (t.sshKey) {
    // PEM file is projected at /etc/rclone/ssh-keys/upstream.pem by
    // the reconciler-materialised Secret.
    lines.push('UPSTREAM_SFTP_KEYFILE=/etc/rclone/ssh-keys/upstream.pem');
    sshKey = { pemContent: t.sshKey };
  } else if (t.sshPassword) {
    lines.push(shellQuote('UPSTREAM_SFTP_PASSWORD', t.sshPassword));
  }
  lines.push('');
  return {
    envBody: lines.join('\n'),
    posixMount: { mountPath: MOUNT_POINT, storageType: 'sftp', target: t },
    sshKey,
  };
}

function renderCifsEnv(
  t: BackupTargetConfig,
  prefix: ReadonlyArray<string>,
): { envBody: string; posixMount: PosixMount } {
  if (!t.cifsHost || !t.cifsShare || !t.cifsUser || !t.cifsPassword) {
    throw new Error(
      `CIFS target '${t.name}' is missing required fields (host, share, user, password)`,
    );
  }
  const lines: string[] = [
    ...prefix,
    'UPSTREAM_TYPE=cifs',
    shellQuote('UPSTREAM_CIFS_HOST', t.cifsHost),
    shellQuote('UPSTREAM_CIFS_SHARE', t.cifsShare),
    shellQuote('UPSTREAM_CIFS_USER', t.cifsUser),
    shellQuote('UPSTREAM_CIFS_PASSWORD', t.cifsPassword),
  ];
  if (t.cifsPort) lines.push(shellQuote('UPSTREAM_CIFS_PORT', String(t.cifsPort)));
  if (t.cifsDomain) lines.push(shellQuote('UPSTREAM_CIFS_DOMAIN', t.cifsDomain));
  if (t.cifsPath) lines.push(shellQuote('UPSTREAM_CIFS_PATH', stripSlashes(t.cifsPath)));
  lines.push('');
  return {
    envBody: lines.join('\n'),
    posixMount: { mountPath: MOUNT_POINT, storageType: 'cifs', target: t },
  };
}

function renderNfsEnv(
  t: BackupTargetConfig,
  prefix: ReadonlyArray<string>,
): { envBody: string; posixMount: PosixMount } {
  if (!t.nfsServer || !t.nfsExport) {
    throw new Error(
      `NFS target '${t.name}' is missing required fields (server, export)`,
    );
  }
  const lines: string[] = [
    ...prefix,
    'UPSTREAM_TYPE=nfs',
    shellQuote('UPSTREAM_NFS_SERVER', t.nfsServer),
    shellQuote('UPSTREAM_NFS_EXPORT', t.nfsExport),
  ];
  if (t.nfsVersion) lines.push(shellQuote('UPSTREAM_NFS_VERSION', t.nfsVersion));
  if (t.nfsOptions) lines.push(shellQuote('UPSTREAM_NFS_OPTIONS', t.nfsOptions));
  if (t.nfsPath) lines.push(shellQuote('UPSTREAM_NFS_PATH', stripSlashes(t.nfsPath)));
  lines.push('');
  return {
    envBody: lines.join('\n'),
    posixMount: { mountPath: MOUNT_POINT, storageType: 'nfs', target: t },
  };
}

/**
 * Emit a POSIX-shell env-file line: NAME='value' with single-quotes
 * around the value. Single quotes in the value are escaped as `'\''`
 * (close-quote, literal apostrophe, open-quote). This matches how
 * `bash` and busybox `sh` parse single-quoted strings.
 *
 * Validation: the value must not contain a NUL byte or newline. The
 * reconciler defends against malformed env files breaking the
 * launcher's `set -a; . upstream.env` step. NUL is rejected because
 * many shells truncate at NUL; newline is rejected because env files
 * are line-oriented.
 */
function shellQuote(name: string, value: string): string {
  if (value.includes('\0') || value.includes('\n')) {
    throw new Error(
      `upstream.env value for ${name} contains illegal character (NUL or newline)`,
    );
  }
  return `${name}='${value.replace(/'/g, `'\\''`)}'`;
}

function stripSlashes(s: string): string {
  return s.replace(/^\/+|\/+$/g, '');
}

// ---------------------------------------------------------------------------
// Input hash (deterministic; ignores random-IV obscure outputs)
// ---------------------------------------------------------------------------

/**
 * Hash that depends ONLY on the rendering INPUTS, used by the
 * reconciler to detect "does this cluster need a re-render?" without
 * false positives from any randomness in the output. R-X17 drops the
 * rclone-obscure layer entirely, so the rendered output is already
 * deterministic — this helper still exists for the reconciler's
 * change-detection contract.
 */
export function computeInputHash(
  rawKey: Buffer,
  assignments: ReadonlyArray<ClassAssignment>,
): string {
  const h = createHash('sha256');
  h.update('v2-versitygw\n');
  h.update(`fp=${fingerprintRawKey(rawKey)}\n`);
  const sorted = [...assignments].sort((a, b) =>
    a.className.localeCompare(b.className),
  );
  for (const { className, target } of sorted) {
    h.update(`class=${className}\n`);
    h.update(`tid=${target.id}\n`);
    h.update(`tname=${target.name}\n`);
    h.update(`ttype=${target.storageType}\n`);
    const credFields = [
      target.s3Endpoint,
      target.s3Bucket,
      target.s3Region,
      target.s3AccessKey,
      target.s3SecretKey,
      target.s3Prefix,
      target.s3UsePathStyle === false ? 'pathstyle=false' : 'pathstyle=true',
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

// ---------------------------------------------------------------------------
// Re-exports for backwards-compat with reconciler.ts + tests
// ---------------------------------------------------------------------------

export { decodeBackupTargetKey };
