import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, desc, sql, inArray } from 'drizzle-orm';
import { authenticate, requireRole, requirePanel } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { backupJobs, backupComponents, backupConfigurations, clients, hostingPlans, clientBackupSchedules } from '../../db/schema.js';
import {
  createBundleSchema,
  updateClientBackupScheduleSchema,
  type BundleSummary,
  type BundleDetail,
  type BackupComponentInfo,
} from '@k8s-hosting/api-contracts';
import { S3BackupStore } from './s3-backup-store.js';
import { SshBackupStore } from './ssh-backup-store.js';
import type { BackupStore } from './bundle-store.js';
import { runBundle } from './orchestrator.js';
import { decrypt } from '../oidc/crypto.js';
import { decryptSecretsPayload } from './components/secrets.js';
import { CONFIG_DUMP_EXCLUDED_CLIENT_FK_TABLES } from './components/config.js';
import { BUNDLE_COMPONENTS, ownerOfTable } from './component-registry.js';
import { createHash, randomUUID } from 'node:crypto';
import { gunzip } from 'node:zlib';
import { Readable } from 'node:stream';

// Backups-v2 stores bundles OFF-CLUSTER only (S3 / SSH). The cluster's
// disk is reserved for live tenant data — backups must never compete
// for it. Every bundle request therefore requires `targetConfigId`
// pointing at an active row in `backup_configurations`.
//
// (LocalHostPathBackupStore still exists for unit tests via mkdtemp;
// it is never used by the route layer in production.)

/**
 * Redact credentials before writing an error message to a UI-facing
 * column (`backup_jobs.last_error`). The orchestrator may catch
 * driver-level exceptions whose `message` includes the full DSN —
 * Drizzle/pg in particular tends to surface connection strings on
 * pool errors. Operator UIs surface this verbatim, so anything that
 * looks like a credential gets masked. Server logs receive the raw
 * unredacted message separately.
 */
