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
import { backupJobs, backupConfigurations, clients, tenantBackupV2Settings } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { S3BackupStore } from './s3-backup-store.js';
import { SshBackupStore } from './ssh-backup-store.js';
import type { BackupStore } from './bundle-store.js';
import { decrypt } from '../oidc/crypto.js';
import { resolveBaseDomain } from '../../config/domains.js';
import { verifyUploadToken } from './upload-token.js';
import { success } from '../../shared/response.js';
import { resolveBackupTarget } from './resolve-backup-target.js';
import {
  buildSnapshotTags,
  deriveResticPassword,
  deriveRegionId,
  runResticBackup,
  type ResticComponent,
} from './restic-driver.js';

const ALLOWED_COMPONENTS = new Set(['files', 'mailboxes', 'config', 'secrets'] as const);
const RESTIC_COMPONENTS: ReadonlySet<ResticComponent> = new Set(['files', 'mailboxes']);
// Canonical artifact name bound into the HMAC token for the restic
// streaming endpoint. There is no individual file being uploaded —
// the entire request body is piped into `restic backup --stdin`. This
// fixed string keeps the upload-token shape unchanged from the
// non-restic path.
const RESTIC_STREAM_ARTIFACT = 'restic-stream';
const ALLOWED_STDIN_FILENAMES = /^[A-Za-z0-9._-]{1,64}$/;

