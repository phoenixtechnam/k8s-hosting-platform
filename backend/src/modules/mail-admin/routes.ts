/**
 * mail-admin routes.
 *
 *   GET  /admin/mail/metrics               →  Stalwart prometheus metrics
 *                                             parsed into a small JSON card
 *                                             shape.
 *   GET  /admin/mail/queue                 →  Stalwart admin API queue
 *                                             contents (per-envelope drill-
 *                                             down for stuck messages).
 *   GET  /admin/mail/stalwart-credentials  →  {username, password} for the
 *                                             fallback-admin, so the admin
 *                                             UI can reveal + copy them.
 *                                             Gated to super_admin/admin/
 *                                             support (same as other routes).
 *   POST /admin/mail/rotate-admin-password →  (Stalwart 0.16) Generate a fresh
 *                                             password, call JMAP Principal/set
 *                                             to update the admin principal's
 *                                             secret in-flight (no Stalwart
 *                                             restart needed), then patch the
 *                                             stalwart-admin-creds k8s Secret
 *                                             mirror. super_admin only.
 *                                             Alias: rotate-stalwart-password
 *                                             (kept for back-compat).
 */

import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import * as service from './service.js';
import { readStalwartCredentials } from './credentials.js';
import { rotateAdminPasswordViaJmap } from './rotate-jmap.js';
import { rotateWebmailMasterPassword } from './rotate-webmail-master.js';
import { getMailPvcStorage, resizeMailPvc } from './mail-pvc.js';
import { getBlobStore, updateBlobStore, getBlobStoreJobStatus } from './blob-store.js';
import {
  startMailArchive,
  startMailArchiveRestore,
  getMailArchiveStatus,
  getMailArchiveRun,
  listMailArchives,
} from './archive.js';
import {
  mailArchiveRestoreRequestSchema,
  mailArchiveTriggerRequestSchema,
} from '@k8s-hosting/api-contracts';
import { getMailNodeSelector, updateMailNodeSelector } from './node-selector.js';
import { getMailSnapshotStatus, triggerMailSnapshot, getMailSnapshotJobStatus } from './snapshot.js';
import {
  getMailSnapshotSchedule,
  updateMailSnapshotSchedule,
  getMailSnapshotBackupTarget,
  updateMailSnapshotBackupTarget,
  recordMailSnapshotLastRun,
  rotateResticPassword,
} from './snapshot-settings.js';
import { getMailPlacement, updateMailPlacement } from './placement.js';
import {
  startMailMigration,
  startFailoverMigration,
  startFailbackMigration,
  getMailMigrationStatus,
} from './migration.js';
import { getMailPortExposure, updateMailPortExposure } from './port-exposure.js';
import {
  mailPvcResizeRequestSchema,
  blobStoreUpdateRequestSchema,
  mailNodeSelectorUpdateSchema,
  mailSnapshotScheduleUpdateSchema,
  mailSnapshotBackupTargetUpdateSchema,
  mailPlacementUpdateRequestSchema,
  mailPortExposureUpdateSchema,
  mailMigrationStartRequestSchema,
  mailFailoverRequestSchema,
  mailFailbackRequestSchema,
} from '@k8s-hosting/api-contracts';