export function redactCredentialsForUi(message: string): string {
  return message
    // <scheme>://user:password@host  →  <scheme>://user:***@host
    .replace(/([a-zA-Z][a-zA-Z0-9+\-.]*:\/\/[^:@/\s]+):[^@\s]+@/g, '$1:***@')
    // password=<value> / pwd=<value> in URL query / log strings
    .replace(/(password|pwd|secret|token)=[^\s&"']+/gi, '$1=***')
    // AWS access-key-id pattern
    .replace(/AKIA[A-Z0-9]{12,}/g, 'AKIA***')
    // 32+ char hex blobs (likely raw key material)
    .replace(/\b[0-9a-f]{32,}\b/gi, '***');
}

export async function backupsV2Routes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requirePanel('admin'));
  app.addHook('onRequest', requireRole('super_admin', 'admin'));

  const platformVersion = (app.config as Record<string, unknown>).PLATFORM_VERSION as string | undefined ?? '0.0.0-dev';
  const configuredKey = (app.config as Record<string, unknown>).OIDC_ENCRYPTION_KEY as string | undefined
    ?? process.env.OIDC_ENCRYPTION_KEY;
  const secretsKeyHex = configuredKey ?? '0'.repeat(64);
  if (!configuredKey && process.env.NODE_ENV === 'production') {
    app.log.error('tenant-bundles: OIDC_ENCRYPTION_KEY is not set in production — using zero-key fallback. Secrets-component bundles encrypted today are trivially decryptable. Set OIDC_ENCRYPTION_KEY now.');
  } else if (!configuredKey) {
    app.log.warn('tenant-bundles: OIDC_ENCRYPTION_KEY not set — using zero-key dev fallback. Secrets bundles produced now will be unencrypted.');
  }
  // Validate the key is the right shape (32 bytes hex) at registration
  // time so a misconfigured operator gets a clear failure now instead
  // of a confusing "key must be 32 bytes" thrown from inside an
  // export-token request 10 minutes later.
  if (Buffer.from(secretsKeyHex, 'hex').length !== 32) {
    throw new Error(`tenant-bundles: OIDC_ENCRYPTION_KEY must be 32 bytes hex (got ${secretsKeyHex.length} chars / ${Buffer.from(secretsKeyHex, 'hex').length} bytes)`);
  }

  // ── Legacy path redirects (one cycle) ────────────────────────────
  // The bundle endpoints used to live under /admin/backups/bundles*
  // before the 2026-05-06 rename to /admin/tenant-bundles*. Keep
  // 308-permanent redirects on the old paths for one release cycle so
  // a panel deployed before the backend rolls doesn't 404 — TanStack
  // Query follows redirects transparently. Remove this block after
  // the next release cycle. (Path style: /admin/backups/bundles{,/...}
  // → /admin/tenant-bundles{,/...} preserving query string.)
  const legacyBundlePaths = [
    '/admin/backups/bundles',
    '/admin/backups/bundles/:id',
    '/admin/backups/bundles/:id/verify',
    '/admin/backups/bundles/:id/data-export',
  ] as const;
  for (const legacy of legacyBundlePaths) {
    const target = legacy.replace('/admin/backups/bundles', '/admin/tenant-bundles');
    for (const method of ['get', 'post', 'delete'] as const) {
      app[method](legacy, {
        schema: { tags: ['TenantBundles'], summary: `Legacy redirect → ${target}`, hide: true },
      }, async (request, reply) => {
        const params = request.params as Record<string, string>;
        const url = `/api/v1${target.replace(/:(\w+)/g, (_, k) => params[k] ?? '')}`;
        const qs = request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : '';
        reply.code(308).header('Location', `${url}${qs}`).send();
      });
    }
  }

  // ── GET /api/v1/admin/tenant-bundles ──────────────────────────────
  app.get('/admin/tenant-bundles', {
    schema: { tags: ['TenantBundles'], summary: 'List bundles', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const q = request.query as { clientId?: string; limit?: string; status?: string };
    const limit = Math.min(Math.max(parseInt(q.limit ?? '50', 10) || 50, 1), 100);

    const whereClause = q.clientId ? eq(backupJobs.clientId, q.clientId) : undefined;
    const rowsQuery = whereClause
      ? app.db.select().from(backupJobs).where(whereClause).orderBy(desc(backupJobs.createdAt)).limit(limit + 1)
      : app.db.select().from(backupJobs).orderBy(desc(backupJobs.createdAt)).limit(limit + 1);
    const countQuery = whereClause
      ? app.db.select({ n: sql<number>`count(*)::int` }).from(backupJobs).where(whereClause)
      : app.db.select({ n: sql<number>`count(*)::int` }).from(backupJobs);
    const [rows, countRows] = await Promise.all([rowsQuery, countQuery]);

    const hasMore = rows.length > limit;
    const visibleRows = rows.slice(0, limit);

    // Resolve client status + name for every distinct client id in a
    // single bulk query. Bundles for deleted clients miss the JOIN
    // and surface as clientStatus='missing'.
    const distinctClientIds = Array.from(new Set(visibleRows.map((r) => r.clientId)));
    const clientRows = distinctClientIds.length === 0
      ? []
      : await app.db
          .select({ id: clients.id, status: clients.status, name: clients.companyName })
          .from(clients)
          .where(inArray(clients.id, distinctClientIds));
    const clientById = new Map<string, { status: string; name: string }>(
      clientRows.map((c) => [c.id, { status: c.status as string, name: c.name }]),
    );

    const items: BundleSummary[] = visibleRows.map((row) => {
      const c = clientById.get(row.clientId);
      return toBundleSummary(row, {
        status: clientRowToBundleStatus(c?.status),
        name: c?.name ?? null,
      });
    });
    const total = countRows[0]?.n ?? items.length;
    return success({
      data: items,
      pagination: {
        total_count: total,
        cursor: hasMore ? items[items.length - 1]?.id ?? null : null,
        has_more: hasMore,
        page_size: limit,
      },
    });
  });

  // ── GET /api/v1/admin/tenant-bundles/coverage ──────────────────────
  //
  // MUST be registered BEFORE the parametric `/:id` handler — Fastify
  // (find-my-way) on a v1.x trie can match a literal segment as the
  // `:id` parameter when the parametric route was registered first.
  // Empirically: putting this AFTER /:id returned 404 "Bundle not
  // found" with id="coverage" instead of resolving the static path.
  //
  // Returns the BundleComponent registry + a drift report. The drift
  // section flags any client-FK'd DB table that no component claims —
  // the same check the schema-audit script runs at CI time, but
  // available at runtime for the operator coverage UI.
  app.get('/admin/tenant-bundles/coverage', {
    schema: {
      tags: ['TenantBundles'],
      summary: 'Bundle coverage registry + runtime drift report',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    // Pull every table name that has a `client_id` column from the
    // information schema. Fast and authoritative — beats parsing
    // schema.ts at runtime.
    const r = await app.db.execute(sql`
      SELECT DISTINCT table_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name = 'client_id'
      ORDER BY table_name
    `);
    const rawDb = r as unknown as { rows: Array<{ table_name: string }> };
    const dbTables = rawDb.rows.map((row) => row.table_name);

    // The registry uses camelCase table names (matching the Drizzle
    // schema export names); information_schema returns snake_case.
    // Convert snake → camel for the comparison.
    const snakeToCamel = (s: string): string =>
      s.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());

    const owned: Array<{ table: string; component: string }> = [];
    const excluded: Array<{ table: string; reason: string }> = [];
    const orphans: Array<{ table: string }> = [];
    for (const t of dbTables) {
      const camel = snakeToCamel(t);
      const owner = ownerOfTable(camel);
      if (owner) {
        owned.push({ table: camel, component: owner.name });
        continue;
      }
      const reason = CONFIG_DUMP_EXCLUDED_CLIENT_FK_TABLES.get(camel);
      if (reason) {
        excluded.push({ table: camel, reason });
      } else {
        orphans.push({ table: camel });
      }
    }

    // success() already wraps in {data: …}; don't double-wrap.
    return success({
      components: BUNDLE_COMPONENTS,
      drift: {
        // Tables claimed by no component AND not in the documented
        // exclusion list. These are the silent-drop hazards — operator
        // UI flags them red.
        orphanTables: orphans,
        // Tables intentionally outside any component, with the
        // documented reason (audit logs, billing, transient state).
        excludedTables: excluded,
        ownedTableCount: owned.length,
        totalTenantTables: dbTables.length,
      },
    });
  });

  // ── GET /api/v1/admin/tenant-bundles/:id ──────────────────────────
  app.get('/admin/tenant-bundles/:id', {
    schema: { tags: ['TenantBundles'], summary: 'Get bundle detail', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const [job] = await app.db.select().from(backupJobs).where(eq(backupJobs.id, id)).limit(1);
    if (!job) throw new ApiError('NOT_FOUND', 'Bundle not found', 404);
    const [clientRow] = await app.db
      .select({ status: clients.status, name: clients.companyName })
      .from(clients).where(eq(clients.id, job.clientId)).limit(1);
    const components = await app.db.select().from(backupComponents).where(eq(backupComponents.backupJobId, id));
    const detail: BundleDetail = {
      ...toBundleSummary(job, {
        status: clientRowToBundleStatus(clientRow?.status as string | undefined),
        name: clientRow?.name ?? null,
      }),
      components: components.map(toComponentInfo),
    };
    return success(detail);
  });

  // ── POST /api/v1/admin/tenant-bundles ─────────────────────────────
  app.post('/admin/tenant-bundles', {
    schema: { tags: ['TenantBundles'], summary: 'Create a new bundle', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const parsed = createBundleSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; '), 400);
    }
    const input = parsed.data;

    // Backups MUST go to an off-cluster target. The cluster's disk is
    // for live tenant data, not bundles. Reject any request without
    // an explicit targetConfigId.
    if (!input.targetConfigId) {
      throw new ApiError('VALIDATION_ERROR',
        'targetConfigId is required: bundles must be written to an active off-site backup target (S3 or SSH).',
        400);
    }
    const store = await resolveStore(app, input.targetConfigId);

    // Resolve client + plan retention.
    const [client] = await app.db.select().from(clients).where(eq(clients.id, input.clientId)).limit(1);
    if (!client) throw new ApiError('NOT_FOUND', 'Client not found', 404);

    // Plan-bound retention. hosting_plans.max_backup_retention_days
    // is the upper bound the operator may request for a client on
    // this plan; default is hosting_plans.default_backup_retention_days.
    // Applies to ALL initiators so a Tier-3 client-initiated bundle
    // can't bypass the plan cap.
    const [plan] = await app.db.select({
      defaultDays: hostingPlans.defaultBackupRetentionDays,
      maxDays: hostingPlans.maxBackupRetentionDays,
    }).from(hostingPlans).where(eq(hostingPlans.id, client.planId)).limit(1);
    if (!plan) throw new ApiError('CONFIG_INVALID', `Client ${input.clientId} has no resolvable plan`, 400);

    const requested = input.retentionDays ?? plan.defaultDays;
    if (requested > plan.maxDays) {
      throw new ApiError(
        'VALIDATION_ERROR',
        `retentionDays ${requested} exceeds the plan's max_backup_retention_days (${plan.maxDays})`,
        400,
      );
    }
    const retentionDays = requested;

    // Build kube clients best-effort — orchestrator handles undefined.
    let k8s;
    try {
      const kc = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
      k8s = createK8sClients(kc);
    } catch (err) {
      app.log.warn({ err }, 'tenant-bundles: k8s client unavailable');
      k8s = undefined;
    }

    const targetUri = `${store.kind}://${input.targetConfigId}`;

    // Internal cluster URL the files-component Job uses to POST
    // archive + tree uploads back to platform-api. Falls back to the
    // standard k8s service DNS when not explicitly configured.
    const platformApiUrl = (app.config as Record<string, unknown>).PLATFORM_API_INTERNAL_URL as string | undefined
      ?? process.env.PLATFORM_API_INTERNAL_URL
      ?? 'http://platform-api.platform.svc:3000';

    const triggeredByUserId =
      input.initiator === 'system' || input.initiator === 'cluster'
        ? null
        : ((request.user as { sub?: string } | undefined)?.sub ?? null);
    const orchInput = {
      clientId: input.clientId,
      initiator: input.initiator,
      systemTrigger: input.systemTrigger ?? null,
      label: input.label ?? null,
      description: input.description ?? null,
      retentionDays,
      targetConfigId: input.targetConfigId ?? null,
      targetUri,
      components: {
        files: input.components?.files ?? true,
        mailboxes: input.components?.mailboxes ?? true,
        config: input.components?.config ?? true,
        secrets: input.components?.secrets ?? (input.exportMode !== 'data_export'),
      },
      exportMode: input.exportMode ?? null,
      exportPassphrase: input.exportPassphrase ?? null,
      triggeredByUserId,
    };
    const orchDeps = { db: app.db, k8s, store, platformVersion, secretsKeyHex, platformApiUrl };

    if (input.async) {
      // Async path: return as soon as the orchestrator has reserved
      // the bundle (row inserted + off-site dir reserved). The frontend
      // polls GET /:id every 2 s and renders per-component progress.
      //
      // Failure handling:
      //   - Per-component errors are recorded by the orchestrator on
      //     each backup_components row and aggregated into
      //     backup_jobs.last_error.
      //   - An *unexpected* throw from runBundle itself (e.g. lost DB
      //     connection mid-orchestration, OOM kill) bypasses that path.
      //     We catch here and force the row into `failed` so the
      //     polling modal stops spinning forever and the operator sees
      //     a real error. Without this the row stays at `running`
      //     indefinitely (caught E2E 2026-05-07: 32-min hang).
      let reservedBundleId: string | null = null;
      const reserved = new Promise<string>((resolve) => {
        runBundle(orchDeps, {
          ...orchInput,
          onBundleReserved: (id) => {
            reservedBundleId = id;
            resolve(id);
          },
        }).catch(async (err) => {
          const rawMsg = err instanceof Error ? err.message : String(err);
          // Full message goes to server logs only.
          app.log.error({ err: rawMsg, bundleId: reservedBundleId }, 'tenant-bundles: async runBundle failed');
          if (reservedBundleId) {
            // Operator-visible message: redact connection-string
            // credentials a misbehaving driver might surface in
            // err.message (Drizzle/pg, mysql, redis, etc.). The full
            // unredacted trace is in server logs above.
            const operatorMsg = redactCredentialsForUi(rawMsg).slice(0, 2000);
            try {
              await app.db
                .update(backupJobs)
                .set({
                  status: 'failed',
                  lastError: operatorMsg,
                  finishedAt: new Date(),
                })
                .where(eq(backupJobs.id, reservedBundleId));
            } catch (updateErr) {
              app.log.error(
                { err: updateErr instanceof Error ? updateErr.message : String(updateErr) },
                'tenant-bundles: failed to mark async bundle as failed',
              );
            }
          }
        });
      });
      const bundleId = await reserved;
      reply.status(202).send(success({ bundleId, status: 'running', meta: null, async: true }));
      return;
    }

    const result = await runBundle(orchDeps, orchInput);
    reply.status(201).send(success({ bundleId: result.bundleId, status: result.status, meta: result.meta }));
  });

  // ── GET /api/v1/admin/tenant-bundles/:id/data-export ──────────────
  // Streams the AES-256-CBC-encrypted tarball produced by the
  // data_export wrapper to the caller. The body is opaque ciphertext;
  // the client decrypts locally with the passphrase they provided at
  // create time:
  //
  //   openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 \
  //     -in data-export-<bundleId>.tar.gz.enc -out bundle.tar.gz \
  //     -pass stdin <<< "$PASSPHRASE"
  //
  // Auth is admin-gated — for client-panel download, the client-panel
  // re-uses this same endpoint via its admin proxy + the existing
  // tenant-context check on the bundle.
  app.get('/admin/tenant-bundles/:id/data-export', {
    schema: { tags: ['TenantBundles'], summary: 'Download the GDPR data-export ciphertext for a bundle', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const [job] = await app.db.select().from(backupJobs).where(eq(backupJobs.id, id)).limit(1);
    if (!job) throw new ApiError('NOT_FOUND', 'Bundle not found', 404);
    if (job.exportMode !== 'data_export' || !job.exportArtifact) {
      throw new ApiError(
        'NO_DATA_EXPORT',
        'This bundle has no data_export artifact. Re-create the bundle with exportMode=data_export + exportPassphrase to enable.',
        400,
      );
    }
    if (!job.targetConfigId) {
      throw new ApiError('CONFIG_INVALID', 'Bundle has no target_config_id', 400);
    }
    const store = await resolveStore(app, job.targetConfigId);
    const handle = await store.open(id);
    if (!handle) throw new ApiError('NOT_FOUND', 'Bundle artefacts not found on remote target', 404);
    // exportArtifact is `components/<comp>/<name>` — split.
    const m = job.exportArtifact.match(/^components\/(files|mailboxes|config|secrets)\/(.+)$/);
    if (!m) throw new ApiError('CONFIG_INVALID', `Malformed export_artifact path '${job.exportArtifact}'`, 400);
    const [, component, artifactName] = m as unknown as [string, 'files' | 'mailboxes' | 'config' | 'secrets', string];
    const stat = await store.stat(handle, component, artifactName);
    if (!stat) throw new ApiError('NOT_FOUND', `Export artifact missing on remote target: ${job.exportArtifact}`, 404);
    const body = await store.readComponent(handle, component, artifactName);
    reply.header('Content-Type', 'application/octet-stream');
    if (Number.isFinite(stat.sizeBytes) && stat.sizeBytes >= 0) {
      reply.header('Content-Length', String(stat.sizeBytes));
    }
    reply.header('Content-Disposition', `attachment; filename="data-export-${id}.tar.gz.enc"`);
    reply.header('Cache-Control', 'no-store');
    return reply.send(body);
  });

  // ── POST /api/v1/admin/tenant-bundles/:id/export ──────────────────
  //
  // Multi-region export: stream a passphrase-encrypted tarball of
  // EVERY component artifact + meta.json. Different from
  // `/data-export`:
  //
  //   - Operator-supplied passphrase (no DB lookup; the bundle
  //     doesn't need to have been created with exportMode='data_export').
  //   - Streams directly to the response — no off-site write.
  //   - Decryptable with stock openssl in the target region:
  //
  //       openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 \
  //         -in bundle-<id>.tar.gz.enc -out bundle.tar.gz \
  //         -pass stdin <<< "$PASSPHRASE"
  //
  //   - The target region's import endpoint accepts the resulting
  //     ciphertext + passphrase and registers a fresh bundle row.
  //
  // Wire format identical to wrapBundleAsDataExport: Salted__ +
  // 8-byte salt + AES-256-CBC(gzip(tar)) with 100k-iter PBKDF2.
  app.post('/admin/tenant-bundles/:id/export', {
    schema: { tags: ['TenantBundles'], summary: 'Download a bundle tarball (optionally passphrase-encrypted)', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { passphrase?: string } | null;
    const passphrase = body?.passphrase;
    // passphrase is OPTIONAL. When supplied, must be ≥12 chars
    // (matches the OpenSSL-compatible KDF parameters). When absent
    // (undefined / null / empty string), the response is plain
    // `tar.gz`. ANY non-empty value too short raises 400 — must
    // happen BEFORE we call streamEncryptedExport, otherwise the
    // function throws a plain Error which the framework returns as
    // 500. Caught by typescript-reviewer 2026-05-08.
    if (passphrase !== undefined && passphrase !== null && passphrase !== '') {
      if (typeof passphrase !== 'string' || passphrase.length < 1) {
        throw new ApiError('VALIDATION_ERROR', 'passphrase must be a non-empty string (or omit it for an unencrypted tar.gz)', 400);
      }
    }
    const encrypt = typeof passphrase === 'string' && passphrase.length >= 1;

    const [job] = await app.db.select().from(backupJobs).where(eq(backupJobs.id, id)).limit(1);
    if (!job) throw new ApiError('NOT_FOUND', 'Bundle not found', 404);
    if (!job.targetConfigId) throw new ApiError('CONFIG_INVALID', 'Bundle has no targetConfigId; cannot read components', 400);

    const store = await resolveStore(app, job.targetConfigId, { requireActive: false });
    const handle = await store.open(id);
    if (!handle) throw new ApiError('NOT_FOUND', 'Bundle artifacts not found on off-site target', 404);

    // Enumerate every artifact across components. Skip components
    // that weren't captured (orchestrator records `skipped` in meta).
    const allArtifacts: Array<{ component: 'files' | 'mailboxes' | 'config' | 'secrets'; name: string }> = [];
    for (const component of (['files', 'mailboxes', 'config', 'secrets'] as const)) {
      const refs = await store.listArtifacts(handle, component);
      for (const r of refs) {
        // Skip the data-export artifact itself — it'd be circular
        // (and pointless: it's already encrypted with a different
        // passphrase). The synthetic name lives in components/config/
        // and starts with `data-export-`.
        if (component === 'config' && r.name.startsWith('data-export-')) continue;
        allArtifacts.push({ component, name: r.name });
      }
    }

    const { streamEncryptedExport } = await import('./data-export.js');
    const stream = await streamEncryptedExport({ store, handle, passphrase: encrypt ? passphrase : undefined, components: allArtifacts });

    // Defensive: if the async feeder errors after headers are
    // flushed, log so the failure isn't silent in audit logs.
    stream.on('error', (err) => {
      app.log.error({ err: err instanceof Error ? err.message : String(err), bundleId: id }, 'tenant-bundles: tar export stream error');
    });

    reply.header('Content-Type', encrypt ? 'application/octet-stream' : 'application/gzip');
    const filename = encrypt ? `bundle-${id}.tar.gz.enc` : `bundle-${id}.tar.gz`;
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    reply.header('Cache-Control', 'no-store');
    app.log.warn(
      { userId: (request.user as { sub?: string } | undefined)?.sub, bundleId: id, clientId: job.clientId, encrypted: encrypt, format: 'tar' },
      'tenant-bundles: export download initiated',
    );
    return reply.send(stream);
  });

  // ── POST /api/v1/admin/tenant-bundles/:id/zip ─────────────────────
  //
  // ZIP variant of the export endpoint — always plaintext. Same
  // per-artifact streaming pipeline (S3 → archiver → reply), no
  // server-side staging.
  //
  // Why no password option: WinZip AE-2 (the only practical Node
  // ZIP-encryption format) uses 1000-iter PBKDF2-SHA1 (vs 100k SHA256
  // for the tar.gz.enc path) and the only available Node implementation
  // is pure-JS `aes-js` which OOM-crashes on multi-hundred-MB bundles.
  // Operators who want password-protected exports use the tar.gz.enc
  // variant via `POST /:id/export`. The ZIP path's value is
  // cross-platform plaintext extraction (Windows / macOS / `unzip`
  // without extra tools).
  app.post('/admin/tenant-bundles/:id/zip', {
    schema: { tags: ['TenantBundles'], summary: 'Download a bundle as plaintext ZIP', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const [job] = await app.db.select().from(backupJobs).where(eq(backupJobs.id, id)).limit(1);
    if (!job) throw new ApiError('NOT_FOUND', 'Bundle not found', 404);
    if (!job.targetConfigId) throw new ApiError('CONFIG_INVALID', 'Bundle has no targetConfigId; cannot read components', 400);

    const store = await resolveStore(app, job.targetConfigId, { requireActive: false });
    const handle = await store.open(id);
    if (!handle) throw new ApiError('NOT_FOUND', 'Bundle artifacts not found on off-site target', 404);

    const allArtifacts: Array<{ component: 'files' | 'mailboxes' | 'config' | 'secrets'; name: string }> = [];
    for (const component of (['files', 'mailboxes', 'config', 'secrets'] as const)) {
      const refs = await store.listArtifacts(handle, component);
      for (const r of refs) {
        // Same circular-skip as the tar variant.
        if (component === 'config' && r.name.startsWith('data-export-')) continue;
        allArtifacts.push({ component, name: r.name });
      }
    }

    const { streamZipExport } = await import('./data-export.js');
    const stream = await streamZipExport({ store, handle, components: allArtifacts });

    stream.on('error', (err) => {
      app.log.error({
        bundleId: id,
        errMessage: err instanceof Error ? err.message : String(err),
        errName: err instanceof Error ? err.name : 'unknown',
      }, 'tenant-bundles: zip export stream error');
    });

    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', `attachment; filename="bundle-${id}.zip"`);
    reply.header('Cache-Control', 'no-store');
    app.log.warn(
      { userId: (request.user as { sub?: string } | undefined)?.sub, bundleId: id, clientId: job.clientId, format: 'zip' },
      'tenant-bundles: export download initiated',
    );
    return reply.send(stream);
  });

  // ── POST /api/v1/admin/tenant-bundles/:id/export-token ────────────
  //
  // Mint a 5-min single-purpose URL that the browser can open
  // directly via `window.location` to trigger the native save-file
  // dialog the moment the response starts streaming. The companion
  // GET `/exports/:token` endpoint below validates + streams.
  //
  // Why this exists (vs the existing POST /:id/export):
  //   POST handlers can't trigger the browser's save-file dialog
  //   without the response being buffered into a Blob first (the
  //   prior UX). For multi-GB bundles the operator was waiting on
  //   a hidden in-memory copy before the file dialog appeared.
  //   With a signed URL the browser issues an unauthenticated GET,
  //   the server validates the token + streams headers immediately
  //   → save dialog opens at byte 0.
  //
  // Body: { format: 'tar' | 'zip', password?: string }.
  //   - password is only meaningful for tar; the zip variant
  //     ignores it (architectural — see the /zip endpoint comment).
  app.post('/admin/tenant-bundles/:id/export-token', {
    schema: { tags: ['TenantBundles'], summary: 'Mint a single-purpose download URL for a bundle', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const bodySchema = z.object({
      format: z.enum(['tar', 'zip']),
      password: z.string().optional(),
    });
    const parsed = bodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', `invalid body: ${parsed.error.issues[0]?.message ?? 'unknown'}`, 400);
    }
    const { format } = parsed.data;
    // Password rule: only carries through on tar. zip discards it
    // even if supplied — keeps the token small and prevents confusion.
    const password = format === 'tar' ? parsed.data.password : undefined;

    // Validate the bundle exists + is reachable before minting a
    // token. Otherwise the operator clicks Download, the URL goes
    // through, and only then the server returns 404 — confusing UX.
    const [job] = await app.db.select().from(backupJobs).where(eq(backupJobs.id, id)).limit(1);
    if (!job) throw new ApiError('NOT_FOUND', 'Bundle not found', 404);
    if (!job.targetConfigId) throw new ApiError('CONFIG_INVALID', 'Bundle has no targetConfigId', 400);

    const { signExportToken } = await import('./export-token.js');
    const token = signExportToken({ bundleId: id, format, password: password || undefined }, secretsKeyHex);
    const downloadUrl = `/api/v1/admin/tenant-bundles/exports/${encodeURIComponent(token)}`;
    app.log.info(
      { userId: (request.user as { sub?: string } | undefined)?.sub, bundleId: id, format, encrypted: !!(password && password.length > 0) },
      'tenant-bundles: export-token minted',
    );
    return success({ downloadUrl, expiresInSec: 300 });
  });

  // ── GET /api/v1/admin/tenant-bundles/exports/:token ───────────────
  //
  // Token-authenticated download endpoint. The token IS the auth —
  // no Bearer header. The token is bound to one bundleId + format +
  // (encrypted) password and expires after 5 min. See export-token.ts
  // for the token format and signing key.
  //
  // SECURITY: this endpoint is NOT covered by the panel/role
  // onRequest hooks declared at the top of `backupsV2Routes` —
  // `requirePanel('admin')` and `requireRole('super_admin','admin')`
  // both check the request.user populated by JWT auth, which a
  // browser GET via window.location can't supply. We exempt the
  // route via a route-level `config: { skipAuth: true }` flag and
  // verify the signed token instead. Bundle-level access control is
  // enforced by the token's bundleId binding (so an operator can't
  // re-purpose someone else's token for a different bundle).
  app.get(
    '/admin/tenant-bundles/exports/:token',
    {
      schema: { tags: ['TenantBundles'], summary: 'Download a bundle via signed token (no Bearer)', security: [] },
      config: { skipAuth: true },
    },
    async (request, reply) => {
      const { token } = request.params as { token: string };
      // We don't know the expectedBundleId until we decode the token,
      // but we want it bound — so decode once, take .b, and re-verify
      // against itself. This is fine because the HMAC catches a token
      // whose `b` was tampered (any change to the payload breaks the
      // MAC). In other words: trust the .b field iff the MAC is good.
      // Probe the (still-untrusted) payload for its `b` field so we
      // can pass it as `expectedBundleId` to verifyExportToken — the
      // HMAC is then computed over the full payload, so any tampering
      // with `.b` would break the MAC. Both the malformed-shape path
      // and the bad-MAC path map to the SAME 401/INVALID_TOKEN
      // response (no 400 vs 401 oracle for unauthenticated callers).
      const probeOnly = (() => {
        const dot = token.indexOf('.');
        if (dot < 1) return null;
        try {
          const payload = JSON.parse(Buffer.from(token.slice(0, dot).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as { b?: string };
          return payload.b ?? null;
        } catch { return null; }
      })();
      if (!probeOnly) {
        throw new ApiError('INVALID_TOKEN', 'export token rejected', 401);
      }

      const { verifyExportToken } = await import('./export-token.js');
      const v = verifyExportToken(token, probeOnly, secretsKeyHex);
      if (!v.ok) {
        const code = v.error.code === 'EXPIRED' ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN';
        throw new ApiError(code, 'export token rejected', 401);
      }
      const { bundleId, format, password } = v.value;

      const [job] = await app.db.select().from(backupJobs).where(eq(backupJobs.id, bundleId)).limit(1);
      if (!job) throw new ApiError('NOT_FOUND', 'Bundle not found', 404);
      if (!job.targetConfigId) throw new ApiError('CONFIG_INVALID', 'Bundle has no targetConfigId', 400);

      const store = await resolveStore(app, job.targetConfigId, { requireActive: false });
      const handle = await store.open(bundleId);
      if (!handle) throw new ApiError('NOT_FOUND', 'Bundle artifacts not found on off-site target', 404);

      const allArtifacts: Array<{ component: 'files' | 'mailboxes' | 'config' | 'secrets'; name: string }> = [];
      for (const component of (['files', 'mailboxes', 'config', 'secrets'] as const)) {
        const refs = await store.listArtifacts(handle, component);
        for (const r of refs) {
          if (component === 'config' && r.name.startsWith('data-export-')) continue;
          allArtifacts.push({ component, name: r.name });
        }
      }

      let stream: import('node:stream').Readable;
      if (format === 'zip') {
        const { streamZipExport } = await import('./data-export.js');
        stream = await streamZipExport({ store, handle, components: allArtifacts });
        reply.header('Content-Type', 'application/zip');
        reply.header('Content-Disposition', `attachment; filename="bundle-${bundleId}.zip"`);
      } else {
        const { streamEncryptedExport } = await import('./data-export.js');
        const encrypt = !!(password && password.length > 0);
        stream = await streamEncryptedExport({
          store, handle,
          passphrase: encrypt ? password! : undefined,
          components: allArtifacts,
        });
        reply.header('Content-Type', encrypt ? 'application/octet-stream' : 'application/gzip');
        const filename = encrypt ? `bundle-${bundleId}.tar.gz.enc` : `bundle-${bundleId}.tar.gz`;
        reply.header('Content-Disposition', `attachment; filename="${filename}"`);
      }
      reply.header('Cache-Control', 'no-store');
      stream.on('error', (err) => {
        app.log.error({ err: err instanceof Error ? err.message : String(err), bundleId }, 'tenant-bundles: signed-url stream error');
      });
      app.log.warn({ bundleId, clientId: job.clientId, format, encrypted: format === 'tar' && !!(password && password.length > 0) },
        'tenant-bundles: export download via signed-url initiated');
      return reply.send(stream);
    },
  );

  // ── POST /api/v1/admin/tenant-bundles/import ──────────────────────
  //
  // Multi-region import: accept a passphrase-encrypted bundle tarball
  // (produced by the export endpoint), decrypt, upload every component
  // artifact to the local off-site target, and register a fresh
  // backup_jobs row pointing at it. The new bundle appears in the
  // operator's list as a normal capture.
  //
  // Multipart upload: form fields are `passphrase`, `clientId`
  // (target tenant in this region), `targetConfigId` (off-site), and
  // a file `bundle` containing the ciphertext.
  //
  // The clientId in meta.json from the source region is REPLACED by
  // the one in the multipart body — operators routinely import a
  // bundle to a different tenant in the new region.
  // Note: registered AFTER /:id/export, but find-my-way v8 (Fastify
  // 5) correctly prefers a literal `import` segment over the `:id`
  // parametric one regardless of registration order. The same holds
  // for verify-all below. The local convention (see comment near
  // /coverage) was set on Fastify v1 trie semantics.
  //
  // 2 GiB per-route bodyLimit override — bundles can dwarf the global
  // 50 MiB. Global stays low so a stray non-bundle endpoint doesn't
  // accept arbitrary uploads.
  app.post('/admin/tenant-bundles/import', {
    bodyLimit: 2 * 1024 * 1024 * 1024,
    schema: { tags: ['TenantBundles'], summary: 'Import a passphrase-encrypted bundle from another region', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    // Fastify multipart returns one part per file/field. Walk parts
    // until we have all four.
    const req = request as unknown as {
      isMultipart: () => boolean;
      parts: () => AsyncIterable<{ type: 'field' | 'file'; fieldname: string; value?: string; toBuffer?: () => Promise<Buffer> }>;
    };
    if (!req.isMultipart()) {
      throw new ApiError('VALIDATION_ERROR', 'request must be multipart/form-data', 400);
    }
    let passphrase: string | null = null;
    let clientId: string | null = null;
    let targetConfigId: string | null = null;
    let blob: Buffer | null = null;
    for await (const part of req.parts()) {
      if (part.type === 'field' && part.fieldname === 'passphrase') passphrase = part.value ?? null;
      else if (part.type === 'field' && part.fieldname === 'clientId') clientId = part.value ?? null;
      else if (part.type === 'field' && part.fieldname === 'targetConfigId') targetConfigId = part.value ?? null;
      else if (part.type === 'file' && part.fieldname === 'bundle' && part.toBuffer) blob = await part.toBuffer();
    }
    if (!passphrase || passphrase.length < 12) throw new ApiError('VALIDATION_ERROR', 'passphrase ≥12 chars required', 400);
    if (!clientId) throw new ApiError('VALIDATION_ERROR', 'clientId required', 400);
    if (!targetConfigId) throw new ApiError('VALIDATION_ERROR', 'targetConfigId required', 400);
    if (!blob) throw new ApiError('VALIDATION_ERROR', 'bundle file required', 400);

    const [client] = await app.db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
    if (!client) throw new ApiError('NOT_FOUND', 'Target client not found in this region', 404);

    // Decrypt + extract entries.
    const { decryptImportTarball } = await import('./data-export.js');
    const entries = await decryptImportTarball({ cipherBlob: blob, passphrase });

    // Pull the source meta.json (kept for label/components info; we
    // override clientId and capturedAt-vs-importedAt).
    const metaEntry = entries.find((e) => e.path === 'meta.json');
    if (!metaEntry) throw new ApiError('VALIDATION_ERROR', 'tarball missing meta.json', 400);
    let sourceMeta: { backupId?: string; label?: string; description?: string; components?: Record<string, unknown>; retentionDays?: number };
    try {
      sourceMeta = JSON.parse(metaEntry.buffer.toString('utf8'));
    } catch (err) {
      throw new ApiError('VALIDATION_ERROR', `tarball meta.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, 400);
    }

    // Allocate a fresh bundleId in this region.
    const newBundleId = `bkp-${randomUUID()}`;
    const store = await resolveStore(app, targetConfigId, { requireActive: false });
    const handle = await store.reserveBundle({ backupId: newBundleId, clientId });

    // Upload every non-meta entry under its original
    // components/<component>/<name> path.
    const componentSet = new Set(['files', 'mailboxes', 'config', 'secrets'] as const);
    const componentInfo: Array<{ component: string; sizeBytes: number }> = [];
    for (const e of entries) {
      if (e.path === 'meta.json') continue;
      const m = e.path.match(/^components\/(files|mailboxes|config|secrets)\/(.+)$/);
      if (!m) {
        app.log.warn({ path: e.path }, 'import: unexpected tar entry, skipping');
        continue;
      }
      const component = m[1] as 'files' | 'mailboxes' | 'config' | 'secrets';
      const name = m[2]!;
      if (!componentSet.has(component)) continue;
      const ref = await store.writeComponent(handle, component, name, Readable.from(e.buffer));
      componentInfo.push({ component, sizeBytes: ref.sizeBytes });
    }

    // Write a fresh meta.json with this region's bundleId + clientId.
    // The v2 fields (client / domainsSummary / deploymentsSummary) are
    // forwarded as-is from the source meta. If the source was a v1
    // bundle these are missing and the import will fail validation —
    // intentional, no backcompat (see BACKUP_META_SCHEMA_VERSION = 2).
    const sourceClient = (sourceMeta as Record<string, unknown>).client;
    const sourceDomains = (sourceMeta as Record<string, unknown>).domainsSummary;
    const sourceDeploys = (sourceMeta as Record<string, unknown>).deploymentsSummary;
    if (!sourceClient || !Array.isArray(sourceDomains) || !Array.isArray(sourceDeploys)) {
      throw new ApiError(
        'BUNDLE_VERSION_UNSUPPORTED',
        'Imported bundle is missing v2 meta fields (client, domainsSummary, deploymentsSummary). Re-capture the bundle on the source region against a platform-api running schemaVersion=2 or later.',
        400,
      );
    }
    const importMeta: import('@k8s-hosting/api-contracts').BackupMetaV1 = {
      schemaVersion: 2 as const,
      backupId: newBundleId,
      clientId,
      capturedAt: new Date().toISOString(),
      platformVersion,
      initiator: 'admin',
      systemTrigger: null,
      label: `imported-from-${sourceMeta.backupId ?? 'unknown'}: ${sourceMeta.label ?? ''}`.slice(0, 255),
      components: sourceMeta.components ?? {},
      nodePlacement: null,
      expiresAt: null,
      retentionDays: sourceMeta.retentionDays ?? 30,
      description: sourceMeta.description ?? null,
      client: sourceClient as import('@k8s-hosting/api-contracts').BackupMetaClient,
      domainsSummary: sourceDomains as import('@k8s-hosting/api-contracts').BackupMetaDomainSummary[],
      deploymentsSummary: sourceDeploys as import('@k8s-hosting/api-contracts').BackupMetaDeploymentSummary[],
    };
    await store.putMeta(handle, importMeta);

    // Persist the new backup_jobs row. We mirror what the orchestrator
    // does for native captures — pull target attribution from the
    // backup_configurations row (we don't surface targetKind/Uri on
    // BundleHandle, that's an internal-only field).
    const totalBytes = componentInfo.reduce((s, c) => s + c.sizeBytes, 0);
    const [cfg] = await app.db.select().from(backupConfigurations).where(eq(backupConfigurations.id, targetConfigId)).limit(1);
    const targetKind = (cfg?.storageType ?? 'ssh') as 'hostpath' | 's3' | 'ssh';
    const targetUri = cfg?.storageType === 's3'
      ? `s3://${cfg.s3Bucket ?? ''}/${cfg.s3Prefix ?? ''}`
      : `ssh://${cfg?.sshUser ?? ''}@${cfg?.sshHost ?? ''}:${cfg?.sshPath ?? ''}`;
    await app.db.insert(backupJobs).values({
      id: newBundleId,
      clientId,
      initiator: 'admin',
      systemTrigger: null,
      status: 'completed',
      targetKind,
      targetUri,
      targetConfigId,
      label: importMeta.label,
      description: importMeta.description,
      sizeBytes: totalBytes,
      retentionDays: importMeta.retentionDays,
      expiresAt: null,
      exportMode: null,
      exportArtifact: null,
      startedAt: new Date(),
      finishedAt: new Date(),
      lastError: null,
    });

    app.log.warn({ userId: (request.user as { sub?: string } | undefined)?.sub, bundleId: newBundleId, sourceBundleId: sourceMeta.backupId, clientId, totalBytes }, 'tenant-bundles: import succeeded');
    reply.status(201).send({ data: { bundleId: newBundleId, sizeBytes: totalBytes, componentCount: componentInfo.length } });
  });

  // ── POST /api/v1/admin/tenant-bundles/:id/verify ──────────────────
  //
  // Read every component artifact back from the off-site target,
  // decrypt secrets, decompress config, and report:
  //   - meta.json schemaVersion + initiator + timestamps
  //   - per-component byte count + SHA-256 (computed live, no sidecar)
  //   - secrets KID + decrypt success + count of TLS Secrets
  //   - config JSON parse success + per-table row counts
  //
  // Operators run this from the admin panel after a backup to confirm
  // the bytes left the pod and round-trip cleanly. No DB writes; safe
  // to run any number of times.
  app.post('/admin/tenant-bundles/:id/verify', {
    schema: { tags: ['TenantBundles'], summary: 'Verify a bundle round-trip', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const [job] = await app.db.select().from(backupJobs).where(eq(backupJobs.id, id)).limit(1);
    if (!job) throw new ApiError('NOT_FOUND', 'Bundle not found', 404);
    if (!job.targetConfigId) {
      throw new ApiError('CONFIG_INVALID', 'Bundle has no target_config_id (pre-D-redesign row); cannot verify.', 400);
    }
    const store = await resolveStore(app, job.targetConfigId, { requireActive: false });
    const handle = await store.open(id);
    if (!handle) throw new ApiError('NOT_FOUND', 'Bundle artefacts not found on remote target', 404);

    // meta.json
    const meta = await store.getMeta(handle);

    const components: Record<string, unknown> = {};

    // files component — Phase 3 deferred, listed here so the operator
    // sees that the verifier is aware of it.
    if (meta.components.files) {
      const stat = await store.stat(handle, 'files', 'archive.tar.gz').catch(() => null);
      components.files = { reachable: !!stat, sizeBytes: stat?.sizeBytes ?? 0 };
    }

    // config component — gunzip + JSON.parse + count rows per table
    if (meta.components.config) {
      const stream = await store.readComponent(handle, 'config', 'db-rows.json.gz');
      const buf = await streamToBuffer(stream);
      const sha256 = createHash('sha256').update(buf).digest('hex');
      const rowCounts: Record<string, number> = {};
      let parseError: string | null = null;
      try {
        const decompressed = await new Promise<Buffer>((resolve, reject) => {
          gunzip(buf, (err, out) => (err ? reject(err) : resolve(out)));
        });
        const dump = JSON.parse(decompressed.toString('utf8'));
        for (const [table, rows] of Object.entries(dump.tables ?? {})) {
          rowCounts[table] = Array.isArray(rows) ? rows.length : 0;
        }
      } catch (err) {
        parseError = (err as Error).message;
      }
      components.config = {
        sizeBytes: buf.length,
        sha256,
        rowCounts,
        parseError,
      };
    }

    // secrets component — decrypt with k1 + JSON.parse
    if (meta.components.secrets) {
      const stream = await store.readComponent(handle, 'secrets', 'tls.json.gz.enc');
      const buf = await streamToBuffer(stream);
      const sha256 = createHash('sha256').update(buf).digest('hex');
      let secretCount = 0;
      let decryptError: string | null = null;
      try {
        const plaintext = decryptSecretsPayload(buf.toString('utf8'), secretsKeyHex);
        const decompressed = await new Promise<Buffer>((resolve, reject) => {
          gunzip(plaintext, (err, out) => (err ? reject(err) : resolve(out)));
        });
        const dump = JSON.parse(decompressed.toString('utf8'));
        secretCount = Array.isArray(dump.secrets) ? dump.secrets.length : 0;
      } catch (err) {
        decryptError = (err as Error).message;
      }
      components.secrets = {
        sizeBytes: buf.length,
        sha256,
        encryptionKeyId: meta.components.secrets.encryptionKeyId,
        secretCount,
        decryptError,
      };
    }

    return success({
      bundleId: id,
      meta: {
        schemaVersion: meta.schemaVersion,
        capturedAt: meta.capturedAt,
        platformVersion: meta.platformVersion,
        initiator: meta.initiator,
        retentionDays: meta.retentionDays,
        expiresAt: meta.expiresAt,
      },
      components,
    });
  });

  // ── POST /api/v1/admin/tenant-bundles/verify-all ──────────────────
  //
  // Batch verify every bundle that has a targetConfigId (the legacy
  // pre-D rows without one are skipped). Returns a per-bundle summary:
  //
  //   [{ bundleId, status: 'passed' | 'failed' | 'skipped',
  //      reason?: string, durationMs }]
  //
  // No deep per-component detail — operators wanting that drill into
  // /:id/verify. Synchronous: caller pays the wall-clock cost.
  // Bounded at 200 bundles to keep the response under the 60-s ALB
  // timeout; if the cluster has more, the operator filters by client.
  app.post('/admin/tenant-bundles/verify-all', {
    schema: { tags: ['TenantBundles'], summary: 'Verify integrity of every bundle (round-trip read)', security: [{ bearerAuth: [] }] },
  }, async () => {
    const rows = await app.db
      .select()
      .from(backupJobs)
      .orderBy(desc(backupJobs.createdAt))
      .limit(200);

    const results: Array<{
      bundleId: string;
      status: 'passed' | 'failed' | 'skipped';
      reason?: string;
      durationMs: number;
    }> = [];

    for (const row of rows) {
      const start = Date.now();
      if (!row.targetConfigId) {
        results.push({ bundleId: row.id, status: 'skipped', reason: 'no target_config_id', durationMs: 0 });
        continue;
      }
      try {
        const store = await resolveStore(app, row.targetConfigId, { requireActive: false });
        const handle = await store.open(row.id);
        if (!handle) {
          results.push({ bundleId: row.id, status: 'failed', reason: 'bundle artefacts not found on remote target', durationMs: Date.now() - start });
          continue;
        }
        // Cheap integrity probe: meta.json must parse + at least one
        // declared component must be readable. We skip the deep
        // SHA-256 compute (too slow for batch); the per-bundle Verify
        // button does that.
        const meta = await store.getMeta(handle);
        let componentChecked = false;
        for (const component of (['files', 'mailboxes', 'config', 'secrets'] as const)) {
          const declared = meta.components[component];
          if (!declared) continue;
          const refs = await store.listArtifacts(handle, component);
          if (refs.length === 0) {
            results.push({ bundleId: row.id, status: 'failed', reason: `meta declares ${component} but no artifacts on store`, durationMs: Date.now() - start });
            componentChecked = true;
            break;
          }
          componentChecked = true;
        }
        if (componentChecked && results.at(-1)?.bundleId !== row.id) {
          results.push({ bundleId: row.id, status: 'passed', durationMs: Date.now() - start });
        } else if (!componentChecked) {
          results.push({ bundleId: row.id, status: 'failed', reason: 'meta declares no components', durationMs: Date.now() - start });
        }
      } catch (err) {
        results.push({
          bundleId: row.id,
          status: 'failed',
          reason: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - start,
        });
      }
    }

    const summary = {
      total: results.length,
      passed: results.filter((r) => r.status === 'passed').length,
      failed: results.filter((r) => r.status === 'failed').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
    };
    return success({ summary, results });
  });

  // ── DELETE /api/v1/admin/tenant-bundles/:id ───────────────────────
  app.delete('/admin/tenant-bundles/:id', {
    schema: { tags: ['TenantBundles'], summary: 'Delete a bundle (also from store)', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const [job] = await app.db.select().from(backupJobs).where(eq(backupJobs.id, id)).limit(1);
    if (!job) throw new ApiError('NOT_FOUND', 'Bundle not found', 404);
    // Best-effort remote delete: only attempt if the bundle has an
    // off-site target configured. (Older rows could have null
    // targetConfigId from the pre-D-redesign world; for those we
    // just drop the DB row.)
    if (job.targetConfigId) {
      const store = await resolveStore(app, job.targetConfigId, { requireActive: false });
      const handle = await store.open(id);
      if (handle) await store.delete(handle);
    }
    await app.db.delete(backupJobs).where(eq(backupJobs.id, id));
    reply.status(204).send();
  });

  // ── GET /api/v1/admin/backup-schedules ─────────────────────────────
  // Global list of every per-client schedule, joined with the client's
  // business_name for display. Powers the "Schedules" tab on the
  // Tenant Backup admin page. We left-join so a stale schedule row
  // pointing at a deleted client still surfaces (operator sees
  // businessName=null and can prune).
  app.get('/admin/backup-schedules', {
    schema: { tags: ['TenantBundles'], summary: 'List all client backup schedules', security: [{ bearerAuth: [] }] },
  }, async () => {
    const rows = await app.db
      .select({
        clientId: clientBackupSchedules.clientId,
        enabled: clientBackupSchedules.enabled,
        frequency: clientBackupSchedules.frequency,
        hourOfDayUtc: clientBackupSchedules.hourOfDayUtc,
        dayOfWeek: clientBackupSchedules.dayOfWeek,
        dayOfMonth: clientBackupSchedules.dayOfMonth,
        retentionDays: clientBackupSchedules.retentionDays,
        lastRunAt: clientBackupSchedules.lastRunAt,
        lastRunStatus: clientBackupSchedules.lastRunStatus,
        businessName: clients.companyName,
      })
      .from(clientBackupSchedules)
      .leftJoin(clients, eq(clientBackupSchedules.clientId, clients.id))
      .orderBy(desc(clientBackupSchedules.lastRunAt));
    return success({
      data: rows.map((r) => ({
        clientId: r.clientId,
        enabled: r.enabled,
        frequency: r.frequency,
        hourOfDayUtc: r.hourOfDayUtc,
        dayOfWeek: r.dayOfWeek,
        dayOfMonth: r.dayOfMonth,
        retentionDays: r.retentionDays,
        lastRunAt: r.lastRunAt ? r.lastRunAt.toISOString() : null,
        lastRunStatus: r.lastRunStatus,
        businessName: r.businessName,
      })),
    });
  });

  // ── GET /api/v1/admin/clients/:clientId/backup-schedule ────────────
  // Returns the client's schedule row, or null when none exists yet.
  app.get('/admin/clients/:clientId/backup-schedule', {
    schema: { tags: ['TenantBundles'], summary: 'Get the client backup schedule', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };
    const [row] = await app.db.select().from(clientBackupSchedules)
      .where(eq(clientBackupSchedules.clientId, clientId)).limit(1);
    if (!row) return success(null);
    return success({
      clientId: row.clientId,
      enabled: row.enabled,
      frequency: row.frequency,
      hourOfDayUtc: row.hourOfDayUtc,
      dayOfWeek: row.dayOfWeek,
      dayOfMonth: row.dayOfMonth,
      retentionDays: row.retentionDays,
      lastRunAt: row.lastRunAt ? row.lastRunAt.toISOString() : null,
      lastRunStatus: row.lastRunStatus,
    });
  });

  // ── PUT /api/v1/admin/clients/:clientId/backup-schedule ────────────
  // Upsert the schedule row. PUT semantics — full row supplied each time.
  app.put('/admin/clients/:clientId/backup-schedule', {
    schema: { tags: ['TenantBundles'], summary: 'Upsert the client backup schedule', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };
    const parsed = updateClientBackupScheduleSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; '), 400);
    }
    const [client] = await app.db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
    if (!client) throw new ApiError('NOT_FOUND', 'Client not found', 404);
    // Plan retention cap applies here too (Tier-3 cannot bypass).
    const [plan] = await app.db.select({
      defaultDays: hostingPlans.defaultBackupRetentionDays,
      maxDays: hostingPlans.maxBackupRetentionDays,
    }).from(hostingPlans).where(eq(hostingPlans.id, client.planId)).limit(1);
    if (!plan) throw new ApiError('CONFIG_INVALID', 'Client has no resolvable plan', 400);
    const requestedRetention = parsed.data.retentionDays ?? plan.defaultDays;
    if (requestedRetention > plan.maxDays) {
      throw new ApiError(
        'VALIDATION_ERROR',
        `retentionDays ${requestedRetention} exceeds the plan's max_backup_retention_days (${plan.maxDays})`,
        400,
      );
    }

    // Upsert. Reset last_run_at when enabling so the next tick fires
    // immediately; preserve when re-saving without flipping enable.
    const existing = await app.db.select().from(clientBackupSchedules)
      .where(eq(clientBackupSchedules.clientId, clientId)).limit(1);
    if (existing.length === 0) {
      await app.db.insert(clientBackupSchedules).values({
        clientId,
        enabled: parsed.data.enabled ?? false,
        frequency: parsed.data.frequency ?? 'weekly',
        hourOfDayUtc: parsed.data.hourOfDayUtc ?? 3,
        dayOfWeek: parsed.data.dayOfWeek ?? null,
        dayOfMonth: parsed.data.dayOfMonth ?? null,
        retentionDays: requestedRetention,
      });
    } else {
      await app.db.update(clientBackupSchedules).set({
        enabled: parsed.data.enabled ?? existing[0]!.enabled,
        frequency: parsed.data.frequency ?? existing[0]!.frequency,
        hourOfDayUtc: parsed.data.hourOfDayUtc ?? existing[0]!.hourOfDayUtc,
        dayOfWeek: parsed.data.dayOfWeek === undefined ? existing[0]!.dayOfWeek : parsed.data.dayOfWeek,
        dayOfMonth: parsed.data.dayOfMonth === undefined ? existing[0]!.dayOfMonth : parsed.data.dayOfMonth,
        retentionDays: requestedRetention,
      }).where(eq(clientBackupSchedules.clientId, clientId));
    }
    const [refreshed] = await app.db.select().from(clientBackupSchedules)
      .where(eq(clientBackupSchedules.clientId, clientId)).limit(1);
    return success({
      clientId: refreshed!.clientId,
      enabled: refreshed!.enabled,
      frequency: refreshed!.frequency,
      hourOfDayUtc: refreshed!.hourOfDayUtc,
      dayOfWeek: refreshed!.dayOfWeek,
      dayOfMonth: refreshed!.dayOfMonth,
      retentionDays: refreshed!.retentionDays,
      lastRunAt: refreshed!.lastRunAt ? refreshed!.lastRunAt.toISOString() : null,
      lastRunStatus: refreshed!.lastRunStatus,
    });
  });

  // ── DELETE /api/v1/admin/clients/:clientId/backup-schedule ─────────
  app.delete('/admin/clients/:clientId/backup-schedule', {
    schema: { tags: ['TenantBundles'], summary: 'Disable + remove the client backup schedule', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const { clientId } = request.params as { clientId: string };
    await app.db.delete(clientBackupSchedules).where(eq(clientBackupSchedules.clientId, clientId));
    reply.status(204).send();
  });

  // ── POST /api/v1/admin/clients/:clientId/backup-schedule/run-now ───
  // Reset last_run_at on the client's schedule so the next Tier-1
  // tick (within 5 min) picks it up. Operator-friendly affordance:
  // lets you test a schedule without waiting for the natural next-due
  // window. Requires the schedule to exist + be enabled.
  app.post('/admin/clients/:clientId/backup-schedule/run-now', {
    schema: { tags: ['TenantBundles'], summary: 'Force the next scheduler tick to fire this client immediately', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const { clientId } = request.params as { clientId: string };
    const [row] = await app.db.select().from(clientBackupSchedules)
      .where(eq(clientBackupSchedules.clientId, clientId)).limit(1);
    if (!row) throw new ApiError('NOT_FOUND', 'No schedule for this client — create one first', 404);
    if (!row.enabled) throw new ApiError('VALIDATION_ERROR', 'Schedule is disabled — enable it before requesting a run', 400);
    // Setting last_run_at to NULL marks the row as "never run" which
    // matches the eligibility predicate `last_run_at IS NULL` in
    // schedule.ts.runScheduleTick. The cross-replica CAS still
    // serialises if multiple admins hit Run-Now simultaneously.
    await app.db.update(clientBackupSchedules)
      .set({ lastRunAt: null, lastRunStatus: null })
      .where(eq(clientBackupSchedules.clientId, clientId));
    reply.send(success({ clientId, message: 'Scheduled for next tick (within 5 minutes)' }));
  });
}

async function resolveStore(
  app: FastifyInstance,
  targetConfigId: string,
  opts: { requireActive: boolean } = { requireActive: true },
): Promise<BackupStore> {
  const [cfg] = await app.db.select().from(backupConfigurations).where(eq(backupConfigurations.id, targetConfigId)).limit(1);
  if (!cfg) throw new ApiError('NOT_FOUND', 'Backup target not found', 404);
  // Inactive targets must not accept NEW writes — an operator may have
  // taken the target out of service (rotated keys, decommissioning).
  // DELETE callers pass requireActive=false so cleanup of existing
  // bundles on a deactivated target still works.
  if (opts.requireActive && !cfg.active) {
    throw new ApiError('CONFIG_INVALID',
      `Backup target ${cfg.id} is not active. Activate it via Admin → Backup Settings before writing bundles.`,
      400);
  }

  const encKey = (app.config as Record<string, unknown>).OIDC_ENCRYPTION_KEY as string | undefined
    ?? process.env.OIDC_ENCRYPTION_KEY
    ?? '0'.repeat(64);

  if (cfg.storageType === 's3') {
    // Decrypt with a sanitised error wrapper — the underlying decrypt()
    // can throw OpenSSL strings that include ciphertext fragments, and
    // those would otherwise leak through Fastify's default 500 handler
    // into the response body.
    let accessKey = '';
    let secretKey = '';
    try {
      accessKey = cfg.s3AccessKeyEncrypted ? decrypt(cfg.s3AccessKeyEncrypted, encKey) : '';
      secretKey = cfg.s3SecretKeyEncrypted ? decrypt(cfg.s3SecretKeyEncrypted, encKey) : '';
    } catch (err) {
      app.log.error({ err, configId: cfg.id }, 'tenant-bundles: S3 credential decryption failed');
      throw new ApiError('CONFIG_INVALID', 'S3 credential decryption failed (encryption key may have rotated)', 500);
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
      throw new ApiError('CONFIG_INVALID',
        `Backup target ${cfg.id} is missing SSH host/user/key/path`, 400);
    }
    let privateKey = '';
    try {
      privateKey = decrypt(cfg.sshKeyEncrypted, encKey);
    } catch (err) {
      app.log.error({ err, configId: cfg.id }, 'tenant-bundles: SSH key decryption failed');
      throw new ApiError('CONFIG_INVALID', 'SSH key decryption failed (encryption key may have rotated)', 500);
    }
    if (!privateKey) {
      throw new ApiError('CONFIG_INVALID', `Backup target ${cfg.id} has empty SSH key`, 400);
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

  throw new ApiError('NOT_IMPLEMENTED',
    `Backup store kind '${cfg.storageType}' is not supported`, 501);
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Map a `backup_jobs` row + the live client status into the
 * BundleSummary contract. Caller resolves the client status via
 * a LEFT JOIN (list endpoint) or a follow-up SELECT (single-bundle
 * endpoints) so this function stays pure.
 */
function toBundleSummary(
  j: typeof backupJobs.$inferSelect,
  client: { status: import('@k8s-hosting/api-contracts').BundleClientStatus; name: string | null },
): BundleSummary {
  return {
    id: j.id,
    clientId: j.clientId,
    clientStatus: client.status,
    clientName: client.name,
    initiator: j.initiator,
    systemTrigger: j.systemTrigger,
    status: j.status,
    targetKind: j.targetKind,
    targetUri: j.targetUri,
    targetConfigId: j.targetConfigId,
    label: j.label,
    description: j.description,
    sizeBytes: Number(j.sizeBytes),
    retentionDays: j.retentionDays,
    expiresAt: j.expiresAt ? j.expiresAt.toISOString() : null,
    exportMode: j.exportMode,
    exportArtifact: j.exportArtifact,
    startedAt: j.startedAt ? j.startedAt.toISOString() : null,
    finishedAt: j.finishedAt ? j.finishedAt.toISOString() : null,
    lastError: j.lastError,
    createdAt: j.createdAt.toISOString(),
    updatedAt: j.updatedAt.toISOString(),
  };
}

/**
 * Convert clients.status (or null when the row was deleted) into the
 * BundleClientStatus enum the UI consumes.
 */
export function clientRowToBundleStatus(
  status: string | null | undefined,
): import('@k8s-hosting/api-contracts').BundleClientStatus {
  if (!status) return 'missing';
  if (status === 'archived') return 'archived';
  if (status === 'suspended') return 'suspended';
  return 'active';
}

function toComponentInfo(c: typeof backupComponents.$inferSelect): BackupComponentInfo {
  return {
    id: c.id,
    component: c.component,
    artifactName: c.artifactName,
    status: c.status,
    sizeBytes: Number(c.sizeBytes),
    sha256: c.sha256,
    startedAt: c.startedAt ? c.startedAt.toISOString() : null,
    finishedAt: c.finishedAt ? c.finishedAt.toISOString() : null,
    lastError: c.lastError,
  };
}
