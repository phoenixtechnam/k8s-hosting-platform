/**
 * Phase 3 T2.1 — IMAPSync admin API.
 *
 * Endpoints:
 *   GET    /clients/:clientId/mail/imapsync          list jobs
 *   GET    /clients/:clientId/mail/imapsync/:jobId   detail
 *   POST   /clients/:clientId/mail/imapsync          create + start
 *   DELETE /clients/:clientId/mail/imapsync/:jobId   cancel
 *
 * All endpoints require admin or client_admin. The destination
 * authentication uses Stalwart's `master` SSO via the
 * `<mailbox>%master` user with MASTER_SECRET — no per-mailbox
 * cleartext password is needed.
 */

import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { authenticate, requireRole, requireClientAccess } from '../../middleware/auth.js';
import { mailboxes } from '../../db/schema.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { createImapSyncJobSchema } from '@k8s-hosting/api-contracts';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import * as service from './service.js';
import { decrypt } from '../oidc/crypto.js';

const encryptionKey = (): string => {
  const k = process.env.OIDC_ENCRYPTION_KEY;
  if (k && k.length >= 32) return k;
  if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') {
    return '0'.repeat(64);
  }
  throw new Error('OIDC_ENCRYPTION_KEY is required (mail-imapsync routes)');
};

const masterSecret = (): string => {
  const s = process.env.STALWART_MASTER_SECRET ?? process.env.MASTER_SECRET;
  if (s && s.length > 0) return s;
  if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') {
    return 'master-dev-secret-not-for-production';
  }
  throw new Error('STALWART_MASTER_SECRET is required (mail-imapsync routes)');
};

const stalwartImapHost = (): string =>
  process.env.STALWART_IMAP_HOST ?? 'stalwart-mail.mail.svc.cluster.local';
const stalwartImapPort = (): number =>
  parseInt(process.env.STALWART_IMAP_PORT ?? '143', 10);
const imapsyncImage = (): string =>
  process.env.STALWART_IMAPSYNC_IMAGE ?? service.DEFAULT_IMAPSYNC_IMAGE;
const mailNamespace = (): string => process.env.STALWART_NAMESPACE ?? 'mail';

