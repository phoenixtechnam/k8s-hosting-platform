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
  mailPvcResizeRequestSchema,
  blobStoreUpdateRequestSchema,
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
    app.log.warn({ userId }, 'mail-admin: rotate-admin-password requested (JMAP)');
    try {
      const result = await rotateAdminPasswordViaJmap({
        kubeconfigPath: cfg.KUBECONFIG_PATH as string | undefined,
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
      });
      app.log.warn({ userId, rotatedAt: result.rotatedAt }, 'mail-admin: rotation succeeded (JMAP)');
      return success(result);
    } catch (err) {
      app.log.error({ err, userId }, 'mail-admin: rotation failed');
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
}