export async function backupsV2InternalUploadRoutes(app: FastifyInstance): Promise<void> {
  const configuredKey = (app.config as Record<string, unknown>).OIDC_ENCRYPTION_KEY as string | undefined
    ?? process.env.OIDC_ENCRYPTION_KEY;
  if (!configuredKey && process.env.NODE_ENV === 'production') {
    // Hard-fail in production. The HMAC upload tokens are signed
    // with this key — falling back to all-zeros would let any
    // attacker who reads the source forge upload tokens. The
    // tenant-bundles admin route emits a warn-log; this internal route
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
    schema: { tags: ['TenantBundles-Internal'], summary: 'Stream a component artifact upload from a tenant Job' },
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
      app.log.warn({ verifyErr, bundleId, component, artifactName }, 'tenant-bundles internal upload: token rejected');
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

  // ─── Restic streaming endpoint (Phase 1, ADR-036) ─────────────────────
  //
  // The tenant Job tars the captured tree (PVC contents + pre-dumped DB
  // SQL files for files-component, or the JMAP-built Maildir tree for
  // mailboxes-component) and uploads it via `curl --upload-file -` to
  // this endpoint. The body is piped straight into `restic backup
  // --stdin` running in this process; the snapshot id is parsed from
  // restic's --json summary line and returned to the Job.
  //
  // Trust boundary: tenant Job has tenant data + an HMAC upload token
  // BUT NO BACKEND CREDS. Backend creds (S3 access key, SSH private
  // key) materialise only here, decrypted from backup_configurations.
  // The per-tenant restic password is derived from
  // OIDC_ENCRYPTION_KEY + clientId via HKDF-SHA256 — the same vector
  // asserted in restic-driver.test.ts and the Phase 0 spike.
  app.put('/internal/bundles/:bundleId/components/:component/restic-stream', {
    schema: {
      tags: ['TenantBundles-Internal'],
      summary: 'Stream a tarball into per-tenant restic repo (no intermediate file)',
    },
  }, async (request, reply) => {
    const { bundleId, component } = request.params as {
      bundleId: string;
      component: string;
    };
    const query = request.query as { token?: string; filename?: string };
    const token = query.token ?? '';
    const stdinFilename = query.filename ?? 'archive.tar';

    // Validate before touching the DB so probes (no token) don't burn cycles.
    if (!RESTIC_COMPONENTS.has(component as ResticComponent)) {
      throw new ApiError(
        'VALIDATION_ERROR',
        `restic stream not supported for component '${component}' (only 'files' and 'mailboxes')`,
        400,
      );
    }
    if (!ALLOWED_STDIN_FILENAMES.test(stdinFilename)) {
      throw new ApiError(
        'VALIDATION_ERROR',
        `invalid filename '${stdinFilename}' (must match ${ALLOWED_STDIN_FILENAMES.source})`,
        400,
      );
    }
    if (!token) throw new ApiError('UNAUTHORIZED', 'missing upload token', 401);

    // Token binds (bundleId, component, RESTIC_STREAM_ARTIFACT) — a
    // file-upload token cannot be replayed for the restic stream and
    // vice versa. Server-side log carries the rejection reason; client
    // body is generic per the same rationale as the file-upload route.
    const verifyErr = verifyUploadToken(
      token,
      { bundleId, component: component as ResticComponent, artifactName: RESTIC_STREAM_ARTIFACT },
      secretsKeyHex,
    );
    if (verifyErr) {
      app.log.warn({ verifyErr, bundleId, component }, 'tenant-bundles restic-stream: token rejected');
      throw new ApiError('UNAUTHORIZED', 'upload token invalid', 401);
    }

    const [job] = await app.db.select().from(backupJobs).where(eq(backupJobs.id, bundleId)).limit(1);
    if (!job) throw new ApiError('NOT_FOUND', 'Bundle not found', 404);
    if (!job.targetConfigId) {
      throw new ApiError('CONFIG_INVALID', 'Bundle has no target_config_id', 400);
    }

    const [cfg] = await app.db
      .select()
      .from(backupConfigurations)
      .where(eq(backupConfigurations.id, job.targetConfigId))
      .limit(1);
    if (!cfg) throw new ApiError('NOT_FOUND', 'Backup target not found', 404);

    const target = resolveBackupTarget(
      // hostpathPath isn't on the existing backup_configurations row
      // shape; pass undefined so the resolver throws CONFIG_INVALID
      // for hostpath until it's added (test backends use S3/SSH).
      {
        ...cfg,
        hostpathPath: (cfg as Record<string, unknown>).hostpathPath as string | null | undefined ?? null,
      },
      { secretsKeyHex },
    );

    // Per-tenant HKDF password — pinned by Phase 0 lock vector.
    const password = deriveResticPassword(secretsKeyHex, job.clientId);

    // Snapshot tags carry the full metadata Region B needs to identify
    // and restore this snapshot from outside (ADR-036 multi-region).
    const [client] = await app.db.select().from(clients).where(eq(clients.id, job.clientId)).limit(1);
    if (!client) throw new ApiError('NOT_FOUND', 'Bundle client missing', 404);
    const [settings] = await app.db.select().from(tenantBackupV2Settings).limit(1);
    const regionOverride = settings?.regionIdOverride ?? '';
    const apex = resolveBaseDomain({
      PLATFORM_BASE_DOMAIN: app.config.PLATFORM_BASE_DOMAIN,
      INGRESS_BASE_DOMAIN: app.config.INGRESS_BASE_DOMAIN,
    });
    const regionId = deriveRegionId(apex, regionOverride);
    const platformVersion = app.config.PLATFORM_VERSION;
    const tags = buildSnapshotTags({
      bundleId,
      clientId: job.clientId,
      tenantSlug: client.kubernetesNamespace,
      component: component as ResticComponent,
      regionId,
      platformVersion,
    });

    // Phase 1 piece #11 — abort the spawned restic when the inbound
    // HTTP request is cancelled (tenant Job crash, NIC reset, client
    // disconnect). Without this, the spawn loiters on stdin forever
    // and accumulating zombies OOM-kill the pod (staging 2026-05-11
    // showed 5 stuck "running" backup_jobs producing that exact
    // pattern). The signal is also fired on response close in case
    // Fastify itself drops the connection mid-stream.
    const abortController = new AbortController();
    const onClientGone = () => abortController.abort();
    request.raw.on('aborted', onClientGone);
    request.raw.on('close', () => {
      // 'close' fires on both successful end + connection abort. We
      // only treat it as an abort if we have NOT yet handed control
      // back to the success branch below — runResticBackup() will
      // have returned and abortController.abort() at that point is a
      // no-op.
      if (!request.raw.readableEnded) onClientGone();
    });

    let result;
    try {
      result = await runResticBackup({
        target,
        clientId: job.clientId,
        component: component as ResticComponent,
        passwordHex: password,
        stdinFilename,
        tags,
        stdin: request.raw as unknown as Readable,
        abortSignal: abortController.signal,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const aborted = msg.includes('aborted (HTTP request cancelled)');
      app.log[aborted ? 'warn' : 'error'](
        { err, bundleId, component, clientId: job.clientId, aborted },
        aborted
          ? 'tenant-bundles restic-stream: aborted by client disconnect'
          : 'tenant-bundles restic-stream: restic backup failed',
      );
      if (aborted) {
        // 499 Client Closed Request — body is informational only since
        // the client is already gone. The orchestrator's component
        // wait-for-Job path will see the Job pod's curl exit non-zero
        // and mark the component failed independently.
        return reply.code(499).send({ error: { code: 'CLIENT_ABORTED', message: msg } });
      }
      throw new ApiError('RESTIC_BACKUP_FAILED', msg, 500);
    } finally {
      request.raw.off('aborted', onClientGone);
    }

    return success({
      bundleId,
      component,
      snapshotId: result.snapshotId,
      sizeBytes: result.totalBytesProcessed,
      fileCount: result.totalFilesProcessed,
      regionId,
      tags,
    });
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
      app.log.error({ err, configId: cfg.id }, 'tenant-bundles upload: S3 credential decryption failed');
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
      app.log.error({ err, configId: cfg.id }, 'tenant-bundles upload: SSH key decryption failed');
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
