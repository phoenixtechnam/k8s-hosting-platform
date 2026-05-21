/**
 * Service layer for the backup-rclone-shim reconciler.
 *
 * Responsibilities:
 *   1. Read the platform-wide BACKUP_TARGET_KEY Secret from k8s.
 *   2. Read `backup_target_assignments` rows whose `snapshot_class`
 *      matches one of the three shim classes ('system' | 'tenant' | 'mail').
 *   3. Read the joined `backup_configurations` row for each assignment
 *      and decrypt the upstream credentials via PLATFORM_ENCRYPTION_KEY.
 *   4. Hand a deterministic, decrypted `ClassAssignment[]` to the pure
 *      renderer in `rclone-config.ts`.
 *
 * Strict-primary resolution: when multiple `backup_target_assignments`
 * rows compete for the same shim class (lowest `priority` wins), the
 * losers are logged as "shadowed" and skipped — operators reconcile
 * intent via the future R-X10 UI. This matches the resolver semantics
 * already used by `storage-lifecycle/target-resolver.ts`.
 *
 * No I/O against the DaemonSet, ConfigMap, or Secret happens here —
 * see `reconciler.ts` for materialisation. Splitting load (pure) from
 * apply (k8s I/O) keeps the unit-test surface tractable and lets the
 * BACKUP_TARGET_KEY rotation CLI reuse the loaders without a kube
 * apply round-trip.
 */

import type * as k8s from '@kubernetes/client-node';
import { asc, eq, inArray } from 'drizzle-orm';
import type { Logger } from 'pino';

import {
  backupConfigurations,
  backupTargetAssignments,
} from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { decrypt } from '../oidc/crypto.js';
import type {
  BackupClass,
  BackupTargetConfig,
  ClassAssignment,
} from './rclone-config.js';

// ---------------------------------------------------------------------------
// Constants (k8s object names + namespace)
// ---------------------------------------------------------------------------

export const SHIM_NAMESPACE = 'platform';
export const BACKUP_TARGET_KEY_SECRET_NAME = 'backup-target-key';
/** ConfigMap holding NON-sensitive data: buckets.txt + launcher.sh.
 *  bucket names are plaintext class identifiers; launcher.sh is the
 *  shim's entrypoint script. */
export const SHIM_CONFIG_CM_NAME = 'backup-rclone-shim-config';
/** Secret holding the rendered rclone.conf — contains rclone-obscured
 *  upstream S3 secret_access_key + SFTP `pass` + per-class crypt
 *  password+salt. rclone-obscure is reversible by anyone with the
 *  rclone binary, so this content is treated as a credential bundle.
 *  Stored in a Secret (not ConfigMap) per R-X4-followup security
 *  review: ConfigMaps are not encrypted at rest by default; Secrets
 *  are the right object kind for EncryptionConfiguration coverage. */
export const SHIM_CREDENTIALS_SECRET_NAME = 'backup-rclone-shim-credentials';
export const SHIM_SSH_KEYS_SECRET_NAME = 'backup-rclone-shim-ssh-keys';
export const SHIM_STATUS_CM_NAME = 'backup-rclone-shim-status';
export const SHIM_DAEMONSET_NAME = 'backup-rclone-shim';

/** ConfigMap data key for the bound-classes list (one class per line).
 *  The `launcher.sh` key in the same ConfigMap is owned by the static
 *  placeholder manifest — the reconciler uses merge-patch which leaves
 *  unmentioned keys alone. R-X17 renamed from `buckets.txt` because
 *  versitygw doesn't have static buckets; the file is now just an
 *  operator-visible list of which classes the shim is bound for. */
export const CLASSES_TXT_KEY = 'classes.txt';
/** Secret data key for the rendered upstream.env (R-X17 — replaces
 *  the old `rclone.conf` key). Sourced by the shim launcher.sh as
 *  `set -a; . upstream.env; set +a`. */
export const UPSTREAM_ENV_KEY = 'upstream.env';

/** Annotation on the DaemonSet `spec.template.metadata.annotations` —
 *  changing it triggers a rolling pod restart. Value is the renderer's
 *  random-IV-influenced `configHash`. */
export const CONFIG_HASH_ANNOTATION =
  'platform.phoenix-host.net/config-hash';

/** Annotation on the status ConfigMap. Recorded value is the deterministic
 *  `inputHash` (NOT the random-IV configHash) so external pollers can
 *  detect "did the inputs change?" without re-rendering. */
export const INPUT_HASH_ANNOTATION =
  'platform.phoenix-host.net/input-hash';

/** Identity recorded on every reconciler-managed resource so subsequent
 *  reconciler runs can identify what they own and Flux drift detection
 *  can ignore reconciler-managed fields. */
export const FIELD_MANAGER = 'platform-api-backup-rclone-shim';

