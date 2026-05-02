/**
 * Internal upload endpoint — `POST /api/v1/internal/bundles/:bundleId
 * /components/:component/:artifactName?token=<>`.
 *
 * Receives a streaming PUT/POST from a tenant-namespace Job (e.g.
 * the files-component capture Job) and pipes the body straight into
 * BackupStore.writeComponent for the matching bundle. No buffering
 * on the platform-api side.
 *
 * Authentication: the `token` query param is an HMAC-signed string
 * bound to the (bundleId, component, artifactName) triple — see
 * upload-token.ts. Tokens expire 30 min after issuance.
 *
 * NO `authenticate` hook on this route — the HMAC token IS the
 * auth. We deliberately mount it under `/internal/` so a future
 * NetworkPolicy can restrict access to in-cluster pods only.
 *
 * Phase 3 scope: files component (archive.tar.gz + tree.jsonl.gz).
 * Phase 3+: when mailboxes lights up, this same endpoint accepts
 * mailbox uploads — the token's component+artifact binding restricts
 * what each Job can write.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
import { backupJobs, backupConfigurations } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { S3BackupStore } from './s3-backup-store.js';
import { SshBackupStore } from './ssh-backup-store.js';
import type { BackupStore } from './bundle-store.js';
import { decrypt } from '../oidc/crypto.js';
import { verifyUploadToken } from './upload-token.js';
import { success } from '../../shared/response.js';

const ALLOWED_COMPONENTS = new Set(['files', 'mailboxes', 'config', 'secrets'] as const);

export async function backupsV2InternalUploadRoutes(app: FastifyInstance): Promise<void> {
  const configuredKey = (app.config as Record<string, unknown>).OIDC_ENCRYPTION_KEY as string | undefined
    ?? process.env.OIDC_ENCRYPTION_KEY;
  if (!configuredKey && process.env.NODE_ENV === 'production') {
    // Hard-fail in production. The HMAC upload tokens are signed
    // with this key — falling back to all-zeros would let any
    // attacker who reads the source forge upload tokens. The
    // backups-v2 admin route emits a warn-log; this internal route
    // refuses to register at all.
    throw new Error('backupsV2InternalUploadRoutes: OIDC_ENCRYPTION_KEY is required in production');
  }
  const secretsKeyHex = configuredKey ?? '0'.repeat(64);

  // Disable Fastify's default body parser for this plugin scope —
  // we want the raw stream so we can pipe it straight to
  // BackupStore.writeComponent. Plugin-scoped: parsers registered
  // here are isolated from the parent app per Fastify's encapsulation
  // (verified against fastify@5 source: buildContentTypeParser does a
  // shallow copy into the child context).
  //
  // Also: the wildcard parser with `done(null)` skips Fastify's
  // rawBody buffering entirely, which means the global bodyLimit
  // does NOT apply to this route — the request stream is forwarded
  // straight through. This is intentional for files-component
  // archives that may be tens of GiB.
  app.addContentTypeParser('*', (_req, _payload, done) => done(null));

  // PUT, not POST — `curl --upload-file` (which the files-component
  // Job uses for streaming uploads from disk) defaults to HTTP PUT,
  // and the semantics here are "store at this exact path", which
  // PUT expresses correctly. Caught E2E 2026-05-02 when the Job
  // tried PUT and Fastify returned 404 because the registered
  // method was POST.
  app.put('/internal/bundles/:bundleId/components/:component/:artifactName', {
    schema: { tags: ['BackupsV2-Internal'], summary: 'Stream a component artifact upload from a tenant Job' },
  }, async (request, reply) => {
    const { bundleId, component, artifactName } = request.params as {
      bundleId: string;
      component: string;
      artifactName: string;
    };
    const token = (request.query as { token?: string }).token ?? '';

    // Argument-level validation BEFORE any DB or store work — keeps
    // probes (no token, bad token) from hitting the DB.
    if (!ALLOWED_COMPONENTS.has(component as 'files' | 'mailboxes' | 'config' | 'secrets')) {
      throw new ApiError('VALIDATION_ERROR', `unsupported component '${component}'`, 400);
    }
    // Only allow the canonical artifact filenames per BACKUP_COMPONENT_MODEL.md.
    // Reject path-separators + relative paths defensively.
    if (artifactName === '.' || artifactName === '..' || artifactName.includes('/') || !/^[A-Za-z0-9._@-]+$/.test(artifactName)) {
      throw new ApiError('VALIDATION_ERROR', `invalid artifactName '${artifactName}'`, 400);
    }
    if (!token) throw new ApiError('UNAUTHORIZED', 'missing upload token', 401);

    const verifyErr = verifyUploadToken(
      token,
      { bundleId, component: component as 'files' | 'mailboxes' | 'config' | 'secrets', artifactName },
      secretsKeyHex,
    );
    if (verifyErr) {
      // Server-side log carries the precise reason (MALFORMED /
      // EXPIRED / BAD_MAC) for ops debugging. The client-facing
      // 401 body is intentionally indistinguishable so a probing
      // attacker can't differentiate "wrong MAC" from "expired
      // token" via the response — which would narrow brute-force
      // windows.
      app.log.warn({ verifyErr, bundleId, component, artifactName }, 'backups-v2 internal upload: token rejected');
      throw new ApiError('UNAUTHORIZED', 'upload token invalid', 401);
    }

    // Resolve the bundle + its target. We trust the URL bundleId now
    // that the HMAC has bound the token to this exact bundle.
    const [job] = await app.db.select().from(backupJobs).where(eq(backupJobs.id, bundleId)).limit(1);
    if (!job) throw new ApiError('NOT_FOUND', 'Bundle not found', 404);
    if (!job.targetConfigId) {
      throw new ApiError('CONFIG_INVALID', 'Bundle has no target_config_id', 400);
    }

    const store = await resolveStoreForUpload(app, job.targetConfigId);
    const handle = await store.open(bundleId);
    if (!handle) throw new ApiError('NOT_FOUND', 'Bundle artefacts not yet reserved on remote target', 404);

    // Stream the body straight to writeComponent. Fastify's Node req
    // is the underlying http.IncomingMessage; we already disabled
    // body parsing above so this is the raw byte stream.
    const stream = streamFromRequest(request);
    const ref = await store.writeComponent(handle, component as 'files' | 'mailboxes' | 'config' | 'secrets', artifactName, stream, {
      contentType: request.headers['content-type'] as string | undefined,
    });

    return success({ bundleId, component, artifactName, sizeBytes: ref.sizeBytes });
  });
}

/**
 * Same pattern as resolveStore in routes.ts but does NOT enforce the
 * `active` flag — an in-progress upload for a now-deactivated target
 * must still be allowed to land its bytes. The activation gate
 * applies to NEW bundle creates (the user-facing route), not to
 * in-flight uploads.
 */
