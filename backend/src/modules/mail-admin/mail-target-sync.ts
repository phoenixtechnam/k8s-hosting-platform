/**
 * Mail-snapshot ↔ system_backup target binding.
 *
 * Owns the lifecycle of the `stalwart-snapshot-restic-repo` Secret in
 * the `mail` namespace, deriving its contents from the lowest-priority
 * assignment in `backup_target_assignments[snapshot_class='system_mail']`.
 *
 * Single source of truth flow:
 *   1. operator → /settings/backup-classes → setAssignments('system_mail', ...)
 *   2. setAssignments commits the txn, then invokes
 *      syncMailResticSecretFromAssignment() so the Secret reflects the
 *      newly-resolved primary target
 *   3. legacy PATCH /admin/mail/snapshot-backup-target routes through
 *      setAssignments so both paths take the same row lock — no TOCTOU
 *      between the old picker and the new assignments page
 *   4. boot-time + periodic reconciler (5 min) heals Secret drift if a
 *      previous sync failed to call k8s (assignment table is authoritative)
 *
 * Restic transport, CronJob YAML, deployment.yaml init-container, and
 * the Secret shape are untouched — only the binding mechanism moves.
 * See [docs/02-operations/TENANT_BACKUP.md] for the operator runbook.
 */

import { eq } from 'drizzle-orm';
import { backupConfigurations, systemSettings } from '../../db/schema.js';
import { decrypt } from '../oidc/crypto.js';
import { isNotFound } from '../../shared/k8s-errors.js';
import { resolvePrimaryTarget } from '../snapshot-classes/service.js';
import type { Database } from '../../db/index.js';
import type { CoreV1Api } from '@kubernetes/client-node';

export const MAIL_NAMESPACE = 'mail';
export const RESTIC_SECRET_NAME = 'stalwart-snapshot-restic-repo';
export const RESTIC_PASSWORD_SECRET = 'stalwart-snapshot-restic-password';

type BackupConfig = typeof backupConfigurations.$inferSelect;

export interface SyncOptions {
  /** Path to a kubeconfig file (dev). Omit to use in-cluster service-account. */
  readonly kubeconfigPath?: string;
}

export interface SyncResult {
  /** What the sync actually did (mostly for audit logging + tests). */
  readonly action: 'applied' | 'deleted' | 'noop';
  /** Resolved target id (when applied), else null. */
  readonly targetId: string | null;
  /** Operator-readable storage type (when applied), else null. */
  readonly storageType: string | null;
}

// ── Restic password (stable across target switches) ──────────────────────────

/**
 * Return the stable restic repository password. On first call, generates
 * a random 32-char password, stores it in the `stalwart-snapshot-restic-password`
 * Secret, and returns it. Subsequent calls return the same password.
 *
 * The separate Secret means the password survives re-creates of
 * `stalwart-snapshot-restic-repo` (which carries backend-specific env
 * vars that change when the target changes). restic repos keyed with
 * this password stay readable after a target switch — assuming the
 * same repo path is used or the operator runs `restic rekey` on the
 * old repo when moving backends.
 */
export async function getOrCreateResticPassword(core: CoreV1Api): Promise<string> {
  try {
    const secret = await core.readNamespacedSecret({
      namespace: MAIL_NAMESPACE,
      name: RESTIC_PASSWORD_SECRET,
    }) as { data?: Record<string, string> };
    const encoded = secret.data?.['RESTIC_PASSWORD'];
    if (encoded) {
      const pw = Buffer.from(encoded, 'base64').toString('utf8');
      if (pw) return pw;
    }
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }

  const { randomBytes } = await import('node:crypto');
  const password = randomBytes(16).toString('hex');
  // backup-coverage: excluded:cluster-infrastructure
  await core.createNamespacedSecret({
    namespace: MAIL_NAMESPACE,
    body: {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: RESTIC_PASSWORD_SECRET, namespace: MAIL_NAMESPACE },
      type: 'Opaque',
      data: { RESTIC_PASSWORD: Buffer.from(password).toString('base64') },
    } as unknown as object,
  });
  return password;
}