// ---------------------------------------------------------------------------
// Shim-class taxonomy
// ---------------------------------------------------------------------------

/** The three shim classes that can be assigned a target. Source of
 *  truth for the CHECK constraint extension in migration 0016. */
export const SHIM_CLASSES: ReadonlyArray<BackupClass> = ['system', 'tenant', 'mail'];

function isShimClass(s: string): s is BackupClass {
  return SHIM_CLASSES.includes(s as BackupClass);
}

// ---------------------------------------------------------------------------
// BACKUP_TARGET_KEY Secret loader
// ---------------------------------------------------------------------------

/**
 * Error code returned when the platform-wide backup encryption key is
 * missing. Operators receive this via the status ConfigMap; the
 * reconciler refuses to render any config until the key is present.
 * Bootstrap.sh creates it on every fresh install — so production
 * clusters should never see this.
 */
export class ShimKeyMissingError extends Error {
  constructor(message = 'BACKUP_TARGET_KEY Secret not found') {
    super(message);
    this.name = 'ShimKeyMissingError';
  }
}

export interface BackupTargetKeyInput {
  /** Raw 32 bytes — DO NOT log. */
  readonly rawKey: Buffer;
  /** sha256(rawKey)[0:16] hex — safe to log; matches bootstrap.sh +
   *  rotation script conventions. */
  readonly fingerprint: string;
  /** ISO timestamp from the Secret's `generated_at` field (set by
   *  bootstrap.sh / rotation script). May be empty for legacy
   *  Secrets — the reconciler still works in that case. */
  readonly generatedAt: string;
}

interface SecretShape {
  metadata?: { name?: string; namespace?: string };
  data?: Record<string, string>;
}

/**
 * Load the platform-wide backup encryption key from
 * `platform/backup-target-key`. The Secret SHOULD have been seeded by
 * bootstrap.sh during fresh-cluster provisioning; if it's missing the
 * reconciler refuses to render and writes a `STATE_MISSING_KEY` row
 * into the status ConfigMap.
 *
 * The Secret format (per `scripts/bootstrap.sh`):
 *   data.key            — base64 of the 32 raw bytes
 *   data.generated_at   — ISO timestamp (informational)
 *   data.fingerprint    — sha256(raw)[0:16] (informational; verified)
 */
export interface LoadBackupTargetKeyOpts {
  /** Optional logger for non-fatal diagnostics (fingerprint drift). */
  readonly log?: Pick<Logger, 'warn'>;
}

export async function loadBackupTargetKey(
  core: k8s.CoreV1Api,
  namespace: string = SHIM_NAMESPACE,
  opts: LoadBackupTargetKeyOpts = {},
): Promise<BackupTargetKeyInput> {
  let secret: SecretShape;
  try {
    secret = (await core.readNamespacedSecret({
      namespace,
      name: BACKUP_TARGET_KEY_SECRET_NAME,
    } as unknown as Parameters<typeof core.readNamespacedSecret>[0])) as SecretShape;
  } catch (err) {
    const statusCode =
      (err as { statusCode?: number; code?: number })?.statusCode
      ?? (err as { code?: number })?.code;
    if (statusCode === 404) {
      throw new ShimKeyMissingError(
        `Secret ${namespace}/${BACKUP_TARGET_KEY_SECRET_NAME} not found. ` +
        `Re-run bootstrap.sh or restore from the Tier-1 secrets bundle.`,
      );
    }
    throw err;
  }

  const keyB64Raw = secret.data?.['key'];
  if (!keyB64Raw) {
    throw new ShimKeyMissingError(
      `Secret ${namespace}/${BACKUP_TARGET_KEY_SECRET_NAME} has no 'key' data field`,
    );
  }
  // The k8s Secret API returns `data` values base64-encoded — the
  // @kubernetes/client-node SDK does NOT auto-decode (contrary to a
  // prior comment in this file that was wrong). bootstrap.sh stores
  // the key as `--from-literal=key=<base64-of-raw-32-bytes>`. So:
  //   SDK returns:  base64(base64-of-raw-32-bytes)
  //   step 1 below: decode SDK layer → base64-of-raw-32-bytes
  //   step 2 (decodeBackupTargetKey): decode that → 32 raw bytes
  const keyB64 = Buffer.from(keyB64Raw, 'base64').toString('utf8');
  const { decodeBackupTargetKey, fingerprintRawKey } = await import('./crypto.js');
  const rawKey = decodeBackupTargetKey(keyB64);

  const fingerprint = fingerprintRawKey(rawKey);

  // Same double-decode for the optional metadata fields. Treat empty
  // / unparseable values as absent rather than crashing — these are
  // informational only.
  const decodeSecretField = (key: string): string => {
    const raw = secret.data?.[key];
    if (!raw) return '';
    try {
      return Buffer.from(raw, 'base64').toString('utf8');
    } catch {
      return '';
    }
  };
  const storedFingerprint = decodeSecretField('fingerprint');
  if (storedFingerprint && storedFingerprint !== fingerprint && opts.log) {
    opts.log.warn(
      {
        secretFingerprint: storedFingerprint,
        computedFingerprint: fingerprint,
      },
      'backup-rclone-shim: BACKUP_TARGET_KEY Secret carries a stale `fingerprint` field — possible rotation drift, ' +
        'or the Secret was rewritten without updating the metadata. ' +
        'The runtime-computed fingerprint is authoritative.',
    );
  }

  return {
    rawKey,
    fingerprint,
    generatedAt: decodeSecretField('generated_at'),
  };
}