export async function mailAdminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin', 'admin', 'support'));
  // Note: routes that expose the cleartext Stalwart admin password
  // (`/admin/mail/stalwart-credentials` and `/admin/mail/rotate-*`) carry
  // their own narrower preHandler — see below.

  app.get('/admin/mail/metrics', async () => {
    try {
      const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
      const result = await service.getMailMetrics(kubeconfigPath);
      return success(result);
    } catch (err) {
      // Log full error server-side; return a fixed generic message
      // to the client so we don't leak pod names, exec args,
      // cluster addressing, or stalwart-cli internals.
      app.log.warn({ err }, 'mail-admin: metrics fetch failed');
      throw new ApiError(
        'STALWART_METRICS_UNAVAILABLE',
        'Could not fetch Stalwart metrics — see server logs',
        503,
      );
    }
  });

  // Security review HIGH-2 fix (2026-05-03): scope to super_admin only.
  // `support` and `admin` previously inherited the route-wide gate but
  // these are lower-privilege roles that should not see Stalwart's
  // cleartext admin password (which would let them bypass platform
  // audit trails by talking to Stalwart's JMAP/web-admin directly).
  app.get('/admin/mail/stalwart-credentials', { preHandler: requireRole('super_admin') }, async (req) => {
    try {
      return success(readStalwartCredentials(process.env));
    } catch (err) {
      // Audit the *attempt*, not the creds.
      app.log.warn({ err, userId: req.user?.sub }, 'mail-admin: stalwart-credentials read failed');
      throw new ApiError(
        'STALWART_CREDENTIALS_UNAVAILABLE',
        'Stalwart admin credentials are not configured on this platform.',
        503,
      );
    }
  });

  // Stalwart 0.16: JMAP-backed admin password rotation.
  // New canonical route name. No Stalwart StatefulSet restart required —
  // JMAP Principal/set updates the admin secret in-flight.
  const handleRotateAdminPassword = async (req: { user?: { sub?: string } }) => {
    const cfg = app.config as Record<string, unknown>;
    const userId = req.user?.sub ?? 'unknown';
    const kubeconfigPath = cfg.KUBECONFIG_PATH as string | undefined;
    app.log.warn({ userId }, 'mail-admin: rotate-admin-password requested (JMAP)');

    // Register the chip task — the verify-loop after JMAP rotation can
    // take 30-60s as Stalwart pods recycle. Wired via the Task Tracker
    // helper so the operator sees a spinning chip + completion toast.
    // Best-effort: tracker errors must not fail the rotation itself.
    // Cannot use tracked() because the task id must span two logically
    // separate async paths (rotation + best-effort blocklist purge).
    let taskId: string | null = null;
    if (req.user?.sub) {
      try {
        const { start: startTask } = await import('../tasks/service.js');
        const { toSafeText } = await import('@k8s-hosting/api-contracts');
        const started = await startTask(app.db, {
          kind: 'mail.rotate',
          scope: 'admin',
          userId: req.user.sub,
          label: toSafeText('Rotate Stalwart admin password'),
          target: { type: 'route', href: '/settings/email-admin' },
        });
        taskId = started.id;
      } catch (taskErr) {
        app.log.warn(
          { err: taskErr instanceof Error ? taskErr.message : String(taskErr) },
          'mail-admin: task tracker enroll failed (non-fatal)',
        );
      }
    }

    try {
      const result = await rotateAdminPasswordViaJmap({
        kubeconfigPath,
        stalwartNamespace: 'mail',
        secretName: 'stalwart-admin-creds',
        // platform-api reads /etc/stalwart-creds/ADMIN_SECRET_PLAIN
        // from a volume mount of platform/platform-stalwart-creds.
        // Mirror the rotated password into that Secret so platform-api
        // picks it up on the next kubelet refresh (~60s) without needing
        // a pod restart.
        mirrorNamespace: 'platform',
        mirrorSecretName: 'platform-stalwart-creds',
        username: readStalwartCredentials(process.env).username,
        // 2026-05-06 hardening: explicitly recycle Stalwart pods between
        // Secret-patch and verify so the verify-loop probes pods that
        // have the NEW env var (avoiding drift caused by Reloader's
        // async rollout). See rotate-jmap.ts comment block + memory.
        recyclePodsBeforeVerify: true,
      });

      // 2026-05-06 hardening: best-effort purge of cluster-internal
      // BlockedIp entries. The rotation churn may have left platform-api
      // pod IPs and/or hostNetwork node IPs in Stalwart's auth-rate-limit
      // blocklist. Leaving them blocks operator iframe logins (nginx-
      // ingress proxies from a node IP that may still be blocklisted).
      // Failures are logged but do not fail the rotation.
      try {
        const { purgeClusterInternalBlockedIps } = await import('./purge-blocked-ips.js');
        const podCidrV4 = (process.env.PLATFORM_POD_CIDR_V4?.trim() || '10.42.0.0/16');
        const purgeResult = await purgeClusterInternalBlockedIps({
          kubeconfigPath,
          podCidrV4,
        });
        app.log.warn({
          userId,
          rotatedAt: result.rotatedAt,
          recycle: result.recycleResult,
          purgedBlockedIps: purgeResult.purgedCount,
          purgeRan: purgeResult.ran,
        }, 'mail-admin: rotation succeeded (JMAP) + cluster blocklist purged');
      } catch (purgeErr) {
        app.log.warn({
          userId,
          err: purgeErr instanceof Error ? purgeErr.message : String(purgeErr),
        }, 'mail-admin: blocklist purge failed (non-fatal — rotation already succeeded)');
      }

      if (taskId) {
        try {
          const { finish: finishTask } = await import('../tasks/service.js');
          await finishTask(app.db, taskId, { status: 'succeeded' });
        } catch (taskErr) {
          app.log.warn(
            { err: taskErr instanceof Error ? taskErr.message : String(taskErr) },
            'mail-admin: task tracker finalize (success) failed (non-fatal)',
          );
        }
      }

      return success(result);
    } catch (err) {
      app.log.error({ err, userId }, 'mail-admin: rotation failed');
      if (taskId) {
        try {
          const { finish: finishTask } = await import('../tasks/service.js');
          const errMsg = err instanceof Error ? err.message : String(err);
          await finishTask(app.db, taskId, { status: 'failed', error: errMsg });
        } catch (taskErr) {
          app.log.warn(
            { err: taskErr instanceof Error ? taskErr.message : String(taskErr) },
            'mail-admin: task tracker finalize (failure) failed (non-fatal)',
          );
        }
      }
      if (err instanceof ApiError) throw err;
      throw new ApiError(
        'STALWART_ROTATION_FAILED',
        'Stalwart admin password rotation failed. See server logs.',
        500,
      );
    }
  };

  // Canonical 0.16 route
  app.post('/admin/mail/rotate-admin-password', { preHandler: requireRole('super_admin') }, handleRotateAdminPassword);

  // Legacy alias — keeps the frontend hook working without a breaking change
  // until we rename the UI label in a follow-up.
  app.post('/admin/mail/rotate-stalwart-password', { preHandler: requireRole('super_admin') }, handleRotateAdminPassword);

  // Cut 3 (2026-05-05): rotate the Stalwart `master@master.local` Account
  // password (consumed by Roundcube's jwt_auth plugin for IMAP master-
  // user impersonation). Same JMAP+Secret mechanics as the admin route
  // but targets `roundcube-secrets/STALWART_MASTER_PASSWORD` and rolls
  // the Roundcube Deployment afterwards (Roundcube reads the env var
  // at process start, not via volume-mount refresh).
  const handleRotateWebmailMasterPassword = async (req: { user?: { sub?: string } }) => {
    const cfg = app.config as Record<string, unknown>;
    const userId = req.user?.sub ?? 'unknown';
    app.log.warn({ userId }, 'mail-admin: rotate-webmail-master-password requested');
    try {
      const result = await rotateWebmailMasterPassword({
        kubeconfigPath: cfg.KUBECONFIG_PATH as string | undefined,
      });
      app.log.warn({ userId, rotatedAt: result.rotatedAt }, 'mail-admin: webmail master rotation succeeded');
      return success(result);
    } catch (err) {
      app.log.error({ err, userId }, 'mail-admin: webmail master rotation failed');
      if (err instanceof ApiError) throw err;
      throw new ApiError(
        'WEBMAIL_MASTER_ROTATION_FAILED',
        'Webmail master password rotation failed. See server logs.',
        500,
      );
    }
  };
  app.post(
    '/admin/mail/rotate-webmail-master-password',
    { preHandler: requireRole('super_admin') },
    handleRotateWebmailMasterPassword,
  );

  // ─── Mail PVC storage (mail-pg-1) ─────────────────────────────────
  // GET reads live size + capacity + StorageClass.allowVolumeExpansion
  // + (best-effort) used/free from a df probe inside the CNPG primary.
  // PATCH online-grows; rejects shrink + same-size + SC-no-expansion
  // up-front with explicit error codes the UI surfaces in <ErrorPanel>.
  app.get(
    '/admin/mail/pvc/storage',
    { preHandler: requireRole('super_admin') },
    async () => {
      const cfg = app.config as Record<string, unknown>;
      try {
        const result = await getMailPvcStorage({
          kubeconfigPath: cfg.KUBECONFIG_PATH as string | undefined,
        });
        return success(result);
      } catch (err) {
        if (err instanceof ApiError) throw err;
        app.log.warn({ err }, 'mail-admin: pvc storage read failed');
        throw new ApiError(
          'MAIL_PVC_READ_FAILED',
          'Could not read mail-pg-1 PVC state — see server logs',
          503,
        );
      }
    },
  );
  app.patch(
    '/admin/mail/pvc/storage',
    { preHandler: requireRole('super_admin') },
    async (req: { body: unknown; user?: { sub?: string } }) => {
      const cfg = app.config as Record<string, unknown>;
      const userId = req.user?.sub ?? 'unknown';
      const parsed = mailPvcResizeRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError(
          'VALIDATION_ERROR',
          parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', '),
          400,
        );
      }
      app.log.warn({ userId, newGiB: parsed.data.newGiB }, 'mail-admin: pvc resize requested');
      try {
        const result = await resizeMailPvc(parsed.data.newGiB, {
          kubeconfigPath: cfg.KUBECONFIG_PATH as string | undefined,
        });
        app.log.warn({ userId, newGiB: parsed.data.newGiB }, 'mail-admin: pvc resize patched');
        return success(result);
      } catch (err) {
        if (err instanceof ApiError) throw err;
        app.log.error({ err, userId }, 'mail-admin: pvc resize failed');
        throw new ApiError(
          'MAIL_PVC_RESIZE_FAILED',
          'mail-pg-1 PVC resize failed — see server logs',
          500,
        );
      }
    },
  );

  // ─── Stalwart BlobStore (singleton) ──────────────────────────────
  // GET reads the current backend type via short-lived Pod running
  // `stalwart-cli get BlobStore`. PATCH spawns a Job that runs cli
  // update + self-verify. S3 credentials flow via Secret + envFrom,
  // never argv. Job-status poll endpoint surfaces the cli BEFORE/
  // AFTER output via the Pod log.
  app.get(
    '/admin/mail/blob-store',
    { preHandler: requireRole('super_admin') },
    async () => {
      const cfg = app.config as Record<string, unknown>;
      try {
        const result = await getBlobStore({
          kubeconfigPath: cfg.KUBECONFIG_PATH as string | undefined,
        });
        return success(result);
      } catch (err) {
        if (err instanceof ApiError) throw err;
        app.log.warn({ err }, 'mail-admin: blob-store read failed');
        throw new ApiError(
          'BLOB_STORE_READ_FAILED',
          'Could not read Stalwart BlobStore — see server logs',
          503,
        );
      }
    },
  );
  app.patch(
    '/admin/mail/blob-store',
    { preHandler: requireRole('super_admin') },
    async (req: { body: unknown; user?: { sub?: string } }) => {
      const cfg = app.config as Record<string, unknown>;
      const userId = req.user?.sub ?? 'unknown';
      const parsed = blobStoreUpdateRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError(
          'VALIDATION_ERROR',
          parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', '),
          400,
        );
      }
      // Audit-log the SWITCH (not the credentials). NEVER log the
      // S3 secretKey — it would land in pod logs.
      app.log.warn({
        userId,
        type: parsed.data.type,
        ...(parsed.data.type === 'S3' && { bucket: parsed.data.s3.bucket, region: parsed.data.s3.region }),
      }, 'mail-admin: blob-store switch requested');
      try {
        const result = await updateBlobStore(parsed.data, {
          kubeconfigPath: cfg.KUBECONFIG_PATH as string | undefined,
        });
        return success(result);
      } catch (err) {
        if (err instanceof ApiError) throw err;
        app.log.error({ err, userId }, 'mail-admin: blob-store switch failed');
        throw new ApiError(
          'BLOB_STORE_UPDATE_FAILED',
          'BlobStore switch failed — see server logs',
          500,
        );
      }
    },
  );
  app.get(
    '/admin/mail/blob-store/jobs/:name',
    { preHandler: requireRole('super_admin') },
    async (req: { params: unknown }) => {
      const cfg = app.config as Record<string, unknown>;
      const params = req.params as { name?: string };
      const name = params.name ?? '';
      // Whitelist on shape — guards against listing arbitrary Jobs
      // through this route by malformed name input.
      if (!/^stalwart-blob-store-update-[a-z0-9-]+$/.test(name)) {
        throw new ApiError(
          'BLOB_STORE_JOB_INVALID_NAME',
          'job name must match the stalwart-blob-store-update-<id> shape',
          400,
        );
      }
      try {
        const result = await getBlobStoreJobStatus(name, {
          kubeconfigPath: cfg.KUBECONFIG_PATH as string | undefined,
        });
        return success(result);
      } catch (err) {
        if (err instanceof ApiError) throw err;
        app.log.warn({ err, name }, 'mail-admin: blob-store job status failed');
        throw new ApiError(
          'BLOB_STORE_JOB_STATUS_FAILED',
          'Could not read blob-store Job status — see server logs',
          503,
        );
      }
    },
  );

  app.get('/admin/mail/queue', async () => {
    try {
      const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
      const result = await service.getMailQueue(kubeconfigPath);
      if (result.status >= 400) {
        throw new ApiError(
          'STALWART_QUEUE_ERROR',
          'Stalwart queue API returned an error — see server logs',
          502,
        );
      }
      return success(result.raw);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      // Same generic-message principle as the metrics route.
      app.log.warn({ err }, 'mail-admin: queue fetch failed');
      throw new ApiError(
        'STALWART_QUEUE_UNAVAILABLE',
        'Could not fetch Stalwart queue — see server logs',
        503,
      );
    }
  });

  // ─── Stalwart node selector ───────────────────────────────────────
  // GET reads the current nodeAffinity from the Stalwart Deployment
  // plus the live pod's scheduled node.
  // PATCH sets the nodeAffinity (any / preferred / required) on the
  // Deployment; validates the target node exists before patching.
  app.get(
    '/admin/mail/node-selector',
    { preHandler: requireRole('super_admin') },
    async () => {
      const cfg = app.config as Record<string, unknown>;
      try {
        const result = await getMailNodeSelector({
          kubeconfigPath: cfg.KUBECONFIG_PATH as string | undefined,
        });
        return success(result);
      } catch (err) {
        if (err instanceof ApiError) throw err;
        app.log.warn({ err }, 'mail-admin: node-selector read failed');
        throw new ApiError(
          'MAIL_NODE_SELECTOR_READ_FAILED',
          'Could not read Stalwart node selector — see server logs',
          503,
        );
      }
    },
  );

  app.patch(
    '/admin/mail/node-selector',
    { preHandler: requireRole('super_admin') },
    async (req: { body: unknown; user?: { sub?: string } }) => {
      const cfg = app.config as Record<string, unknown>;
      const userId = req.user?.sub ?? 'unknown';
      const parsed = mailNodeSelectorUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError(
          'VALIDATION_ERROR',
          parsed.error.issues.map((i) => `${String(i.path.join('.'))}: ${i.message}`).join(', '),
          400,
        );
      }
      app.log.warn(
        { userId, mode: parsed.data.mode, nodeName: parsed.data.nodeName },
        'mail-admin: node-selector update requested',
      );
      try {
        const result = await updateMailNodeSelector(parsed.data, {
          kubeconfigPath: cfg.KUBECONFIG_PATH as string | undefined,
        });
        app.log.warn(
          { userId, mode: parsed.data.mode, nodeName: parsed.data.nodeName },
          'mail-admin: node-selector updated',
        );
        return success(result);
      } catch (err) {
        if (err instanceof ApiError) throw err;
        app.log.error({ err, userId }, 'mail-admin: node-selector update failed');
        throw new ApiError(
          'MAIL_NODE_SELECTOR_PATCH_FAILED',
          'Stalwart node selector update failed — see server logs',
          500,
        );
      }
    },
  );

  // ─── Stalwart DataStore snapshot ─────────────────────────────────
  // GET  /admin/mail/snapshot-status     — CronJob state + last snapshot time
  // POST /admin/mail/snapshot/trigger    — spawn a one-shot manual snapshot Job
  // GET  /admin/mail/snapshot/jobs/:name — poll Job status + pod log tail
  app.get(
    '/admin/mail/snapshot-status',
    { preHandler: requireRole('super_admin') },
    async () => {
      const cfg = app.config as Record<string, unknown>;
      try {
        const result = await getMailSnapshotStatus({
          kubeconfigPath: cfg.KUBECONFIG_PATH as string | undefined,
          db: app.db,
        });
        return success(result);
      } catch (err) {
        if (err instanceof ApiError) throw err;
        app.log.warn({ err }, 'mail-admin: snapshot status read failed');
        throw new ApiError(
          'SNAPSHOT_STATUS_READ_FAILED',
          'Could not read Stalwart snapshot status — see server logs',
          503,
        );
      }
    },
  );

  app.post(
    '/admin/mail/snapshot/trigger',
    { preHandler: requireRole('super_admin') },
    async (req: { user?: { sub?: string } }) => {
      const cfg = app.config as Record<string, unknown>;
      const userId = req.user?.sub ?? 'unknown';
      app.log.warn({ userId }, 'mail-admin: manual snapshot trigger requested');
      try {
        const result = await triggerMailSnapshot({
          kubeconfigPath: cfg.KUBECONFIG_PATH as string | undefined,
        });
        app.log.warn({ userId, jobName: result.jobName }, 'mail-admin: manual snapshot Job created');
        return success(result);
      } catch (err) {
        if (err instanceof ApiError) throw err;
        app.log.error({ err, userId }, 'mail-admin: snapshot trigger failed');
        throw new ApiError(
          'SNAPSHOT_TRIGGER_FAILED',
          'Could not trigger Stalwart snapshot — see server logs',
          500,
        );
      }
    },
  );

  app.get(
    '/admin/mail/snapshot/jobs/:name',
    { preHandler: requireRole('super_admin') },
    async (req: { params: unknown }) => {
      const cfg = app.config as Record<string, unknown>;
      const params = req.params as { name?: string };
      const name = params.name ?? '';
      // Whitelist on shape — guards against fetching arbitrary Jobs via this route.
      if (!/^stalwart-snapshot-[a-z0-9-]+$/.test(name)) {
        throw new ApiError(
          'SNAPSHOT_JOB_INVALID_NAME',
          'job name must match the stalwart-snapshot-<id> shape',
          400,
        );
      }
      try {
        const result = await getMailSnapshotJobStatus(name, {
          kubeconfigPath: cfg.KUBECONFIG_PATH as string | undefined,
        });
        return success(result);
      } catch (err) {
        if (err instanceof ApiError) throw err;
        app.log.warn({ err, name }, 'mail-admin: snapshot job status failed');
        throw new ApiError(
          'SNAPSHOT_JOB_STATUS_FAILED',
          'Could not read snapshot Job status — see server logs',
          503,
        );
      }
    },
  );

  // ─── App-level archive (stalwart -e) ──────────────────────────────
  // Distinct from the continuous restic backup. Operator-triggered,
  // briefly disruptive (~60-120s), produces a store-agnostic LZ4
  // export. See archive.ts for full architecture notes.
  //
  // GET  /admin/mail/archive-status            — summary card payload
  // GET  /admin/mail/archive-runs              — paginated list for the table
  // GET  /admin/mail/archive-runs/:id          — single run (UI polling)
  // POST /admin/mail/archive/trigger           — start a new run
  // POST /admin/mail/archive/restore           — restore from a past run
  app.get(
    '/admin/mail/archive-status',
    { preHandler: requireRole('super_admin') },
    async () => {
      const cfg = app.config as Record<string, unknown>;
      try {
        const kubeconfigPath = cfg.KUBECONFIG_PATH as string | undefined;
        const { createK8sClients } = await import('../../modules/k8s-provisioner/k8s-client.js');
        const k8s = createK8sClients(kubeconfigPath);
        const result = await getMailArchiveStatus({ ...k8s, db: app.db, kubeconfigPath });
        return success(result);
      } catch (err) {
        if (err instanceof ApiError) throw err;
        app.log.warn({ err }, 'mail-admin: archive status read failed');
        throw new ApiError(
          'MAIL_ARCHIVE_STATUS_FAILED',
          'Could not read mail archive status — see server logs',
          503,
        );
      }
    },
  );

  app.get(
    '/admin/mail/archive-runs',
    { preHandler: requireRole('super_admin') },
    async (req: { query: unknown }) => {
      const cfg = app.config as Record<string, unknown>;
      const q = (req.query ?? {}) as { limit?: string; offset?: string };
      // Cap limit to 100 to match the platform PaginationParams contract.
      const limit = Math.min(100, Math.max(1, Number(q.limit ?? 20) || 20));
      const offset = Math.max(0, Number(q.offset ?? 0) || 0);
      try {
        const kubeconfigPath = cfg.KUBECONFIG_PATH as string | undefined;
        const { createK8sClients } = await import('../../modules/k8s-provisioner/k8s-client.js');
        const k8s = createK8sClients(kubeconfigPath);
        const result = await listMailArchives({ limit, offset }, { ...k8s, db: app.db, kubeconfigPath });
        return success(result);
      } catch (err) {
        if (err instanceof ApiError) throw err;
        app.log.warn({ err }, 'mail-admin: archive list failed');
        throw new ApiError('MAIL_ARCHIVE_LIST_FAILED', 'Could not list mail archives — see server logs', 503);
      }
    },
  );

  app.get(
    '/admin/mail/archive-runs/:id',
    { preHandler: requireRole('super_admin') },
    async (req: { params: unknown }) => {
      const cfg = app.config as Record<string, unknown>;
      const p = (req.params ?? {}) as { id?: string };
      if (!p.id || !/^[a-f0-9-]{36}$/.test(p.id)) {
        throw new ApiError('MAIL_ARCHIVE_RUN_INVALID_ID', 'archive run id must be a UUID', 400);
      }
      try {
        const kubeconfigPath = cfg.KUBECONFIG_PATH as string | undefined;
        const { createK8sClients } = await import('../../modules/k8s-provisioner/k8s-client.js');
        const k8s = createK8sClients(kubeconfigPath);
        const result = await getMailArchiveRun(p.id, { ...k8s, db: app.db, kubeconfigPath });
        return success(result);
      } catch (err) {
        if (err instanceof ApiError) throw err;
        app.log.warn({ err, runId: p.id }, 'mail-admin: archive run read failed');
        throw new ApiError(
          'MAIL_ARCHIVE_RUN_READ_FAILED',
          'Could not read archive run — see server logs',
          503,
        );
      }
    },
  );

  app.post(
    '/admin/mail/archive/trigger',
    { preHandler: requireRole('super_admin') },
    async (req: { body: unknown; user?: { sub?: string } }) => {
      const cfg = app.config as Record<string, unknown>;
      const userId = req.user?.sub ?? 'unknown';
      // Body is optional — empty body is fine and means "default mode".
      const parsed = mailArchiveTriggerRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new ApiError(
          'VALIDATION_ERROR',
          parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', '),
          400,
        );
      }
      const mode = parsed.data.mode; // undefined → orchestrator default (no_downtime)
      app.log.warn(
        { userId, mode: mode ?? 'default(no_downtime)' },
        mode === 'downtime'
          ? 'mail-admin: archive trigger requested (will incur ~60-120s mail downtime)'
          : 'mail-admin: archive trigger requested (no-downtime path)',
      );
      try {
        const kubeconfigPath = cfg.KUBECONFIG_PATH as string | undefined;
        const { createK8sClients } = await import('../../modules/k8s-provisioner/k8s-client.js');
        const k8s = createK8sClients(kubeconfigPath);
        const result = await startMailArchive(
          { ...k8s, db: app.db, kubeconfigPath, userId },
          { mode },
        );
        app.log.warn({ userId, runId: result.runId }, 'mail-admin: archive run started');
        return success(result);
      } catch (err) {
        if (err instanceof ApiError) throw err;
        app.log.error({ err, userId }, 'mail-admin: archive trigger failed');
        throw new ApiError(
          'MAIL_ARCHIVE_TRIGGER_FAILED',
          'Could not start mail archive — see server logs',
          500,
        );
      }
    },
  );

  app.post(
    '/admin/mail/archive/restore',
    { preHandler: requireRole('super_admin') },
    async (req: { body: unknown; user?: { sub?: string } }) => {
      const cfg = app.config as Record<string, unknown>;
      const userId = req.user?.sub ?? 'unknown';
      const parsed = mailArchiveRestoreRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError(
          'VALIDATION_ERROR',
          parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', '),
          400,
        );
      }
      // DESTRUCTIVE — replaces live mail data with the archive contents.
      app.log.warn(
        { userId, sourceRunId: parsed.data.runId },
        'mail-admin: ARCHIVE RESTORE requested — live mail data will be replaced',
      );
      try {
        const kubeconfigPath = cfg.KUBECONFIG_PATH as string | undefined;
        const { createK8sClients } = await import('../../modules/k8s-provisioner/k8s-client.js');
        const k8s = createK8sClients(kubeconfigPath);
        const result = await startMailArchiveRestore(parsed.data.runId, {
          ...k8s,
          db: app.db,
          kubeconfigPath,
          userId,
        });
        app.log.warn(
          { userId, restoreRunId: result.runId, sourceRunId: parsed.data.runId },
          'mail-admin: archive restore started',
        );
        return success(result);
      } catch (err) {
        if (err instanceof ApiError) throw err;
        app.log.error({ err, userId }, 'mail-admin: archive restore failed');
        throw new ApiError(
          'MAIL_ARCHIVE_RESTORE_FAILED',
          'Could not start mail archive restore — see server logs',
          500,
        );
      }
    },
  );

  // ─── Snapshot schedule ────────────────────────────────────────────
  app.get(
    '/admin/mail/snapshot-schedule',
    { preHandler: requireRole('super_admin') },
    async () => {
      const cfg = app.config as Record<string, unknown>;
      try {
        const result = await getMailSnapshotSchedule(app.db, {
          kubeconfigPath: cfg.KUBECONFIG_PATH as string | undefined,
        });
        return success(result);
      } catch (err) {
        if (err instanceof ApiError) throw err;
        app.log.warn({ err }, 'mail-admin: snapshot schedule read failed');
        throw new ApiError(
          'SNAPSHOT_SCHEDULE_READ_FAILED',
          'Could not read snapshot schedule — see server logs',
          503,
        );
      }
    },
  );

  app.patch(
    '/admin/mail/snapshot-schedule',
    { preHandler: requireRole('super_admin') },
    async (req: { body: unknown; user?: { sub?: string } }) => {
      const cfg = app.config as Record<string, unknown>;
      const userId = req.user?.sub ?? 'unknown';
      const parsed = mailSnapshotScheduleUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError(
          'VALIDATION_ERROR',
          parsed.error.issues.map((i: { path: PropertyKey[]; message: string }) => `${i.path.join('.')}: ${i.message}`).join(', '),
          400,
        );
      }
      app.log.warn({ userId, scheduleExpression: parsed.data.scheduleExpression }, 'mail-admin: snapshot schedule update requested');
      try {
        const result = await updateMailSnapshotSchedule(parsed.data, app.db, {
          kubeconfigPath: cfg.KUBECONFIG_PATH as string | undefined,
        });
        app.log.warn({ userId, scheduleExpression: parsed.data.scheduleExpression }, 'mail-admin: snapshot schedule updated');
        return success(result);
      } catch (err) {
        if (err instanceof ApiError) throw err;
        app.log.error({ err, userId }, 'mail-admin: snapshot schedule update failed');
        throw new ApiError(
          'SNAPSHOT_SCHEDULE_UPDATE_FAILED',
          'Snapshot schedule update failed — see server logs',
          500,
        );
      }
    },
  );

  // ─── Snapshot backup target ───────────────────────────────────────
  app.get(
    '/admin/mail/snapshot-backup-target',
    { preHandler: requireRole('super_admin') },
    async () => {
      try {
        const result = await getMailSnapshotBackupTarget(app.db);
        return success(result);
      } catch (err) {
        if (err instanceof ApiError) throw err;
        app.log.warn({ err }, 'mail-admin: snapshot backup target read failed');
        throw new ApiError(
          'SNAPSHOT_BACKUP_TARGET_READ_FAILED',
          'Could not read snapshot backup target — see server logs',
          503,
        );
      }
    },
  );

  app.patch(
    '/admin/mail/snapshot-backup-target',
    { preHandler: requireRole('super_admin') },
    async (req: { body: unknown; user?: { sub?: string } }) => {
      const cfg = app.config as Record<string, unknown>;
      const userId = req.user?.sub ?? 'unknown';
      const parsed = mailSnapshotBackupTargetUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError(
          'VALIDATION_ERROR',
          parsed.error.issues.map((i: { path: PropertyKey[]; message: string }) => `${i.path.join('.')}: ${i.message}`).join(', '),
          400,
        );
      }
      const encryptionKey = (cfg.ENCRYPTION_KEY as string | undefined) ?? '';
      if (!encryptionKey && parsed.data.backupStoreId) {
        throw new ApiError(
          'ENCRYPTION_KEY_MISSING',
          'ENCRYPTION_KEY env var is not set — cannot decrypt backup store credentials',
          500,
        );
      }
      app.log.warn({ userId, backupStoreId: parsed.data.backupStoreId }, 'mail-admin: snapshot backup target update requested');
      try {
        const result = await updateMailSnapshotBackupTarget(parsed.data, app.db, {
          kubeconfigPath: cfg.KUBECONFIG_PATH as string | undefined,
        }, encryptionKey);
        app.log.warn({ userId, backupStoreId: parsed.data.backupStoreId }, 'mail-admin: snapshot backup target updated');
        return success(result);
      } catch (err) {
        if (err instanceof ApiError) throw err;
        app.log.error({ err, userId }, 'mail-admin: snapshot backup target update failed');
        throw new ApiError(
          'SNAPSHOT_BACKUP_TARGET_UPDATE_FAILED',
          'Snapshot backup target update failed — see server logs',
          500,
        );
      }
    },
  );

  // ─── Internal: snapshot last-run stats (called by upload sidecar) ─
  // Secured by service-account token — not gated by the user RBAC
  // middleware but by checking the Authorization header against the
  // platform SA token in the environment.
  app.post(
    '/internal/mail/snapshot-last-run',
    async (req: { body: unknown; headers: Record<string, string | string[] | undefined> }) => {
      const expectedToken = process.env.PLATFORM_INTERNAL_TOKEN;
      if (expectedToken) {
        const auth = req.headers['authorization'] ?? '';
        const token = Array.isArray(auth) ? auth[0] : auth;
        if (!token.startsWith('Bearer ') || token.slice(7) !== expectedToken) {
          throw new ApiError('UNAUTHORIZED', 'Invalid internal token', 401);
        }
      }
      const body = req.body as { totalSnapshotSizeBytes?: unknown; snapshotCount?: unknown };
      const totalSnapshotSizeBytes = Number(body.totalSnapshotSizeBytes ?? 0);
      const snapshotCount = Number(body.snapshotCount ?? 0);
      if (!Number.isFinite(totalSnapshotSizeBytes) || !Number.isFinite(snapshotCount)) {
        throw new ApiError('VALIDATION_ERROR', 'totalSnapshotSizeBytes and snapshotCount must be numbers', 400);
      }
      await recordMailSnapshotLastRun(app.db, { totalSnapshotSizeBytes, snapshotCount });
      return success({ recorded: true });
    },
  );

  // ─── Snapshot restic password rotation ───────────────────────────
  // DELETE the stalwart-snapshot-restic-password Secret so the next
  // backup-target update generates a fresh random password. Operators
  // must `restic rekey` any existing repos before the next backup run.
  app.post(
    '/admin/mail/snapshot-backup-target/rotate-password',
    { preHandler: requireRole('super_admin') },
    async (req: { user?: { sub?: string } }) => {
      const cfg = app.config as Record<string, unknown>;
      const userId = req.user?.sub ?? 'unknown';
      app.log.warn({ userId }, 'mail-admin: restic password rotation requested');
      try {
        const result = await rotateResticPassword({
          kubeconfigPath: cfg.KUBECONFIG_PATH as string | undefined,
        });
        app.log.warn({ userId }, 'mail-admin: restic password rotated — operator must rekey existing repos');
        return success(result);
      } catch (err) {
        if (err instanceof ApiError) throw err;
        app.log.error({ err, userId }, 'mail-admin: restic password rotation failed');
        throw new ApiError(
          'RESTIC_PASSWORD_ROTATION_FAILED',
          'Restic password rotation failed — see server logs',
          500,
        );
      }
    },
  );

  // ─── Mail placement policy ────────────────────────────────────────
  // GET reads primary/secondary/tertiary node assignment + DR state.
  // PATCH updates the assignment (validates nodes exist in cluster).
  app.get(
    '/admin/mail/placement',
    { preHandler: requireRole('super_admin') },
    async () => {
      const cfg = app.config as Record<string, unknown>;
      try {
        const result = await getMailPlacement(app.db, {
          kubeconfigPath: cfg.KUBECONFIG_PATH as string | undefined,
        });
        return success(result);
      } catch (err) {
        if (err instanceof ApiError) throw err;
        app.log.warn({ err }, 'mail-admin: placement read failed');
        throw new ApiError(
          'MAIL_PLACEMENT_READ_FAILED',
          'Could not read mail placement policy — see server logs',
          503,
        );
      }
    },
  );

  app.patch(
    '/admin/mail/placement',
    { preHandler: requireRole('super_admin') },
    async (req: { body: unknown; user?: { sub?: string } }) => {
      const cfg = app.config as Record<string, unknown>;
      const userId = req.user?.sub ?? 'unknown';
      const parsed = mailPlacementUpdateRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError(
          'VALIDATION_ERROR',
          parsed.error.issues.map((i: { path: PropertyKey[]; message: string }) => `${i.path.join('.')}: ${i.message}`).join(', '),
          400,
        );
      }
      app.log.warn(
        { userId, primaryNode: parsed.data.primaryNode, secondaryNode: parsed.data.secondaryNode },
        'mail-admin: placement update requested',
      );
      try {
        await updateMailPlacement(parsed.data, app.db, {
          kubeconfigPath: cfg.KUBECONFIG_PATH as string | undefined,
        });
        app.log.warn({ userId }, 'mail-admin: placement updated');
        return success({ updated: true });
      } catch (err) {
        if (err instanceof ApiError) throw err;
        app.log.error({ err, userId }, 'mail-admin: placement update failed');
        throw new ApiError(
          'MAIL_PLACEMENT_UPDATE_FAILED',
          'Mail placement update failed — see server logs',
          500,
        );
      }
    },
  );

  // ─── Mail failover / failback / migrate (Phase 5) ────────────────
  // POST /admin/mail/failover — pick secondary/tertiary node + start migration.
  // POST /admin/mail/failback — migrate back to primary node.
  // POST /admin/mail/migrate  — migrate to an explicit targetNode.
  // GET  /admin/mail/migrate/:runId — poll migration status.
  app.post(
    '/admin/mail/failover',
    { preHandler: requireRole('super_admin') },
    async (req: { body: unknown; user?: { sub?: string } }) => {
      const cfg = app.config as Record<string, unknown>;
      const userId = req.user?.sub ?? 'unknown';
      const parsed = mailFailoverRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError(
          'VALIDATION_ERROR',
          parsed.error.issues.map((i: { path: PropertyKey[]; message: string }) => `${i.path.join('.')}: ${i.message}`).join(', '),
          400,
        );
      }
      app.log.warn({ userId }, 'mail-admin: manual failover requested');
      try {
        const kubeconfigPath = cfg.KUBECONFIG_PATH as string | undefined;
        const { createK8sClients } = await import('../../modules/k8s-provisioner/k8s-client.js');
        const k8s = createK8sClients(kubeconfigPath);
        // If targetNode is explicitly provided, use it; otherwise pick secondary/tertiary.
        let result: { runId: string };
        if (parsed.data.targetNode) {
          result = await startMailMigration(
            { targetNode: parsed.data.targetNode, triggeredBy: 'manual-failover' },
            { ...k8s, db: app.db, kubeconfigPath },
          );
        } else {
          result = await startFailoverMigration(
            { confirm: true },
            { ...k8s, db: app.db, kubeconfigPath },
          );
        }
        app.log.warn({ userId, runId: result.runId }, 'mail-admin: failover migration started');
        return success(result);
      } catch (err) {
        if (err instanceof ApiError) throw err;
        app.log.error({ err, userId }, 'mail-admin: failover failed');
        throw new ApiError('MAIL_FAILOVER_FAILED', 'Mail failover failed — see server logs', 500);
      }
    },
  );

  app.post(
    '/admin/mail/failback',
    { preHandler: requireRole('super_admin') },
    async (req: { body: unknown; user?: { sub?: string } }) => {
      const cfg = app.config as Record<string, unknown>;
      const userId = req.user?.sub ?? 'unknown';
      const parsed = mailFailbackRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError(
          'VALIDATION_ERROR',
          parsed.error.issues.map((i: { path: PropertyKey[]; message: string }) => `${i.path.join('.')}: ${i.message}`).join(', '),
          400,
        );
      }
      app.log.warn({ userId }, 'mail-admin: manual failback requested');
      try {
        const kubeconfigPath = cfg.KUBECONFIG_PATH as string | undefined;
        const { createK8sClients } = await import('../../modules/k8s-provisioner/k8s-client.js');
        const k8s = createK8sClients(kubeconfigPath);
        const result = await startFailbackMigration(
          { confirm: true },
          { ...k8s, db: app.db, kubeconfigPath },
        );
        app.log.warn({ userId, runId: result.runId }, 'mail-admin: failback migration started');
        return success(result);
      } catch (err) {
        if (err instanceof ApiError) throw err;
        app.log.error({ err, userId }, 'mail-admin: failback failed');
        throw new ApiError('MAIL_FAILBACK_FAILED', 'Mail failback failed — see server logs', 500);
      }
    },
  );

  app.post(
    '/admin/mail/migrate',
    { preHandler: requireRole('super_admin') },
    async (req: { body: unknown; user?: { sub?: string } }) => {
      const cfg = app.config as Record<string, unknown>;
      const userId = req.user?.sub ?? 'unknown';
      const parsed = mailMigrationStartRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError(
          'VALIDATION_ERROR',
          parsed.error.issues.map((i: { path: PropertyKey[]; message: string }) => `${i.path.join('.')}: ${i.message}`).join(', '),
          400,
        );
      }
      app.log.warn({ userId, targetNode: parsed.data.targetNode }, 'mail-admin: migrate requested');
      try {
        const kubeconfigPath = cfg.KUBECONFIG_PATH as string | undefined;
        const { createK8sClients } = await import('../../modules/k8s-provisioner/k8s-client.js');
        const k8s = createK8sClients(kubeconfigPath);
        const result = await startMailMigration(
          { targetNode: parsed.data.targetNode, triggeredBy: 'operator', newGiB: parsed.data.newGiB },
          { ...k8s, db: app.db, kubeconfigPath },
        );
        app.log.warn({ userId, runId: result.runId, targetNode: parsed.data.targetNode }, 'mail-admin: migration started');
        return success(result);
      } catch (err) {
        if (err instanceof ApiError) throw err;
        app.log.error({ err, userId }, 'mail-admin: migrate failed');
        throw new ApiError('MAIL_MIGRATE_FAILED', 'Mail migration failed to start — see server logs', 500);
      }
    },
  );

  app.get(
    '/admin/mail/migrate/:runId',
    { preHandler: requireRole('super_admin') },
    async (req: { params: unknown }) => {
      const params = req.params as { runId?: string };
      const runId = params.runId ?? '';
      if (!/^[0-9a-f-]{36}$/.test(runId)) {
        throw new ApiError('VALIDATION_ERROR', 'runId must be a UUID', 400);
      }
      try {
        const result = await getMailMigrationStatus(runId, { db: app.db });
        return success(result);
      } catch (err) {
        if (err instanceof ApiError) throw err;
        app.log.warn({ err, runId }, 'mail-admin: migrate status read failed');
        throw new ApiError('MAIL_MIGRATE_STATUS_FAILED', 'Could not read migration status — see server logs', 503);
      }
    },
  );

  // ─── Mail port exposure mode ──────────────────────────────────────
  // GET reads current mode + haproxy DaemonSet status.
  // PATCH toggles between thisNodeOnly and allServerNodes.
  app.get(
    '/admin/mail/port-exposure',
    { preHandler: requireRole('super_admin') },
    async () => {
      const cfg = app.config as Record<string, unknown>;
      try {
        const result = await getMailPortExposure(app.db, {
          kubeconfigPath: cfg.KUBECONFIG_PATH as string | undefined,
        });
        return success(result);
      } catch (err) {
        if (err instanceof ApiError) throw err;
        app.log.warn({ err }, 'mail-admin: port-exposure read failed');
        throw new ApiError(
          'MAIL_PORT_EXPOSURE_READ_FAILED',
          'Could not read mail port exposure mode — see server logs',
          503,
        );
      }
    },
  );

  app.patch(
    '/admin/mail/port-exposure',
    { preHandler: requireRole('super_admin') },
    async (req: { body: unknown; user?: { sub?: string } }) => {
      const cfg = app.config as Record<string, unknown>;
      const userId = req.user?.sub ?? 'unknown';
      const parsed = mailPortExposureUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError(
          'VALIDATION_ERROR',
          parsed.error.issues.map((i: { path: PropertyKey[]; message: string }) => `${i.path.join('.')}: ${i.message}`).join(', '),
          400,
        );
      }
      app.log.warn({ userId, mode: parsed.data.mode }, 'mail-admin: port-exposure mode change requested');
      try {
        await updateMailPortExposure(parsed.data, app.db, {
          kubeconfigPath: cfg.KUBECONFIG_PATH as string | undefined,
        });
        app.log.warn({ userId, mode: parsed.data.mode }, 'mail-admin: port-exposure mode updated');
        return success({ updated: true });
      } catch (err) {
        if (err instanceof ApiError) throw err;
        app.log.error({ err, userId }, 'mail-admin: port-exposure update failed');
        throw new ApiError(
          'MAIL_PORT_EXPOSURE_UPDATE_FAILED',
          'Mail port exposure update failed — see server logs',
          500,
        );
      }
    },
  );
}
