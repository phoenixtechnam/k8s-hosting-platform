/**
 * Mail snapshot schedule + backup target management.
 *
 * Schedule is stored in k8s (CronJob spec.schedule) as the source of
 * truth; system_settings.mail_snapshot_schedule mirrors it for the UI
 * to read without a k8s round-trip.
 *
 * Backup target is stored in system_settings.mail_snapshot_backup_store_id
 * (FK to backup_configurations.id). When set, the backend maintains the
 * stalwart-snapshot-restic-repo Secret in the mail namespace so the
 * upload sidecar can run restic without calling back to the API.
 *
 * GET   /admin/mail/snapshot-schedule
 * PATCH /admin/mail/snapshot-schedule
 * GET   /admin/mail/snapshot-backup-target
 * PATCH /admin/mail/snapshot-backup-target
 *
 * POST  /api/v1/internal/mail/snapshot-last-run   (sidecar callback)
 */

import { eq } from 'drizzle-orm';
import { ApiError } from '../../shared/errors.js';
import { systemSettings, backupConfigurations } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { decrypt } from '../oidc/crypto.js';
import { STRATEGIC_MERGE_PATCH } from '../../shared/k8s-patch.js';
import {
  type MailSnapshotScheduleResponse,
  type MailSnapshotScheduleUpdate,
  type MailSnapshotBackupTargetResponse,
  type MailSnapshotBackupTargetUpdate,
  mailSnapshotScheduleResponseSchema,
  mailSnapshotBackupTargetResponseSchema,
} from '@k8s-hosting/api-contracts';

const MAIL_NAMESPACE = 'mail';
const SNAPSHOT_CRONJOB_NAME = 'stalwart-snapshot';
const SETTINGS_ID = 'system';
const RESTIC_SECRET_NAME = 'stalwart-snapshot-restic-repo';
const RESTIC_PASSWORD_SECRET = 'stalwart-snapshot-restic-password';

export interface SnapshotSettingsOptions {
  readonly kubeconfigPath: string | undefined;
}

interface K8sBatchClient {
  batch: import('@kubernetes/client-node').BatchV1Api;
  core: import('@kubernetes/client-node').CoreV1Api;
}

// ── Restic password management ─────────────────────────────────────────────────

/**
 * Return the stable restic repository password. On first call, generates
 * a random 32-char password, stores it in the `stalwart-snapshot-restic-password`
 * Secret, and returns it. Subsequent calls return the same password from the
 * Secret, making it stable across backup-target changes.
 *
 * The separate Secret means the password survives re-creates of
 * `stalwart-snapshot-restic-repo` (which carries backend-specific env vars
 * that change when the target changes). restic repos keyed with this password
 * stay readable after a target switch — assuming the same repo path is used
 * or the operator runs `restic rekey` on the old repo when moving backends.
 */
async function getOrCreateResticPassword(
  core: import('@kubernetes/client-node').CoreV1Api,
): Promise<string> {
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
    const code = (err as { statusCode?: number }).statusCode;
    if (code !== 404) throw err;
    // 404 → Secret doesn't exist yet; generate and create below.
  }

  // Generate a random 32-char password: 4 × 8-char hex segments.
  const { randomBytes } = await import('node:crypto');
  const password = randomBytes(16).toString('hex'); // 32 hex chars
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

/**
 * Rotate the restic repository password.
 *
 * Deletes the existing `stalwart-snapshot-restic-password` Secret so the next
 * backup-target update generates a fresh password.
 *
 * IMPORTANT: After rotation, any existing restic repository will no longer be
 * accessible with the new password. Operators must run `restic rekey` on the
 * repository before the next backup runs, or accept that history is inaccessible
 * until the repo is re-initialised (first backup after rotation recreates it).
 */
export async function rotateResticPassword(opts: SnapshotSettingsOptions): Promise<{ status: string }> {
  const { core } = await loadK8sClients(opts.kubeconfigPath);
  try {
    await core.deleteNamespacedSecret({
      namespace: MAIL_NAMESPACE,
      name: RESTIC_PASSWORD_SECRET,
    });
  } catch (err) {
    const code = (err as { statusCode?: number }).statusCode;
    if (code !== 404) throw err;
    // Already gone — fine.
  }
  return { status: 'password_rotated' };
}

async function loadK8sClients(kubeconfigPath: string | undefined): Promise<K8sBatchClient> {
  const k8s = await import('@kubernetes/client-node');
  const kc = new k8s.KubeConfig();
  if (kubeconfigPath) kc.loadFromFile(kubeconfigPath);
  else kc.loadFromCluster();
  return {
    batch: kc.makeApiClient(k8s.BatchV1Api),
    core: kc.makeApiClient(k8s.CoreV1Api),
  };
}