// ---------------------------------------------------------------------------
// Assignment loader
// ---------------------------------------------------------------------------

export interface ShadowedAssignment {
  readonly className: BackupClass;
  readonly targetId: string;
  readonly priority: number;
}

export interface LoadedAssignments {
  /** One per shim class — the winning assignment, with decrypted creds.
   *  Empty when no assignments exist (shim sleeps). */
  readonly assignments: ReadonlyArray<ClassAssignment>;
  /** Losing rows (higher priority) per shim class — logged by the
   *  reconciler. Operators reconcile via the assignments UI. */
  readonly shadowed: ReadonlyArray<ShadowedAssignment>;
  /** Assignments whose joined backup_configurations row is disabled —
   *  reported separately so the operator-facing status CM can flag
   *  "shim class is assigned but the target is administratively
   *  disabled". */
  readonly disabledAssignments: ReadonlyArray<ShadowedAssignment>;
  /** Assignments whose joined backup_configurations row was deleted
   *  (orphan / FK should prevent this but defence-in-depth). */
  readonly orphanedAssignments: ReadonlyArray<ShadowedAssignment>;
}

/**
 * Load + decrypt all shim-class assignments. Pure DB I/O (no k8s);
 * encryptionKey is the PLATFORM_ENCRYPTION_KEY env var (NOT the
 * BACKUP_TARGET_KEY — that one is separate and never used for
 * upstream-credential decryption).
 *
 * Strict-primary: per class, the lowest-priority row wins. Losers are
 * collected into `shadowed`. The operator-facing UI is expected to
 * eventually surface "you have N shadowed assignments for class X"
 * so cleanup is one click.
 */
export async function loadShimAssignments(
  db: Database,
  encryptionKey: string,
): Promise<LoadedAssignments> {
  const rows = await db
    .select({
      className: backupTargetAssignments.snapshotClass,
      targetId: backupTargetAssignments.targetId,
      priority: backupTargetAssignments.priority,
      target: backupConfigurations,
    })
    .from(backupTargetAssignments)
    .leftJoin(
      backupConfigurations,
      eq(backupConfigurations.id, backupTargetAssignments.targetId),
    )
    .where(
      inArray(
        backupTargetAssignments.snapshotClass,
        SHIM_CLASSES as unknown as string[],
      ),
    )
    .orderBy(
      asc(backupTargetAssignments.snapshotClass),
      asc(backupTargetAssignments.priority),
    );

  const assignments: ClassAssignment[] = [];
  const shadowed: ShadowedAssignment[] = [];
  const disabledAssignments: ShadowedAssignment[] = [];
  const orphanedAssignments: ShadowedAssignment[] = [];

  const winnerByClass = new Map<BackupClass, true>();

  for (const row of rows) {
    if (!isShimClass(row.className)) {
      // Defence-in-depth — the SHIM_CLASSES filter above already
      // restricts to valid values, but a future migration adding
      // more shim classes could leak in.
      continue;
    }
    const className = row.className;

    // Orphaned target (FK should prevent, but ON DELETE behavior
    // could change). Skip + report.
    if (!row.target) {
      orphanedAssignments.push({
        className,
        targetId: row.targetId,
        priority: row.priority,
      });
      continue;
    }

    // Disabled target — admin set enabled=0. Skip + report. Shadowed
    // logic applies regardless: only the FIRST eligible row per class
    // becomes the winner.
    if (row.target.enabled !== 1) {
      disabledAssignments.push({
        className,
        targetId: row.targetId,
        priority: row.priority,
      });
      continue;
    }

    if (winnerByClass.has(className)) {
      shadowed.push({
        className,
        targetId: row.targetId,
        priority: row.priority,
      });
      continue;
    }

    winnerByClass.set(className, true);

    const target = rowToTargetConfig(row.target, encryptionKey);
    assignments.push({ className, target });
  }

  return {
    assignments,
    shadowed,
    disabledAssignments,
    orphanedAssignments,
  };
}