async function resolveStoreForUpload(app: FastifyInstance, targetConfigId: string): Promise<BackupStore> {
  const [cfg] = await app.db.select().from(backupConfigurations).where(eq(backupConfigurations.id, targetConfigId)).limit(1);
  if (!cfg) throw new ApiError('NOT_FOUND', 'Backup target not found', 404);

  const encKey = (app.config as Record<string, unknown>).OIDC_ENCRYPTION_KEY as string | undefined
    ?? process.env.OIDC_ENCRYPTION_KEY
    ?? '0'.repeat(64);

  if (cfg.storageType === 's3') {
    let accessKey = '';
    let secretKey = '';
    try {
      accessKey = cfg.s3AccessKeyEncrypted ? decrypt(cfg.s3AccessKeyEncrypted, encKey) : '';
      secretKey = cfg.s3SecretKeyEncrypted ? decrypt(cfg.s3SecretKeyEncrypted, encKey) : '';
    } catch (err) {
      app.log.error({ err, configId: cfg.id }, 'backups-v2 upload: S3 credential decryption failed');
      throw new ApiError('CONFIG_INVALID', 'S3 credential decryption failed', 500);
    }
    if (!accessKey || !secretKey) {
      throw new ApiError('CONFIG_INVALID', `Backup target ${cfg.id} has no S3 credentials configured`, 400);
    }
    return new S3BackupStore({
      bucket: cfg.s3Bucket ?? '',
      region: cfg.s3Region ?? 'us-east-1',
      endpoint: cfg.s3Endpoint ?? undefined,
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
      pathPrefix: cfg.s3Prefix ?? undefined,
    });
  }

  if (cfg.storageType === 'ssh') {
    if (!cfg.sshHost || !cfg.sshUser || !cfg.sshKeyEncrypted || !cfg.sshPath) {
      throw new ApiError('CONFIG_INVALID', `Backup target ${cfg.id} is missing SSH host/user/key/path`, 400);
    }
    let privateKey = '';
    try {
      privateKey = decrypt(cfg.sshKeyEncrypted, encKey);
    } catch (err) {
      app.log.error({ err, configId: cfg.id }, 'backups-v2 upload: SSH key decryption failed');
      throw new ApiError('CONFIG_INVALID', 'SSH key decryption failed', 500);
    }
    return new SshBackupStore({
      host: cfg.sshHost,
      port: cfg.sshPort ?? 22,
      user: cfg.sshUser,
      privateKey,
      basePath: cfg.sshPath,
      logFn: (level, ctx, msg) => app.log[level](ctx, msg),
    });
  }

  throw new ApiError('NOT_IMPLEMENTED', `Backup store kind '${cfg.storageType}' is not supported`, 501);
}

function streamFromRequest(request: FastifyRequest): Readable {
  // Fastify's `request.raw` exposes the underlying Node IncomingMessage,
  // which extends Readable. Cast through unknown to satisfy the
  // BackupStore.writeComponent signature without dragging in the
  // node:http types.
  return request.raw as unknown as Readable;
}
