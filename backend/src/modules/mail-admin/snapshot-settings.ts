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
import { STRATEGIC_MERGE_PATCH } from '../../shared/k8s-patch.js';
import { isNotFound } from '../../shared/k8s-errors.js';
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

interface K8sBatchTenant {
  batch: import('@kubernetes/client-node').BatchV1Api;
  core: import('@kubernetes/client-node').CoreV1Api;
}

// getOrCreateResticPassword moved to mail-target-sync.ts (re-exported
// from there). rotateResticPassword (below) only deletes the password
// Secret — the next sync regenerates a fresh password on its first
// readNamespacedSecret miss.

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
  const { core } = await loadK8sTenants(opts.kubeconfigPath);
  try {
    await core.deleteNamespacedSecret({
      namespace: MAIL_NAMESPACE,
      name: RESTIC_PASSWORD_SECRET,
    });
  } catch (err) {
    if (!isNotFound(err)) throw err;
    // Already gone — fine.
  }
  return { status: 'password_rotated' };
}

async function loadK8sTenants(kubeconfigPath: string | undefined): Promise<K8sBatchTenant> {
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
    const { batch } = await loadK8sTenants(opts.kubeconfigPath);
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
  const { batch } = await loadK8sTenants(opts.kubeconfigPath);

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
 *
 * Source of truth: `backup_target_assignments[snapshot_class='system_mail']`
 * (the assignment row resolves via strict-primary). Falls back to the
 * legacy `system_settings.mail_snapshot_backup_store_id` mirror only
 * if no assignment exists yet — that's the transitional path for
 * installs that haven't run migration 0010 (no longer reachable in
 * practice, but kept for safety).
 */
export async function getMailSnapshotBackupTarget(
  db: Database,
): Promise<MailSnapshotBackupTargetResponse> {
  // Authoritative read: snapshot-classes assignment row.
  const { resolvePrimaryTarget } = await import('../snapshot-classes/service.js');
  const primary = await resolvePrimaryTarget(db, 'system_mail');
  if (primary && primary.targetEnabled === 1) {
    return mailSnapshotBackupTargetResponseSchema.parse({
      backupStoreId: primary.targetId,
      backupStoreName: primary.targetName,
      storageType: primary.targetStorageType,
    });
  }

  // Transitional fallback: read the legacy mirror column. Returns
  // null shape when no assignment + no mirror is set.
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
 * Update the backup store for mail snapshots — DEPRECATED.
 *
 * Source of truth moved to `backup_target_assignments[snapshot_class='system_mail']`
 * in migration 0010. This function survives as a passthrough so the
 * existing Mail Snapshot Settings UI keeps working until the frontend
 * switches to the unified Backup Class Assignments page. Both paths
 * take the same row lock (`setAssignments` transaction), so a
 * concurrent PATCH-via-this-endpoint + PUT-via-snapshot-classes can't
 * race into inconsistent state.
 *
 * Behaviour:
 *   - update.backupStoreId === null → clears the system_mail
 *     assignment (and as a side-effect, the route's hook deletes the
 *     Secret + mirror via syncMailResticSecretFromAssignment).
 *   - non-null → validates target exists + enabled, then writes a
 *     single assignment at priority 0.
 *
 * Returns the resolved view as before for backward-compat.
 */
export async function updateMailSnapshotBackupTarget(
  update: MailSnapshotBackupTargetUpdate,
  db: Database,
  opts: SnapshotSettingsOptions,
  encryptionKey: string,
): Promise<MailSnapshotBackupTargetResponse> {
  const { setAssignments } = await import('../snapshot-classes/service.js');
  const { syncMailResticSecretFromAssignment } = await import('./mail-target-sync.js');

  if (!update.backupStoreId) {
    // Clear: empty assignment set → reconciler deletes the Secret.
    await setAssignments(db, 'system_mail', { assignments: [] });
    try {
      await syncMailResticSecretFromAssignment(db, encryptionKey, {
        kubeconfigPath: opts.kubeconfigPath,
      });
    } catch {
      // Best-effort — periodic reconciler heals on next tick.
    }
    return mailSnapshotBackupTargetResponseSchema.parse({
      backupStoreId: null,
      backupStoreName: null,
      storageType: null,
    });
  }

  // setAssignments throws TARGET_NOT_FOUND / TARGET_DISABLED with the
  // same 400 codes the new endpoint surfaces; the route maps them to
  // ApiError so the caller sees identical error shapes.
  const result = await setAssignments(db, 'system_mail', {
    assignments: [{ targetId: update.backupStoreId, priority: 0 }],
  });
  try {
    await syncMailResticSecretFromAssignment(db, encryptionKey, {
      kubeconfigPath: opts.kubeconfigPath,
    });
  } catch {
    // Best-effort.
  }

  const assigned = result.assignments[0];
  return mailSnapshotBackupTargetResponseSchema.parse({
    backupStoreId: assigned.targetId,
    backupStoreName: assigned.targetName,
    storageType: assigned.targetStorageType,
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

// Helpers `buildResticSecretData`, `applyResticSecret`, `deleteResticSecret`,
// and `getOrCreateResticPassword` moved to mail-target-sync.ts as part of
// migration 0010 (mail target binding now lives on snapshot class system_mail).
// Local references in this file go through syncMailResticSecretFromAssignment.