export async function mailImapsyncRoutes(app: FastifyInstance): Promise<void> {
  let k8s: K8sClients | undefined;
  try {
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    k8s = createK8sClients(kubeconfigPath);
  } catch (err) {
    app.log.warn({ err }, 'mail-imapsync: k8s client unavailable — job creation disabled');
    k8s = undefined;
  }

  // GET — list
  app.get('/clients/:clientId/mail/imapsync', {
    onRequest: [authenticate, requireRole('super_admin', 'admin', 'support', 'client_admin'), requireClientAccess()],
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };
    const rows = await service.listImapSyncJobs(app.db, clientId);
    return success(rows);
  });

  // GET — single
  app.get('/clients/:clientId/mail/imapsync/:jobId', {
    onRequest: [authenticate, requireRole('super_admin', 'admin', 'support', 'client_admin'), requireClientAccess()],
  }, async (request) => {
    const { clientId, jobId } = request.params as { clientId: string; jobId: string };
    const row = await service.getImapSyncJob(app.db, clientId, jobId);
    if (!row) {
      throw new ApiError('IMAPSYNC_JOB_NOT_FOUND', 'IMAPSync job not found', 404);
    }
    return success(row);
  });

  // POST — create + start
  app.post('/clients/:clientId/mail/imapsync', {
    onRequest: [authenticate, requireRole('super_admin', 'admin', 'client_admin'), requireClientAccess()],
  }, async (request, reply) => {
    const { clientId } = request.params as { clientId: string };
    const parsed = createImapSyncJobSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    if (!k8s) {
      throw new ApiError(
        'K8S_UNAVAILABLE',
        'Kubernetes client is not configured — IMAPSync disabled',
        503,
      );
    }

    // Validate ALL required env vars BEFORE we insert the DB row.
    // Otherwise a misconfiguration leaves a 'pending' row stuck in
    // the partial unique index and blocks future attempts. Both
    // helpers throw a clear Error if their env var is missing in a
    // non-dev environment; we surface that as a 503 instead of
    // letting it bubble as an unhandled rejection.
    let resolvedMasterSecret: string;
    let resolvedEncryptionKey: string;
    try {
      resolvedMasterSecret = masterSecret();
      resolvedEncryptionKey = encryptionKey();
    } catch (err) {
      throw new ApiError(
        'IMAPSYNC_NOT_CONFIGURED',
        err instanceof Error ? err.message : 'Server is missing required configuration',
        503,
      );
    }

    // 1. Insert pending row (mailbox ownership + concurrency check
    //    enforced inside service.createImapSyncJob).
    const row = await service.createImapSyncJob(
      app.db,
      resolvedEncryptionKey,
      clientId,
      parsed.data,
    );

    // 2. Look up the mailbox address for the destination user
    //    (`<mailbox>%master`).
    const [mb] = await app.db
      .select({ fullAddress: mailboxes.fullAddress })
      .from(mailboxes)
      .where(eq(mailboxes.id, parsed.data.mailbox_id));
    if (!mb) {
      // Should be impossible — createImapSyncJob just verified
      // ownership — but handle the race anyway.
      await service.markFailed(app.db, row.id, 'Mailbox disappeared between create and start');
      throw new ApiError('MAILBOX_NOT_FOUND', 'Mailbox not found', 404);
    }

    // 3. Build the K8s Secret + Job manifests and create them.
    //    On any failure, mark the row failed so the operator can
    //    see the reason in the UI.
    const secret = service.buildJobSecret({
      jobId: row.id,
      namespace: mailNamespace(),
      sourcePassword: parsed.data.source_password,
      destPassword: resolvedMasterSecret,
    });
    const job = service.buildJobManifest({
      jobId: row.id,
      secretName: `imapsync-${row.id}`,
      namespace: mailNamespace(),
      mailboxAddress: mb.fullAddress,
      sourceHost: parsed.data.source_host,
      sourcePort: parsed.data.source_port,
      sourceUsername: parsed.data.source_username,
      sourceSsl: parsed.data.source_ssl,
      destHost: stalwartImapHost(),
      destPort: stalwartImapPort(),
      options: parsed.data.options ?? {},
      image: imapsyncImage(),
    });

    try {
      // Order: Secret → Job → PATCH Secret with ownerReference.
      //
      // Why:
      //   1. The pod must be able to mount the Secret as soon as
      //      it's scheduled, so the Secret must exist before the
      //      Job is created.
      //   2. K8s garbage collection only deletes child resources
      //      when their owner is deleted, so the Secret needs an
      //      ownerReference pointing at the Job's UID.
      //   3. The Job UID is only known after createNamespacedJob
      //      returns, so the ownerReference must be patched in.
      //
      // This guarantees the cleartext STALWART_MASTER_SECRET +
      // user source password are removed by K8s GC whenever the
      // Job is deleted (TTL sweep, operator delete, reconciler
      // cleanup).
      await (k8s.core as unknown as {
        createNamespacedSecret: (args: { namespace: string; body: unknown }) => Promise<unknown>;
      }).createNamespacedSecret({ namespace: mailNamespace(), body: secret });

      const createdJob = await (k8s.batch as unknown as {
        createNamespacedJob: (args: { namespace: string; body: unknown }) => Promise<{
          metadata?: { uid?: string; name?: string };
        }>;
      }).createNamespacedJob({ namespace: mailNamespace(), body: job });

      const ownerJobName = createdJob.metadata?.name ?? `imapsync-${row.id}`;
      const ownerJobUid = createdJob.metadata?.uid;
      if (ownerJobUid) {
        // JSON Patch (RFC 6902) is the default content-type used
        // by @kubernetes/client-node for `patch*` calls. The body
        // is an array of operations.
        const patchOps = [
          {
            op: 'add',
            path: '/metadata/ownerReferences',
            value: [
              {
                apiVersion: 'batch/v1',
                kind: 'Job',
                name: ownerJobName,
                uid: ownerJobUid,
                controller: false,
                blockOwnerDeletion: false,
              },
            ],
          },
        ];
        try {
          await (k8s.core as unknown as {
            patchNamespacedSecret: (args: {
              name: string;
              namespace: string;
              body: unknown;
            }) => Promise<unknown>;
          }).patchNamespacedSecret({
            name: `imapsync-${row.id}`,
            namespace: mailNamespace(),
            body: patchOps,
          });
        } catch (patchErr) {
          // Non-fatal — the reconciler will still clean up the
          // Secret on terminal state OR on its own 404 path.
          app.log.warn(
            { err: patchErr, jobId: row.id },
            'mail-imapsync: failed to patch Secret with ownerReference (will rely on reconciler cleanup)',
          );
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await service.markFailed(app.db, row.id, `K8s create failed: ${msg}`);
      // Best-effort cleanup of any partial state. Both deletes
      // suppress 404 in case the resource was never created.
      try {
        await (k8s.batch as unknown as {
          deleteNamespacedJob: (args: { name: string; namespace: string; propagationPolicy?: string }) => Promise<void>;
        }).deleteNamespacedJob({
          name: `imapsync-${row.id}`,
          namespace: mailNamespace(),
          propagationPolicy: 'Background',
        });
      } catch { /* ignore */ }
      try {
        await (k8s.core as unknown as {
          deleteNamespacedSecret: (args: { name: string; namespace: string }) => Promise<void>;
        }).deleteNamespacedSecret({
          name: `imapsync-${row.id}`,
          namespace: mailNamespace(),
        });
      } catch { /* ignore */ }
      throw new ApiError(
        'IMAPSYNC_K8S_CREATE_FAILED',
        `Failed to create K8s Job: ${msg}`,
        500,
      );
    }

    await service.markRunning(app.db, row.id, `imapsync-${row.id}`);
    const updated = await service.getImapSyncJob(app.db, clientId, row.id);
    reply.status(201).send(success(updated));
  });

  // DELETE — cancel
  app.delete('/clients/:clientId/mail/imapsync/:jobId', {
    onRequest: [authenticate, requireRole('super_admin', 'admin', 'client_admin'), requireClientAccess()],
  }, async (request, reply) => {
    const { clientId, jobId } = request.params as { clientId: string; jobId: string };
    const row = await service.getImapSyncJob(app.db, clientId, jobId);
    if (!row) {
      throw new ApiError('IMAPSYNC_JOB_NOT_FOUND', 'IMAPSync job not found', 404);
    }
    if (row.status === 'succeeded' || row.status === 'failed' || row.status === 'cancelled') {
      throw new ApiError(
        'INVALID_STATE',
        `Job is already in terminal state '${row.status}'`,
        409,
      );
    }

    // Best-effort cleanup of the K8s Job + Secret. The reconciler
    // would eventually catch up if these calls fail, but doing them
    // synchronously gives the operator immediate feedback.
    if (k8s && row.k8sJobName) {
      try {
        await (k8s.batch as unknown as {
          deleteNamespacedJob: (args: { name: string; namespace: string; propagationPolicy?: string }) => Promise<void>;
        }).deleteNamespacedJob({
          name: row.k8sJobName,
          namespace: row.k8sNamespace,
          propagationPolicy: 'Background',
        });
      } catch (err) {
        app.log.warn({ err, jobId }, 'mail-imapsync: failed to delete K8s Job during cancel');
      }
      try {
        await (k8s.core as unknown as {
          deleteNamespacedSecret: (args: { name: string; namespace: string }) => Promise<void>;
        }).deleteNamespacedSecret({
          name: row.k8sJobName,
          namespace: row.k8sNamespace,
        });
      } catch (err) {
        app.log.warn({ err, jobId }, 'mail-imapsync: failed to delete K8s Secret during cancel');
      }
    }

    await service.markCancelled(app.db, jobId);
    void decrypt; // imported for symmetry; not used in this route
    reply.status(202).send(success({ id: jobId, status: 'cancelled' }));
  });

  // Round-4 Phase 1: DELETE — purge a TERMINAL job row from the DB.
  // The existing cancel endpoint (`DELETE /imapsync/:jobId`) returns
  // 409 if the job is already in a terminal state — this purge
  // endpoint does the inverse and only operates on terminal jobs.
  // Review HIGH-3 fix: deleteTerminalJob now returns the K8s
  // coordinates so we don't need a second SELECT here.
  app.delete('/clients/:clientId/mail/imapsync/:jobId/purge', {
    onRequest: [authenticate, requireRole('super_admin', 'admin', 'client_admin'), requireClientAccess()],
  }, async (request, reply) => {
    const { clientId, jobId } = request.params as { clientId: string; jobId: string };

    // deleteTerminalJob throws INVALID_STATE 409 for active rows
    // and returns null if the row doesn't exist for this client.
    const deleted = await service.deleteTerminalJob(app.db, clientId, jobId);
    if (!deleted) {
      throw new ApiError('IMAPSYNC_JOB_NOT_FOUND', 'IMAPSync job not found', 404);
    }

    // Best-effort cleanup of any K8s residue. The reconciler's own
    // 404 path normally handles this, but doing it inline gives
    // immediate feedback. Suppress 404s — the resources may already
    // be gone via ttlSecondsAfterFinished.
    if (k8s && deleted.k8sJobName) {
      try {
        await (k8s.batch as unknown as {
          deleteNamespacedJob: (args: { name: string; namespace: string; propagationPolicy?: string }) => Promise<void>;
        }).deleteNamespacedJob({
          name: deleted.k8sJobName,
          namespace: deleted.k8sNamespace,
          propagationPolicy: 'Background',
        });
      } catch (err) {
        const status = (err as { statusCode?: number })?.statusCode;
        if (status !== 404) {
          app.log.warn({ err, jobId }, 'mail-imapsync: failed to purge K8s Job');
        }
      }
      try {
        await (k8s.core as unknown as {
          deleteNamespacedSecret: (args: { name: string; namespace: string }) => Promise<void>;
        }).deleteNamespacedSecret({
          name: deleted.k8sJobName,
          namespace: deleted.k8sNamespace,
        });
      } catch (err) {
        const status = (err as { statusCode?: number })?.statusCode;
        if (status !== 404) {
          app.log.warn({ err, jobId }, 'mail-imapsync: failed to purge K8s Secret');
        }
      }
    }

    reply.status(204).send();
  });

  // Round-4 Phase 1: POST — re-sync a terminal job. Creates a NEW
  // pending row that copies the original source server, port,
  // username, encrypted password, ssl flag, and options. The new
  // row goes through the same K8s Job creation flow as create.
  app.post('/clients/:clientId/mail/imapsync/:jobId/resync', {
    onRequest: [authenticate, requireRole('super_admin', 'admin', 'client_admin'), requireClientAccess()],
  }, async (request, reply) => {
    const { clientId, jobId } = request.params as { clientId: string; jobId: string };

    if (!k8s) {
      throw new ApiError(
        'K8S_UNAVAILABLE',
        'Kubernetes client is not configured — IMAPSync disabled',
        503,
      );
    }

    let resolvedMasterSecret: string;
    let resolvedEncryptionKey: string;
    try {
      resolvedMasterSecret = masterSecret();
      resolvedEncryptionKey = encryptionKey();
    } catch (err) {
      throw new ApiError(
        'IMAPSYNC_NOT_CONFIGURED',
        err instanceof Error ? err.message : 'Server is missing required configuration',
        503,
      );
    }

    // 1. Replicate the row (concurrency check enforced by partial unique index).
    const newRow = await service.resyncImapSyncJob(app.db, clientId, jobId);

    // 2. Look up the destination mailbox address (still needed for SSO).
    const [mb] = await app.db
      .select({ fullAddress: mailboxes.fullAddress })
      .from(mailboxes)
      .where(eq(mailboxes.id, newRow.mailboxId));
    if (!mb) {
      await service.markFailed(app.db, newRow.id, 'Mailbox disappeared between resync and start');
      throw new ApiError('MAILBOX_NOT_FOUND', 'Mailbox not found', 404);
    }

    // 3. Decrypt the source password from the new row (which is a
    //    verbatim copy of the original encrypted blob) so we can
    //    pass cleartext to the K8s Secret.
    let sourcePasswordCleartext: string;
    try {
      sourcePasswordCleartext = decrypt(newRow.sourcePasswordEncrypted, resolvedEncryptionKey);
    } catch (err) {
      await service.markFailed(
        app.db,
        newRow.id,
        `Failed to decrypt stored source password: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new ApiError(
        'IMAPSYNC_PASSWORD_DECRYPT_FAILED',
        'Stored source password could not be decrypted (encryption key may have rotated)',
        500,
      );
    }

    // 4. Build + create the K8s Secret + Job. Same flow as create.
    const secret = service.buildJobSecret({
      jobId: newRow.id,
      namespace: mailNamespace(),
      sourcePassword: sourcePasswordCleartext,
      destPassword: resolvedMasterSecret,
    });
    const job = service.buildJobManifest({
      jobId: newRow.id,
      secretName: `imapsync-${newRow.id}`,
      namespace: mailNamespace(),
      mailboxAddress: mb.fullAddress,
      sourceHost: newRow.sourceHost,
      sourcePort: newRow.sourcePort,
      sourceUsername: newRow.sourceUsername,
      sourceSsl: newRow.sourceSsl === 1,
      destHost: stalwartImapHost(),
      destPort: stalwartImapPort(),
      options: (newRow.options ?? {}) as Record<string, unknown>,
      image: imapsyncImage(),
    });

    try {
      await (k8s.core as unknown as {
        createNamespacedSecret: (args: { namespace: string; body: unknown }) => Promise<unknown>;
      }).createNamespacedSecret({ namespace: mailNamespace(), body: secret });
      const createdJob = await (k8s.batch as unknown as {
        createNamespacedJob: (args: { namespace: string; body: unknown }) => Promise<{ metadata?: { uid?: string; name?: string } }>;
      }).createNamespacedJob({ namespace: mailNamespace(), body: job });

      const ownerJobName = createdJob.metadata?.name ?? `imapsync-${newRow.id}`;
      const ownerJobUid = createdJob.metadata?.uid;
      if (ownerJobUid) {
        try {
          await (k8s.core as unknown as {
            patchNamespacedSecret: (args: { name: string; namespace: string; body: unknown }) => Promise<unknown>;
          }).patchNamespacedSecret({
            name: `imapsync-${newRow.id}`,
            namespace: mailNamespace(),
            body: [
              {
                op: 'add',
                path: '/metadata/ownerReferences',
                value: [
                  {
                    apiVersion: 'batch/v1',
                    kind: 'Job',
                    name: ownerJobName,
                    uid: ownerJobUid,
                    controller: false,
                    blockOwnerDeletion: false,
                  },
                ],
              },
            ],
          });
        } catch (patchErr) {
          app.log.warn(
            { err: patchErr, jobId: newRow.id },
            'mail-imapsync: failed to patch resync Secret with ownerReference',
          );
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await service.markFailed(app.db, newRow.id, `K8s create failed: ${msg}`);
      // Best-effort cleanup
      try {
        await (k8s.batch as unknown as {
          deleteNamespacedJob: (args: { name: string; namespace: string; propagationPolicy?: string }) => Promise<void>;
        }).deleteNamespacedJob({
          name: `imapsync-${newRow.id}`,
          namespace: mailNamespace(),
          propagationPolicy: 'Background',
        });
      } catch { /* ignore */ }
      try {
        await (k8s.core as unknown as {
          deleteNamespacedSecret: (args: { name: string; namespace: string }) => Promise<void>;
        }).deleteNamespacedSecret({
          name: `imapsync-${newRow.id}`,
          namespace: mailNamespace(),
        });
      } catch { /* ignore */ }
      throw new ApiError(
        'IMAPSYNC_K8S_CREATE_FAILED',
        `Failed to create K8s Job: ${msg}`,
        500,
      );
    }

    await service.markRunning(app.db, newRow.id, `imapsync-${newRow.id}`);
    const updated = await service.getImapSyncJob(app.db, clientId, newRow.id);
    reply.status(201).send(success(updated));
  });
}