// ── Schedule ──────────────────────────────────────────────────────────────────

/**
 * Read the current snapshot schedule from the CronJob spec.
 * Falls back to the system_settings DB value (in case the CronJob
 * is temporarily absent) and then to the default.
 */
export async function getMailSnapshotSchedule(
  db: Database,
  opts: SnapshotSettingsOptions,
): Promise<MailSnapshotScheduleResponse> {
  // Try k8s first — it is authoritative.
  try {
    const { batch } = await loadK8sClients(opts.kubeconfigPath);
    const cronJob = await batch.readNamespacedCronJob({
      namespace: MAIL_NAMESPACE,
      name: SNAPSHOT_CRONJOB_NAME,
    }) as { spec?: { schedule?: string } };
    const scheduleExpression = cronJob.spec?.schedule ?? '*/2 * * * *';
    return mailSnapshotScheduleResponseSchema.parse({ scheduleExpression });
  } catch {
    // CronJob absent or k8s unavailable — fall back to DB.
  }
  const [row] = await db.select({ v: systemSettings.mailSnapshotSchedule })
    .from(systemSettings)
    .where(eq(systemSettings.id, SETTINGS_ID));
  return mailSnapshotScheduleResponseSchema.parse({
    scheduleExpression: row?.v ?? '*/2 * * * *',
  });
}

/**
 * Update the snapshot schedule by patching the CronJob spec.schedule
 * and persisting the value to system_settings.
 */
export async function updateMailSnapshotSchedule(
  update: MailSnapshotScheduleUpdate,
  db: Database,
  opts: SnapshotSettingsOptions,
): Promise<MailSnapshotScheduleResponse> {
  const { batch } = await loadK8sClients(opts.kubeconfigPath);

  try {
    await batch.patchNamespacedCronJob(
      {
        namespace: MAIL_NAMESPACE,
        name: SNAPSHOT_CRONJOB_NAME,
        body: { spec: { schedule: update.scheduleExpression } },
      } as unknown as Parameters<typeof batch.patchNamespacedCronJob>[0],
      STRATEGIC_MERGE_PATCH,
    );
  } catch (err) {
    throw new ApiError(
      'SNAPSHOT_SCHEDULE_PATCH_FAILED',
      `Failed to patch CronJob schedule: ${(err as Error).message ?? String(err)}`,
      500,
    );
  }

  await db.update(systemSettings)
    .set({ mailSnapshotSchedule: update.scheduleExpression })
    .where(eq(systemSettings.id, SETTINGS_ID));

  return mailSnapshotScheduleResponseSchema.parse({
    scheduleExpression: update.scheduleExpression,
  });
}

// ── Backup target ─────────────────────────────────────────────────────────────

/**
 * Read the currently configured backup store for mail snapshots.
 */
export async function getMailSnapshotBackupTarget(
  db: Database,
): Promise<MailSnapshotBackupTargetResponse> {
  const [settings] = await db.select({
    backupStoreId: systemSettings.mailSnapshotBackupStoreId,
  }).from(systemSettings).where(eq(systemSettings.id, SETTINGS_ID));

  const storeId = settings?.backupStoreId ?? null;
  if (!storeId) {
    return mailSnapshotBackupTargetResponseSchema.parse({
      backupStoreId: null,
      backupStoreName: null,
      storageType: null,
    });
  }

  const [config] = await db.select({
    name: backupConfigurations.name,
    storageType: backupConfigurations.storageType,
  }).from(backupConfigurations).where(eq(backupConfigurations.id, storeId));

  return mailSnapshotBackupTargetResponseSchema.parse({
    backupStoreId: storeId,
    backupStoreName: config?.name ?? null,
    storageType: config?.storageType ?? null,
  });
}

/**
 * Update the backup store for mail snapshots.
 * Creates/deletes the stalwart-snapshot-restic-repo Secret accordingly.
 */
export async function updateMailSnapshotBackupTarget(
  update: MailSnapshotBackupTargetUpdate,
  db: Database,
  opts: SnapshotSettingsOptions,
  encryptionKey: string,
): Promise<MailSnapshotBackupTargetResponse> {
  const { core } = await loadK8sClients(opts.kubeconfigPath);

  if (!update.backupStoreId) {
    // Clear: delete the restic repo Secret if it exists.
    await db.update(systemSettings)
      .set({ mailSnapshotBackupStoreId: null })
      .where(eq(systemSettings.id, SETTINGS_ID));
    await deleteResticSecret(core);
    return mailSnapshotBackupTargetResponseSchema.parse({
      backupStoreId: null,
      backupStoreName: null,
      storageType: null,
    });
  }

  // Validate the store exists.
  const [config] = await db.select().from(backupConfigurations)
    .where(eq(backupConfigurations.id, update.backupStoreId));
  if (!config) {
    throw new ApiError(
      'SNAPSHOT_BACKUP_STORE_NOT_FOUND',
      `BackupStore ${update.backupStoreId} not found`,
      404,
    );
  }

  // Build the restic Secret data from the backup configuration.
  const secretData = await buildResticSecretData(config, encryptionKey, core);
  await applyResticSecret(core, secretData);

  await db.update(systemSettings)
    .set({ mailSnapshotBackupStoreId: update.backupStoreId })
    .where(eq(systemSettings.id, SETTINGS_ID));

  return mailSnapshotBackupTargetResponseSchema.parse({
    backupStoreId: update.backupStoreId,
    backupStoreName: config.name,
    storageType: config.storageType,
  });
}

