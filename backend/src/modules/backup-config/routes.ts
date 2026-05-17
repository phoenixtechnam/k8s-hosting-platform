import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import * as service from './service.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import {
  createBackupConfigSchema,
  updateBackupConfigSchema,
  type CreateBackupConfigInput,
} from '@k8s-hosting/api-contracts';
import type { ZodError } from 'zod';
import { z } from 'zod';
import { createK8sClients, type K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { LonghornTenants } from './longhorn-reconciler.js';

// Turn a Zod issue list into a single human-readable message that's safe
// to surface to an operator via the admin panel. We preserve the field
// path (e.g. "s3_bucket") so the frontend can highlight the specific
// input that failed — response.ts envelope puts the string in `error`.
function zodMessage(err: ZodError): string {
  return err.issues
    .map((i) => {
      const path = i.path.length > 0 ? `${i.path.join('.')}: ` : '';
      return `${path}${i.message}`;
    })
    .join('; ');
}

export async function backupConfigRoutes(app: FastifyInstance): Promise<void> {
  const encryptionKey = app.config?.PLATFORM_ENCRYPTION_KEY ?? process.env.PLATFORM_ENCRYPTION_KEY ?? '0'.repeat(64) /* Dev-only fallback — production requires PLATFORM_ENCRYPTION_KEY env var */;

  // K8s tenant for the Longhorn reconciler. Created once at plugin
  // registration; pattern mirrors webmail-settings/routes.ts. Undefined
  // means the in-cluster config isn't loadable (e.g. vitest runs with
  // no kubeconfig) — handlers that need it return 502 from the
  // try/catch below rather than silently no-op-ing, which was the
  // original bug where `app.k8sTenants` was never decorated and the
  // Longhorn reconciler was always skipped.
  let k8s: K8sClients | undefined;
  try {
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    k8s = createK8sClients(kubeconfigPath);
  } catch (err) {
    app.log.warn({ err }, 'backup-config: k8s tenant unavailable — reconciler disabled');
    k8s = undefined;
  }
  const longhornTenants: LonghornTenants | undefined = k8s
    ? { core: k8s.core, custom: k8s.custom, batch: k8s.batch }
    : undefined;

  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin', 'admin'));

  // GET /api/v1/admin/backup-configs
  app.get('/admin/backup-configs', async () => {
    return success(await service.listBackupConfigs(app.db));
  });

  // POST /api/v1/admin/backup-configs
  app.post('/admin/backup-configs', async (request, reply) => {
    const parsed = createBackupConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', zodMessage(parsed.error), 400);
    }
    const config = await service.createBackupConfig(app.db, parsed.data, encryptionKey);
    reply.status(201).send(success(config));
  });

  // POST /api/v1/admin/backup-configs/test-draft — test BEFORE save.
  //
  // Accepts the same payload shape as POST create but never persists
  // anything. Enables the "Test Connection" button inside the create/
  // edit form so operators don't commit a config that can't talk to S3.
  // NOTE: this route is declared BEFORE the `:id/test` route so Fastify
  // doesn't try to interpret "test-draft" as an id path parameter.
  app.post('/admin/backup-configs/test-draft', async (request) => {
    const parsed = createBackupConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', zodMessage(parsed.error), 400);
    }
    const result = await service.testDraft(parsed.data as CreateBackupConfigInput);
    return success(result);
  });

  // PATCH /api/v1/admin/backup-configs/:id
  app.patch('/admin/backup-configs/:id', async (request) => {
    const { id } = request.params as { id: string };
    const parsed = updateBackupConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', zodMessage(parsed.error), 400);
    }
    const updated = await service.updateBackupConfig(app.db, id, parsed.data, encryptionKey);

    // If the edited row is the active Longhorn target, the cluster
    // Secret + BackupTarget CR still reference the OLD creds/URL. Re-
    // reconcile so the UI edit actually takes effect without an extra
    // Deactivate→Activate dance.
    if (updated.active) {
      try {
        const active = await service.getActiveBackupConfig(app.db, encryptionKey);
        if (active) {
          const { reconcileBackupTarget } = await import('./longhorn-reconciler.js');
          if (!longhornTenants) {
            throw new Error('K8s tenant unavailable — check platform-api pod logs on startup');
          }
          await reconcileBackupTarget(longhornTenants, active);
        }
      } catch (err) {
        request.log.error({ err, configId: id }, 'Failed to reconcile Longhorn after PATCH of active config');
        throw new ApiError(
          'RECONCILE_FAILED',
          `Config saved but Longhorn update failed: ${err instanceof Error ? err.message : 'unknown'}. Toggle Deactivate+Activate to retry.`,
          502,
        );
      }
    }

    return success(updated);
  });

  // DELETE /api/v1/admin/backup-configs/:id
  app.delete('/admin/backup-configs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await service.deleteBackupConfig(app.db, id);
    reply.status(204).send();
  });

  // POST /api/v1/admin/backup-configs/:id/test
  app.post('/admin/backup-configs/:id/test', async (request) => {
    const { id } = request.params as { id: string };
    const result = await service.testConnection(app.db, id, encryptionKey);
    return success(result);
  });

  // Phase 10: POST /api/v1/admin/backup-configs/:id/speedtest
  //
  // Spawns an rclone Job that uploads a random payload (default 100 MB),
  // downloads it back, deletes the remote, and emits a parseable
  // SPEEDTEST_RESULT line. Result is persisted to backup_configurations
  // for the BackupSettings UI tile. Surfaces in task-center as
  // kind='backup.speedtest' with the 4-stage progress modal.
  const speedtestSchema = z.object({
    payloadBytes: z.number().int().min(1_048_576).max(1_073_741_824).optional(),
  });
  app.post('/admin/backup-configs/:id/speedtest', async (request) => {
    if (!k8s) {
      throw new ApiError('K8S_UNAVAILABLE', 'Cluster API not reachable — speedtest requires Job creation', 502);
    }
    const { id } = request.params as { id: string };
    const parsed = speedtestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', parsed.error.issues[0].message, 400);
    }
    const userId = ((request.user as { id?: string } | undefined)?.id) ?? null;
    const { runSpeedtest } = await import('./speedtest.js');
    const result = await runSpeedtest(app.db, k8s, {
      targetId: id,
      payloadBytes: parsed.data.payloadBytes,
      triggeredByUserId: userId,
    });
    return success(result);
  });

  // POST /api/v1/admin/backup-configs/:id/activate — designate this
  // config as the cluster's active Longhorn backup target. Routes the
  // decrypted creds through the reconciler to create/update the
  // BackupTarget CR + credentials Secret. Only one config can be
  // active at a time — activating a new one deactivates the previous.
  app.post('/admin/backup-configs/:id/activate', async (request) => {
    const { id } = request.params as { id: string };
    const row = await service.activateBackupConfig(app.db, id);
    const active = await service.getActiveBackupConfig(app.db, encryptionKey);
    if (active) {
      try {
        const { reconcileBackupTarget } = await import('./longhorn-reconciler.js');
        if (!longhornTenants) {
          throw new Error('K8s tenant unavailable — check platform-api pod logs on startup');
        }
        await reconcileBackupTarget(longhornTenants, active);
      } catch (err) {
        request.log.error({ err, configId: id }, 'Failed to reconcile Longhorn BackupTarget on activate');
        throw new ApiError(
          'RECONCILE_FAILED',
          `Config was activated in the DB but Longhorn update failed: ${err instanceof Error ? err.message : 'unknown'}. Fix the issue and POST /activate again.`,
          502,
        );
      }
    }
    return success(row);
  });

  // GET /api/v1/admin/backup-configs/:id/backups — list recent backups.
  // `id` is the config row id; the scoping for which backups belong to
  // this config is implicit (Longhorn only has one active BackupTarget
  // at a time). When multiple historical targets are listed, the UI
  // can filter tenant-side by `url` prefix if needed.
  app.get('/admin/backup-configs/:id/backups', async () => {
    if (!longhornTenants) {
      throw new ApiError('K8S_UNAVAILABLE', 'K8s tenant unavailable', 502);
    }
    const { listBackups } = await import('./longhorn-backups.js');
    const backups = await listBackups(longhornTenants);
    return success(backups);
  });

  // POST /api/v1/admin/backup-configs/:id/backup-now — trigger an
  // on-demand backup of every PVC carrying the default recurring-job
  // group label. Returns the list of volumes it triggered; operators
  // poll /backups to see progress.
  app.post('/admin/backup-configs/:id/backup-now', async () => {
    if (!longhornTenants) {
      throw new ApiError('K8S_UNAVAILABLE', 'K8s tenant unavailable', 502);
    }
    const { triggerBackupNow } = await import('./longhorn-backups.js');
    try {
      const result = await triggerBackupNow(longhornTenants);
      return success(result);
    } catch (err) {
      throw new ApiError(
        'BACKUP_TRIGGER_FAILED',
        err instanceof Error ? err.message : 'Unknown error triggering backup',
        502,
      );
    }
  });

  // GET /api/v1/admin/backup-health — discovery-driven roll-up of
  // every Job carrying the backup-health-watch=true label. Used by
  // the admin Backups page banner + DR Job Health table.
  app.get('/admin/backup-health', async () => {
    if (!longhornTenants?.batch) {
      throw new ApiError('K8S_UNAVAILABLE', 'K8s tenant unavailable', 502);
    }
    const { listHealthWatchedJobs, summariseHealth } = await import(
      '../backup-health/service.js'
    );
    const jobs = await listHealthWatchedJobs(longhornTenants.batch);
    const summary = summariseHealth(jobs);
    return success(summary);
  });

  // POST /api/v1/admin/backup-configs/:id/deactivate
  app.post('/admin/backup-configs/:id/deactivate', async (request) => {
    const { id } = request.params as { id: string };
    const row = await service.deactivateBackupConfig(app.db, id);
    try {
      const { clearBackupTarget } = await import('./longhorn-reconciler.js');
      if (longhornTenants) {
        // Pass the kind so SSH deactivate skips the Longhorn BackupTarget
        // CR patch (nothing to clear there — SSH never wrote to it).
        await clearBackupTarget(longhornTenants, { kind: row.storageType });
      }
    } catch (err) {
      request.log.warn({ err, configId: id }, 'Failed to clear Longhorn BackupTarget on deactivate');
    }
    return success(row);
  });
}