// ── Build env map for the restic upload sidecar ─────────────────────────────

/**
 * Compute the env-var map that the `stalwart-snapshot-restic-repo`
 * Secret encodes for the upload Pod. The shape is per-storage-type:
 *   s3  → RESTIC_REPOSITORY=s3:..., AWS_*_KEY_ID/SECRET_ACCESS_KEY
 *   ssh → RESTIC_REPOSITORY=sftp:..., SFTP_HOST, SFTP_PORT
 *   cifs → RESTIC_REPOSITORY=<mount-path>/mail-snapshots (local backend)
 *   other → empty RESTIC_REPOSITORY so the sidecar exits 0 with skip log
 *
 * Pure function over (config, password). Exported so the byte-equal
 * regression test (Phase 2a) can lock the output BEFORE this module
 * existed independent of any k8s state. The async signature is kept
 * for callers that don't already have a password — they pass it in
 * directly to avoid coupling this function to k8s.
 */
export function buildResticSecretEnv(
  config: BackupConfig,
  encryptionKey: string,
  resticPassword: string,
): Record<string, string> {
  if (config.storageType === 's3') {
    const accessKey = config.s3AccessKeyEncrypted
      ? decrypt(config.s3AccessKeyEncrypted, encryptionKey)
      : '';
    const secretKey = config.s3SecretKeyEncrypted
      ? decrypt(config.s3SecretKeyEncrypted, encryptionKey)
      : '';
    const endpoint = config.s3Endpoint ?? '';
    const bucket = config.s3Bucket ?? '';
    const prefix = config.s3Prefix ? `${config.s3Prefix}/mail-snapshots` : 'mail-snapshots';
    const repoUrl = endpoint
      ? `s3:${endpoint}/${bucket}/${prefix}`
      : `s3:s3.amazonaws.com/${bucket}/${prefix}`;
    return {
      RESTIC_REPOSITORY: repoUrl,
      RESTIC_PASSWORD: resticPassword,
      AWS_ACCESS_KEY_ID: accessKey,
      AWS_SECRET_ACCESS_KEY: secretKey,
    };
  }

  if (config.storageType === 'ssh') {
    const sshHost = config.sshHost ?? '';
    const sshPort = String(config.sshPort ?? 22);
    const sshUser = config.sshUser ?? 'root';
    const rawPath = config.sshPath ?? '/mail-snapshots';
    const sshBasePath = rawPath.replace(/\/mail-snapshots\/?$/, '') || '/';
    const repoUrl = `sftp:${sshUser}@${sshHost}:${sshBasePath}/mail-snapshots`;
    return {
      RESTIC_REPOSITORY: repoUrl,
      RESTIC_PASSWORD: resticPassword,
      SFTP_HOST: sshHost,
      SFTP_PORT: sshPort,
    };
  }

  if (config.storageType === 'cifs') {
    const cifsPath = 'mail-snapshots';
    return {
      RESTIC_REPOSITORY: `/mnt/stalwart-cifs-blobstore/${cifsPath}`,
      RESTIC_PASSWORD: resticPassword,
    };
  }

  return {
    RESTIC_REPOSITORY: '',
    RESTIC_PASSWORD: resticPassword,
  };
}

// ── k8s Secret apply / delete ────────────────────────────────────────────────

export async function applyResticSecret(
  core: CoreV1Api,
  secretData: Record<string, string>,
): Promise<void> {
  const encoded: Record<string, string> = {};
  for (const [k, v] of Object.entries(secretData)) {
    encoded[k] = Buffer.from(v).toString('base64');
  }
  const body = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: RESTIC_SECRET_NAME, namespace: MAIL_NAMESPACE },
    type: 'Opaque',
    data: encoded,
  };
  try {
    await core.replaceNamespacedSecret({
      namespace: MAIL_NAMESPACE,
      name: RESTIC_SECRET_NAME,
      body: body as unknown as object,
    });
  } catch (updateErr) {
    if (!isNotFound(updateErr)) throw updateErr;
    // backup-coverage: excluded:cluster-infrastructure
    await core.createNamespacedSecret({
      namespace: MAIL_NAMESPACE,
      body: body as unknown as object,
    });
  }
}