/**
 * Internal endpoint: record stats from the restic upload sidecar.
 * POST /api/v1/internal/mail/snapshot-last-run
 */
export async function recordMailSnapshotLastRun(
  db: Database,
  stats: { totalSnapshotSizeBytes: number; snapshotCount: number },
): Promise<void> {
  await db.update(systemSettings)
    .set({
      mailSnapshotLastRunStats: {
        totalSnapshotSizeBytes: stats.totalSnapshotSizeBytes,
        snapshotCount: stats.snapshotCount,
        runAt: new Date().toISOString(),
      },
    })
    .where(eq(systemSettings.id, SETTINGS_ID));
}

// ── helpers ──────────────────────────────────────────────────────────────────

type BackupConfig = typeof backupConfigurations.$inferSelect;

async function buildResticSecretData(
  config: BackupConfig,
  encryptionKey: string,
  core: import('@kubernetes/client-node').CoreV1Api,
): Promise<Record<string, string>> {
  // Use a stable, randomly-generated password stored in a dedicated Secret.
  // This replaces the old deterministic derivation (`mail-snapshot-${config.id}`)
  // so the password survives backup-target changes without breaking existing repos.
  const resticPassword = await getOrCreateResticPassword(core);

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
    // restic S3 URL: s3:https://endpoint/bucket/prefix
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
    // Normalise the path: strip trailing /mail-snapshots to avoid doubling.
    const rawPath = config.sshPath ?? '/mail-snapshots';
    const sshBasePath = rawPath.replace(/\/mail-snapshots\/?$/, '') || '/';
    // restic SFTP URL: sftp:user@host:/base-path/mail-snapshots
    const repoUrl = `sftp:${sshUser}@${sshHost}:${sshBasePath}/mail-snapshots`;
    return {
      RESTIC_REPOSITORY: repoUrl,
      RESTIC_PASSWORD: resticPassword,
      // restic uses SSH agent or known_hosts; key injection is out of scope
      // for Phase 1 — SSH backup stores work when the host+port are reachable
      // and the SFTP user allows password-less auth (key already provisioned).
      SFTP_HOST: sshHost,
      SFTP_PORT: sshPort,
    };
  }

  if (config.storageType === 'cifs') {
    // CIFS backup via systemd-mount at /mnt/stalwart-cifs-blobstore.
    // restic uses the 'local' backend rooted at the CIFS mount path.
    // This shares the same CIFS mount as the BlobStore (same share/path),
    // but uses a sub-directory dedicated to snapshots to avoid collision.
    const cifsPath = 'mail-snapshots';
    return {
      RESTIC_REPOSITORY: `/mnt/stalwart-cifs-blobstore/${cifsPath}`,
      RESTIC_PASSWORD: resticPassword,
    };
  }

  // hostpath — not applicable for restic (no remote endpoint)
  return {
    RESTIC_REPOSITORY: '',
    RESTIC_PASSWORD: resticPassword,
  };
}

async function applyResticSecret(
  core: import('@kubernetes/client-node').CoreV1Api,
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
    // Try update first, then create.
    await core.replaceNamespacedSecret({
      namespace: MAIL_NAMESPACE,
      name: RESTIC_SECRET_NAME,
      body: body as unknown as object,
    });
  } catch (updateErr) {
    const code = (updateErr as { statusCode?: number }).statusCode;
    if (code === 404) {
      // backup-coverage: excluded:cluster-infrastructure
      await core.createNamespacedSecret({
        namespace: MAIL_NAMESPACE,
        body: body as unknown as object,
      });
    } else {
      throw updateErr;
    }
  }
}

async function deleteResticSecret(
  core: import('@kubernetes/client-node').CoreV1Api,
): Promise<void> {
  try {
    await core.deleteNamespacedSecret({
      namespace: MAIL_NAMESPACE,
      name: RESTIC_SECRET_NAME,
    });
  } catch (err) {
    const code = (err as { statusCode?: number }).statusCode;
    if (code !== 404) throw err;
    // Already gone — fine.
  }
}