/**
 * Convert a `backup_configurations` row into a renderer-ready
 * `BackupTargetConfig`, decrypting any encrypted columns.
 *
 * Throws if the row has an unknown storage_type (caller treats this
 * as a fatal misconfiguration — the renderer can't handle it).
 */
function rowToTargetConfig(
  row: typeof backupConfigurations.$inferSelect,
  encryptionKey: string,
): BackupTargetConfig {
  // Common metadata
  const base = {
    id: row.id,
    name: row.name,
  };

  switch (row.storageType) {
    case 's3':
      return {
        ...base,
        storageType: 's3',
        s3Endpoint: row.s3Endpoint,
        s3Bucket: row.s3Bucket,
        s3Region: row.s3Region,
        s3AccessKey: row.s3AccessKeyEncrypted
          ? decrypt(row.s3AccessKeyEncrypted, encryptionKey)
          : null,
        s3SecretKey: row.s3SecretKeyEncrypted
          ? decrypt(row.s3SecretKeyEncrypted, encryptionKey)
          : null,
        s3Prefix: row.s3Prefix,
      };

    case 'ssh':
      return {
        ...base,
        storageType: 'ssh',
        sshHost: row.sshHost,
        sshPort: row.sshPort,
        sshUser: row.sshUser,
        sshKey: row.sshKeyEncrypted
          ? decrypt(row.sshKeyEncrypted, encryptionKey)
          : null,
        sshPassword: row.sshPasswordEncrypted
          ? decrypt(row.sshPasswordEncrypted, encryptionKey)
          : null,
        sshPath: row.sshPath,
      };

    case 'cifs':
      return {
        ...base,
        storageType: 'cifs',
        cifsHost: row.cifsHost,
        cifsPort: row.cifsPort,
        cifsShare: row.cifsShare,
        cifsUser: row.cifsUser,
        cifsPassword: row.cifsPasswordEncrypted
          ? decrypt(row.cifsPasswordEncrypted, encryptionKey)
          : null,
        cifsDomain: row.cifsDomain,
        cifsPath: row.cifsPath,
      };

    case 'nfs':
      return {
        ...base,
        storageType: 'nfs',
        nfsServer: row.nfsServer,
        nfsExport: row.nfsExport,
        nfsVersion: row.nfsVersion,
        nfsOptions: row.nfsOptions,
      };

    default:
      throw new Error(
        `backup_configurations '${row.id}' has unknown storage_type '${row.storageType as string}'`,
      );
  }
}

// ---------------------------------------------------------------------------
// Status writer (called by the reconciler — collected here so service
// + reconciler share one source of truth for the status format)
// ---------------------------------------------------------------------------

export interface ShimStatus {
  /** STATE_OK | STATE_MISSING_KEY | STATE_NO_ASSIGNMENTS | STATE_ERROR */
  readonly state: 'STATE_OK' | 'STATE_MISSING_KEY' | 'STATE_NO_ASSIGNMENTS' | 'STATE_ERROR';
  /** Last reconcile pass started; ISO. */
  readonly reconciledAt: string;
  /** sha256(rawKey)[0:16] — present unless STATE_MISSING_KEY. */
  readonly keyFingerprint: string;
  /** Deterministic input hash (NOT the random-IV configHash). */
  readonly inputHash: string;
  /** Classes that have a winning, non-disabled assignment. */
  readonly assignedClasses: ReadonlyArray<BackupClass>;
  /** Free-form one-line error description when state=STATE_ERROR. */
  readonly errorMessage: string;
}

export function formatStatusForConfigMap(status: ShimStatus): Record<string, string> {
  return {
    state: status.state,
    reconciledAt: status.reconciledAt,
    keyFingerprint: status.keyFingerprint,
    inputHash: status.inputHash,
    assignedClasses: status.assignedClasses.join(','),
    errorMessage: status.errorMessage,
  };
}

// ---------------------------------------------------------------------------
// Logger helpers (terse — the reconciler emits one summary log per run)
// ---------------------------------------------------------------------------

export function logAssignmentDiagnostics(
  loaded: LoadedAssignments,
  log: Pick<Logger, 'info' | 'warn'>,
): void {
  if (loaded.shadowed.length > 0) {
    log.warn(
      { shadowed: loaded.shadowed },
      'backup-rclone-shim: shadowed assignments — operator should clean up via UI',
    );
  }
  if (loaded.disabledAssignments.length > 0) {
    log.warn(
      { disabled: loaded.disabledAssignments },
      'backup-rclone-shim: disabled targets are assigned to shim classes — ignored until re-enabled',
    );
  }
  if (loaded.orphanedAssignments.length > 0) {
    log.warn(
      { orphaned: loaded.orphanedAssignments },
      'backup-rclone-shim: orphan assignments (target row missing) — DB integrity issue',
    );
  }
}