export async function deleteResticSecret(core: CoreV1Api): Promise<void> {
  try {
    await core.deleteNamespacedSecret({
      namespace: MAIL_NAMESPACE,
      name: RESTIC_SECRET_NAME,
    });
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

// ── k8s client loader (mirrors snapshot-settings.ts:loadK8sTenants) ──────────

async function loadCore(kubeconfigPath: string | undefined): Promise<CoreV1Api> {
  const k8s = await import('@kubernetes/client-node');
  const kc = new k8s.KubeConfig();
  if (kubeconfigPath) kc.loadFromFile(kubeconfigPath);
  else kc.loadFromCluster();
  return kc.makeApiClient(k8s.CoreV1Api);
}

// ── The public sync entry point ──────────────────────────────────────────────

/**
 * Resolve the lowest-priority `system_mail` assignment and reapply
 * the `stalwart-snapshot-restic-repo` Secret in the mail namespace.
 * When no assignment exists, delete the Secret — the upload sidecar
 * sees `RESTIC_REPOSITORY=""` and skips with a clear log.
 *
 * Also mirrors the resolved target into
 * `system_settings.mail_snapshot_backup_store_id` for one release so
 * the existing UI's GET endpoint keeps working without a frontend
 * change in the same deploy.
 *
 * Best-effort wrt audit logging — callers should NOT bubble exceptions
 * from this function to the operator since the assignment write is
 * authoritative; the reconciler (Phase 5) will heal Secret drift on
 * the next tick.
 *
 * Atomicity: this function does TWO separate DB reads — first
 * `resolvePrimaryTarget` for the assigned target_id, then
 * `select().from(backupConfigurations)` for that target's credentials.
 * A concurrent `setAssignments` committing between those reads could
 * produce a Secret whose RESTIC_REPOSITORY URL is computed from one
 * target_id but whose creds come from a sibling target. The race
 * window is microseconds; the 5-min reconciler heals it on the next
 * tick. A JOIN'd single SELECT would close it deterministically —
 * deferred as a follow-up since the inline-sync hook is the
 * load-bearing path.
 */
export async function syncMailResticSecretFromAssignment(
  db: Database,
  encryptionKey: string,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const core = await loadCore(opts.kubeconfigPath);
  const primary = await resolvePrimaryTarget(db, 'system_mail');

  if (!primary) {
    await deleteResticSecret(core);
    await db.update(systemSettings)
      .set({ mailSnapshotBackupStoreId: null })
      .where(eq(systemSettings.id, 'system'));
    return { action: 'deleted', targetId: null, storageType: null };
  }

  // Resolver returns enabled=0 targets too (callers normally refuse).
  // For the Secret-sync path we treat a disabled target the same as
  // "no assignment" — operator must enable the target before mail
  // snapshots resume. Otherwise the Pod would auth with a key the
  // operator has explicitly marked unavailable.
  if (primary.targetEnabled !== 1) {
    await deleteResticSecret(core);
    await db.update(systemSettings)
      .set({ mailSnapshotBackupStoreId: null })
      .where(eq(systemSettings.id, 'system'));
    return { action: 'deleted', targetId: primary.targetId, storageType: primary.targetStorageType };
  }

  // Load the full backup_configurations row for credentials.
  const [config] = await db.select().from(backupConfigurations)
    .where(eq(backupConfigurations.id, primary.targetId));
  if (!config) {
    // FK is ON DELETE RESTRICT so this is normally impossible, but if
    // a stale read crossed a concurrent delete we fall back to "no
    // target" instead of crashing.
    await deleteResticSecret(core);
    return { action: 'deleted', targetId: null, storageType: null };
  }

  const password = await getOrCreateResticPassword(core);
  const env = buildResticSecretEnv(config, encryptionKey, password);
  await applyResticSecret(core, env);

  await db.update(systemSettings)
    .set({ mailSnapshotBackupStoreId: primary.targetId })
    .where(eq(systemSettings.id, 'system'));

  return {
    action: 'applied',
    targetId: primary.targetId,
    storageType: primary.targetStorageType,
  };
}
