import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCors from '@fastify/cors';
import fastifyCompress from '@fastify/compress';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import websocket from '@fastify/websocket';
import { errorHandler } from './middleware/error-handler.js';
import { registerAuditHook } from './middleware/audit.js';
import { registerRateLimit } from './middleware/rate-limit.js';
import { getSettings as getSystemSettings } from './modules/system-settings/service.js';

/**
 * Resolve the effective API rate limit (req/min) from, in priority order:
 * (1) the system_settings row set via the admin panel, (2) the API_RATE_LIMIT
 * env var, (3) the built-in default. Read once at startup — the rate-limit
 * plugin wraps all routes and can't be re-registered, so changing the DB
 * value requires a platform-api restart. The System Settings UI surfaces
 * this.
 */
async function resolveRateLimitMax(db: Database): Promise<number> {
  try {
    const s = await getSystemSettings(db);
    if (typeof s.apiRateLimit === 'number' && s.apiRateLimit > 0) return s.apiRateLimit;
  } catch {
    // Table not yet migrated or DB unreachable — fall through
  }
  const envVal = process.env.API_RATE_LIMIT ? parseInt(process.env.API_RATE_LIMIT, 10) : NaN;
  return Number.isFinite(envVal) && envVal > 0 ? envVal : 100;
}
import { registerAuth, authenticate, requireRole } from './middleware/auth.js';
import { createCacheMiddleware, cacheOnSendHook } from './middleware/cache.js';
import { clientRoutes } from './modules/clients/routes.js';
import { domainRoutes } from './modules/domains/routes.js';
import { subscriptionRoutes } from './modules/subscriptions/routes.js';
import { backupRoutes } from './modules/backups/routes.js';
import { metricsRoutes } from './modules/metrics/routes.js';
import { cronJobRoutes } from './modules/cron-jobs/routes.js';
import { authRoutes } from './modules/auth/routes.js';
import { passkeyRoutes } from './modules/auth/passkey-routes.js';
import { planRoutes } from './modules/plans/routes.js';
import { regionRoutes } from './modules/regions/routes.js';
import { catalogRoutes } from './modules/catalog/routes.js';
import { deploymentRoutes } from './modules/deployments/routes.js';
import { dashboardRoutes } from './modules/dashboard/routes.js';
import { auditLogRoutes } from './modules/audit-logs/routes.js';
import { storageSettingsRoutes } from './modules/storage-settings/routes.js';
import { storageRoutes } from './modules/storage/routes.js';
import { dnsRecordRoutes } from './modules/dns-records/routes.js';
import { hostingSettingsRoutes } from './modules/hosting-settings/routes.js';
import { protectedDirectoryRoutes } from './modules/protected-directories/routes.js';
import { sshKeyRoutes } from './modules/ssh-keys/routes.js';
import { sftpUserRoutes } from './modules/sftp-users/routes.js';
import { sftpInternalRoutes } from './modules/sftp-users/internal-routes.js';
import { privateWorkerRoutes } from './modules/private-workers/routes.js';
import { privateWorkerInternalRoutes } from './modules/private-workers/internal-routes.js';
import { privateWorkerAdminRoutes } from './modules/private-workers/admin-routes.js';
import { resourceQuotaRoutes } from './modules/resource-quotas/routes.js';
import { oidcRoutes } from './modules/oidc/routes.js';
import { dnsServerRoutes } from './modules/dns-servers/routes.js';
import { k8sManifestRoutes } from './modules/k8s-manifests/routes.js';
import { provisioningRoutes } from './modules/k8s-provisioner/routes.js';
import { nodeRoutes } from './modules/nodes/routes.js';
import { loadBalancerRoutes } from './modules/load-balancer/routes.js';
import { tenantMigrationRoutes } from './modules/tenant-migration/routes.js';
import { clusterHealthRoutes } from './modules/cluster-health/routes.js';
import { platformStoragePolicyRoutes } from './modules/platform-storage-policy/routes.js';
import { namespaceIntegrityRoutes } from './modules/namespace-integrity/routes.js';
import { orphanedVolumesRoutes } from './modules/orphaned-volumes/routes.js';
import { registerAllLifecycleHooks } from './modules/client-lifecycle/hooks/index.js';
import { clientLifecycleRoutes } from './modules/client-lifecycle/routes.js';
import { systemSnapshotsRoutes } from './modules/system-snapshots/routes.js';
import { postgresRestoreRoutes } from './modules/postgres-restore/routes.js';
import { isPostgresRestoreInProgress, isPostgresRestoreInProgressClusterWide } from './modules/postgres-restore/service.js';
import { systemBackupRoutes } from './modules/system-backup/routes.js';
import { systemBackupDownloadRoutes } from './modules/system-backup/download-route.js';
import { systemBackupPgDumpRoutes } from './modules/system-backup/pg-dump-routes.js';
import { systemBackupWalArchiveRoutes } from './modules/system-backup/wal-archive-routes.js';
import { fileManagerRoutes } from './modules/file-manager/routes.js';
import { storageLifecycleRoutes } from './modules/storage-lifecycle/routes.js';
import { notificationRoutes } from './modules/notifications/routes.js';
import { backupConfigRoutes } from './modules/backup-config/routes.js';
import { backupsV2Routes } from './modules/tenant-bundles/routes.js';
import { backupsV2InternalUploadRoutes } from './modules/tenant-bundles/internal-upload-route.js';
import { backupsV2InternalDownloadRoutes } from './modules/tenant-bundles/internal-download-route.js';
import { backupsV2ClientRoutes } from './modules/tenant-bundles/client-routes.js';
import { backupRestoreRoutes } from './modules/backup-restore/routes.js';
import { adminUserRoutes } from './modules/admin-users/routes.js';
import { healthRoutes } from './modules/health/routes.js';
import { exportImportRoutes } from './modules/export-import/routes.js';
import { emailDomainRoutes } from './modules/email-domains/routes.js';
import { emailDkimStatusRoutes } from './modules/email-dkim/jmap-status.js';
import { mailSubmitRoutes } from './modules/mail-submit/routes.js';
import { mailImapsyncRoutes } from './modules/mail-imapsync/routes.js';
import { mailAdminRoutes } from './modules/mail-admin/routes.js';
import { emailAutodiscoverRoutes } from './modules/email-autodiscover/routes.js';
import { mailStatsRoutes } from './modules/mail-stats/routes.js';
import { mailboxRoutes } from './modules/mailboxes/routes.js';
import { emailAliasRoutes } from './modules/email-aliases/routes.js';
import { smtpRelayRoutes, smtpRelayClientRoutes } from './modules/smtp-relay/routes.js';
import { webmailSettingsRoutes } from './modules/webmail-settings/routes.js';
import { platformUrlsRoutes } from './modules/platform-urls/routes.js';
import { platformUpdateRoutes } from './modules/platform-updates/routes.js';
import { sslCertRoutes } from './modules/ssl-certs/routes.js';
import { eolScannerRoutes } from './modules/eol-scanner/routes.js';
import { tlsSettingsRoutes } from './modules/tls-settings/routes.js';
import { ingressRouteRoutes } from './modules/ingress-routes/routes.js';
import { ingressAuthRoutes } from './modules/ingress-auth/routes.js';
import { oidcProvidersRoutes } from './modules/ingress-auth/providers-routes.js';
import { ingressMtlsRoutes } from './modules/ingress-mtls/routes.js';
import { mtlsProvidersRoutes } from './modules/mtls-providers/routes.js';
import { zitiProvidersRoutes } from './modules/ziti-providers/routes.js';
import { zrokProvidersRoutes } from './modules/zrok-providers/routes.js';
import { deploymentNetworkAccessRoutes } from './modules/deployment-network-access/routes.js';
import { sqliteRoutes } from './modules/sqlite/routes.js';
import { startWebcronScheduler } from './modules/cron-jobs/scheduler.js';
import { startIdleCleanup } from './modules/file-manager/idle-cleanup.js';
import { startMetricsScheduler } from './modules/metrics/metrics-scheduler.js';
import { startMailStatsScheduler, stopMailStatsScheduler } from './modules/mail-stats/scheduler.js';
import { startStorageLifecycleScheduler } from './modules/storage-lifecycle/scheduler.js';
import { startRetentionScheduler } from './modules/tenant-bundles/retention.js';
import { startBackupScheduleTick } from './modules/tenant-bundles/schedule.js';
// M12: DKIM rotation scheduler removed — Stalwart 0.16 manages DKIM natively
import { createPrincipalsSyncScheduler } from './modules/stalwart-jmap/principals-sync.js';
import { startImapSyncReconciler } from './modules/mail-imapsync/scheduler.js';
import { startNodeSyncReconciler } from './modules/nodes/scheduler.js';
import { getRedis, closeRedis } from './shared/redis.js';
import { startImagePressureWatcher } from './modules/storage/image-pressure-watcher.js';
import { startKubeletGcReconciler } from './modules/cluster-settings/kubelet-gc-reconciler.js';
import { startVerificationCron } from './modules/domains/verification-cron.js';
import type { Config } from './config/index.js';
import type { Database } from './db/index.js';

export interface AppDependencies {
  readonly config: Config;
  readonly db: Database;
}

declare module 'fastify' {
  interface FastifyInstance {
    db: Database;
    config: Config;
  }
}

export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  // Register lifecycle hooks once per process. Order matters across
  // hooks (declared via the registry's `order` + `after` graph) but
  // the registration calls themselves are idempotent — re-importing
  // this module under hot-reload is safe.
  registerAllLifecycleHooks();

  const app = Fastify({
    logger: deps.config.NODE_ENV !== 'test' && {
      level: deps.config.LOG_LEVEL,
      // Redact sensitive segments from request URLs in access logs.
      // The system-backup secrets-bundle download URL contains the
      // one-shot HMAC token as a path parameter; without redaction it
      // would land in pino's default `{ req: { url } }` line and any
      // operator with log-read access could harvest tokens before
      // their single-use mark fires. The redact path uses pino's
      // bracket notation; censor with a literal placeholder.
      redact: {
        paths: ['req.url'],
        censor: (value: unknown): unknown => {
          if (typeof value !== 'string') return value;
          return value.replace(
            /\/api\/v1\/system-backup\/secrets\/download\/[^/?#]+/,
            '/api/v1/system-backup/secrets/download/[REDACTED]',
          );
        },
      },
    },
    genReqId: () => crypto.randomUUID(),
    bodyLimit: 50 * 1024 * 1024, // 50MB for SQL imports
    // System Backup secrets-bundle download URL embeds the HMAC
    // token as a path parameter: <uuid>.<expiresMs>.<mac> ≈ 115 chars.
    // Default maxParamLength (100) makes find-my-way refuse to match
    // and Fastify returns 404 silently. Bump generously — no other
    // route uses 256-char params, and shorter URLs aren't constrained.
    maxParamLength: 256,
    // trustProxy: nginx-ingress terminates TLS and forwards as HTTP
    // to the platform-api pod. Without this, request.protocol returns
    // "http" — which breaks OIDC because the redirect_uri sent to
    // Dex is "http://admin.../callback" while Dex's static client
    // only allows "https://admin.../callback" → "Unregistered
    // redirect_uri." Surfaced by integration-oidc-dex.sh.
    trustProxy: true,
  });

  // Plugins
  // CORS — restrict to known origins; fallback to permissive in development only
  const allowedOrigins = deps.config.CORS_ORIGINS
    ? deps.config.CORS_ORIGINS.split(',').map((s) => s.trim())
    : deps.config.NODE_ENV === 'production'
      ? [] // No open CORS in production — must be configured
      : true; // Permissive in development/test
  await app.register(fastifyCors, { origin: allowedOrigins });
  await app.register(fastifyCompress, { global: true });
  await app.register(websocket);
  await app.register(fastifyJwt, { secret: deps.config.JWT_SECRET });

  // Decorate DB first so registerRateLimit can read the configured limit
  // from the system_settings row. Falls back to env (API_RATE_LIMIT) then
  // to the built-in default of 100 req/min.
  app.decorate('db', deps.db);
  app.decorate('config', deps.config);
  const rateLimitMax = await resolveRateLimitMax(deps.db);
  await registerRateLimit(app, { max: rateLimitMax });
  registerAuth(app);

  // Error handler
  app.setErrorHandler(errorHandler);

  // Audit logging (fire-and-forget on mutations)
  registerAuditHook(app, deps.db);

  // Postgres-PITR write lock: while a PITR restore is in flight,
  // reject any non-GET request that would write to the platform DB
  // (the source cluster is being torn down + replaced; writes during
  // that window get lost). The restore endpoint itself is allowlisted
  // so the operator can monitor status. Health checks (GET) are
  // unaffected. Returns 503 RESTORE_IN_PROGRESS with a Retry-After
  // hint so frontends can backoff cleanly.
  app.addHook('onRequest', async (request, reply) => {
    if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return;
    const url = request.url;
    // Allowlist: status check + the PITR endpoint itself + auth/login
    // (operator may need to re-login during the long restore).
    // Use exact path matches (with optional querystring) so future
    // routes added under /api/v1/admin/postgres-restore/ don't
    // automatically bypass the lock.
    const path = url.split('?')[0];
    if (
      path === '/api/v1/admin/postgres-restore'
      || path === '/api/v1/admin/postgres-restore/status'
      || path.startsWith('/api/v1/auth/')
      || path.startsWith('/api/v1/healthz')
    ) return;
    // Cluster-wide check: any replica's in-memory lock OR the
    // DB-backed lock written at the start of orchestration. With 3
    // platform-api replicas, only the replica running the
    // orchestration has the in-memory lock — the other two need the
    // DB lock to know to reject writes. One DB read per non-GET
    // request; cached briefly under load via the existing pg
    // connection pool.
    const lock = await isPostgresRestoreInProgressClusterWide(app.db);
    if (lock.inProgress) {
      reply.code(503).header('Retry-After', '60').send({
        error: {
          code: 'RESTORE_IN_PROGRESS',
          message: `Postgres PITR restore in progress (started ${lock.startedAt?.toISOString()}, snapshot ${lock.snapshot}, source=${lock.source}). Writes are blocked until the restore completes.`,
          status: 503,
          remediation: 'Wait for the restore to complete; poll GET /api/v1/admin/postgres-restore/status',
        },
      });
    }
  });

  // Response caching (global onSend hook captures responses for cached routes)
  app.addHook('onSend', cacheOnSendHook);

  // OpenAPI / Swagger documentation
  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'K8s Hosting Platform API',
        description: 'Management API for the Kubernetes web hosting platform',
        version: '0.1.0',
      },
      servers: [
        { url: 'http://localhost:3000', description: 'Development' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
        },
      },
    },
  });

  await app.register(fastifySwaggerUi, {
    routePrefix: '/api/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
    },
  });

  // Unauthenticated liveness probe for Docker/K8s health checks
  app.get('/api/v1/healthz', async () => ({ status: 'ok' }));

  // Detailed status — requires auth (exposes infrastructure state)
  app.get('/api/v1/admin/status', {
    onRequest: [authenticate, requireRole('super_admin', 'admin', 'support', 'read_only')],
    preHandler: createCacheMiddleware(10_000),
    schema: {
      tags: ['Admin'],
      summary: 'Health check / system status',
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                status: { type: 'string', enum: ['healthy', 'degraded', 'unhealthy'] },
                timestamp: { type: 'string', format: 'date-time' },
                version: { type: 'string' },
                services: {
                  type: 'object',
                  properties: {
                    kubernetes: { type: 'string', enum: ['ok', 'degraded', 'error'] },
                    redis: { type: 'string', enum: ['ok', 'error'] },
                    database: { type: 'string', enum: ['ok', 'error'] },
                  },
                },
              },
            },
          },
        },
      },
    },
  }, async () => {
    const { checkDatabase, checkKubernetes, checkRedis } = await import('./modules/health/service.js');
    const { createK8sClients } = await import('./modules/k8s-provisioner/k8s-client.js');

    const kubeconfigPath = (deps.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    let k8sCore;
    try { k8sCore = createK8sClients(kubeconfigPath).core; } catch { /* no kubeconfig */ }

    const [dbStatus, k8sStatus, redisStatus] = await Promise.all([
      checkDatabase(deps.db),
      checkKubernetes(k8sCore),
      checkRedis(),
    ]);

    const statuses = [dbStatus, k8sStatus, redisStatus];
    const hasError = statuses.some((s) => s.status === 'error');
    const hasDegraded = statuses.some((s) => s.status === 'degraded');

    return {
      data: {
        status: hasError ? 'unhealthy' : hasDegraded ? 'degraded' : 'healthy',
        timestamp: new Date().toISOString(),
        version: '0.1.0',
        services: {
          kubernetes: k8sStatus.status,
          redis: redisStatus.status,
          database: dbStatus.status,
        },
      },
    };
  });

  // Routes
  await app.register(authRoutes, { prefix: '/api/v1' });
  await app.register(passkeyRoutes, { prefix: '/api/v1' });
  await app.register(planRoutes, { prefix: '/api/v1' });
  await app.register(regionRoutes, { prefix: '/api/v1' });
  await app.register(clientRoutes, { prefix: '/api/v1' });
  await app.register(domainRoutes, { prefix: '/api/v1' });
  await app.register(subscriptionRoutes, { prefix: '/api/v1' });
  await app.register(backupRoutes, { prefix: '/api/v1' });
  await app.register(metricsRoutes, { prefix: '/api/v1' });
  await app.register(cronJobRoutes, { prefix: '/api/v1' });
  await app.register(catalogRoutes, { prefix: '/api/v1' });
  await app.register(deploymentRoutes, { prefix: '/api/v1' });
  await app.register(dashboardRoutes, { prefix: '/api/v1' });
  await app.register(auditLogRoutes, { prefix: '/api/v1' });
  await app.register(storageSettingsRoutes, { prefix: '/api/v1' });
  await app.register(storageRoutes, { prefix: '/api/v1' });
  await app.register(dnsRecordRoutes, { prefix: '/api/v1' });
  await app.register(hostingSettingsRoutes, { prefix: '/api/v1' });
  await app.register(protectedDirectoryRoutes, { prefix: '/api/v1' });
  await app.register(sshKeyRoutes, { prefix: '/api/v1' });
  await app.register(sftpUserRoutes, { prefix: '/api/v1' });
  await app.register(sftpInternalRoutes, { prefix: '/api/v1' });
  await app.register(privateWorkerRoutes, { prefix: '/api/v1' });
  await app.register(privateWorkerInternalRoutes, { prefix: '/api/v1' });
  await app.register(privateWorkerAdminRoutes, { prefix: '/api/v1' });
  await app.register(resourceQuotaRoutes, { prefix: '/api/v1' });
  await app.register(storageLifecycleRoutes, { prefix: '/api/v1' });
  await app.register(oidcRoutes, { prefix: '/api/v1' });
  await app.register(dnsServerRoutes, { prefix: '/api/v1' });
  await app.register(k8sManifestRoutes, { prefix: '/api/v1' });
  await app.register(provisioningRoutes, { prefix: '/api/v1' });
  await app.register(nodeRoutes, { prefix: '/api/v1' });
  await app.register(loadBalancerRoutes, { prefix: '/api/v1' });
  await app.register(tenantMigrationRoutes, { prefix: '/api/v1' });
  await app.register(clusterHealthRoutes, { prefix: '/api/v1' });
  await app.register(platformStoragePolicyRoutes, { prefix: '/api/v1' });
  await app.register(namespaceIntegrityRoutes, { prefix: '/api/v1' });
  await app.register(orphanedVolumesRoutes, { prefix: '/api/v1' });
  await app.register(clientLifecycleRoutes, { prefix: '/api/v1' });
  await app.register(systemSnapshotsRoutes, { prefix: '/api/v1' });
  await app.register(postgresRestoreRoutes, { prefix: '/api/v1' });
  await app.register(systemBackupRoutes, { prefix: '/api/v1' });
  await app.register(systemBackupDownloadRoutes, { prefix: '/api/v1' });
  await app.register(systemBackupPgDumpRoutes, { prefix: '/api/v1' });
  await app.register(systemBackupWalArchiveRoutes, { prefix: '/api/v1' });
  await app.register(fileManagerRoutes, { prefix: '/api/v1' });
  await app.register(notificationRoutes, { prefix: '/api/v1' });
  await app.register(backupConfigRoutes, { prefix: '/api/v1' });
  await app.register(backupsV2Routes, { prefix: '/api/v1' });
  await app.register(backupsV2InternalUploadRoutes, { prefix: '/api/v1' });
  await app.register(backupsV2InternalDownloadRoutes, { prefix: '/api/v1' });
  await app.register(backupsV2ClientRoutes, { prefix: '/api/v1' });
  await app.register(backupRestoreRoutes, { prefix: '/api/v1' });
  await app.register(adminUserRoutes, { prefix: '/api/v1' });
  await app.register(healthRoutes, { prefix: '/api/v1' });
  await app.register(exportImportRoutes, { prefix: '/api/v1' });
  await app.register(emailDomainRoutes, { prefix: '/api/v1' });
  await app.register(emailDkimStatusRoutes, { prefix: '/api/v1' }); // M12: read-only DKIM status via Stalwart JMAP
  await app.register(mailSubmitRoutes, { prefix: '/api/v1' });
  await app.register(mailImapsyncRoutes, { prefix: '/api/v1' });
  await app.register(mailAdminRoutes, { prefix: '/api/v1' });
  // Phase 3.C.1: public autodiscover routes — no /api/v1 prefix.
  // Email clients hit these BEFORE auth, at well-known paths on
  // the platform base URL (or at autoconfig.<domain> / autodiscover.<domain>
  // CNAMEs that resolve to the platform ingress).
  await app.register(emailAutodiscoverRoutes);
  await app.register(mailStatsRoutes, { prefix: '/api/v1' });
  await app.register(mailboxRoutes, { prefix: '/api/v1' });
  await app.register(emailAliasRoutes, { prefix: '/api/v1' });
  await app.register(smtpRelayRoutes, { prefix: '/api/v1' });
  await app.register(smtpRelayClientRoutes, { prefix: '/api/v1' });
  await app.register(webmailSettingsRoutes, { prefix: '/api/v1' });
  await app.register(platformUrlsRoutes, { prefix: '/api/v1' });
  await app.register(platformUpdateRoutes, { prefix: '/api/v1' });
  await app.register(sslCertRoutes, { prefix: '/api/v1' });
  await app.register(eolScannerRoutes, { prefix: '/api/v1' });
  await app.register(tlsSettingsRoutes, { prefix: '/api/v1' });
  await app.register(ingressRouteRoutes, { prefix: '/api/v1' });
  await app.register(ingressAuthRoutes, { prefix: '/api/v1' });
  await app.register(oidcProvidersRoutes, { prefix: '/api/v1' });
  await app.register(ingressMtlsRoutes, { prefix: '/api/v1' });
  await app.register(mtlsProvidersRoutes, { prefix: '/api/v1' });
  await app.register(zitiProvidersRoutes, { prefix: '/api/v1' });
  await app.register(zrokProvidersRoutes, { prefix: '/api/v1' });
  await app.register(deploymentNetworkAccessRoutes, { prefix: '/api/v1' });
  await app.register(sqliteRoutes, { prefix: '/api/v1' });

  const { systemSettingsRoutes } = await import('./modules/system-settings/routes.js');
  await app.register(systemSettingsRoutes, { prefix: '/api/v1' });

  const { containerConsoleRoutes } = await import('./modules/container-console/routes.js');
  await app.register(containerConsoleRoutes, { prefix: '/api/v1' });

  const { aiEditorRoutes } = await import('./modules/ai-editor/routes.js');
  await app.register(aiEditorRoutes, { prefix: '/api/v1' });

  // Start background schedulers (skip in test environment)
  if (deps.config.NODE_ENV !== 'test') {
    app.addHook('onReady', async () => {
      // In-memory cache replaces Redis (M14). getRedis() now returns
      // a per-process LRU; no connect() call needed. Initialize it
      // here for parity with the previous startup-warm pattern.
      getRedis();

      // Crash-safe PITR lock recovery. If the previous platform-api
      // process died mid-restore, the persisted lock row in
      // platform_settings tells us so — emit a sticky admin
      // notification with enough context to recover by hand, then
      // clear the lock so writes are not blocked forever. Also
      // best-effort cleans up leftover temp PITR clusters (identified
      // by the platform.phoenix-host.net/pitr-restore=true label) so
      // they don't pin Longhorn volumes.
      try {
        const { recoverInterruptedRestore } = await import('./modules/postgres-restore/service.js');
        const { createK8sClients } = await import('./modules/k8s-provisioner/k8s-client.js');
        const cfg = app.config as Record<string, unknown>;
        const kubeconfigPath = cfg.KUBECONFIG_PATH as string | undefined;
        const k8s = createK8sClients(kubeconfigPath);
        await recoverInterruptedRestore(app.db, k8s);
      } catch (err) {
        app.log.error({ err }, 'PITR interrupted-restore recovery failed at startup');
      }

      // Reconcile platform-ingress hosts from the DB-configured panel URLs.
      // Kustomize overlays no longer hardcode spec.rules/tls — platform-api
      // owns them via server-side apply. On every startup we sync the live
      // Ingress with whatever URLs are currently in system_settings so
      // restarts and redeploys converge to the desired state.
      try {
        const { getSettings } = await import('./modules/system-settings/service.js');
        const { reconcileIngressHosts } = await import('./modules/system-settings/ingress-reconciler.js');
        const { getGlobalSettings: getOidcSettings } = await import('./modules/oidc/service.js');
        const [settings, oidc] = await Promise.all([
          getSettings(app.db),
          getOidcSettings(app.db),
        ]);
        const cfg = app.config as Record<string, unknown>;
        const kubeconfigPath = cfg.KUBECONFIG_PATH as string | undefined;
        const tlsSecretName = (cfg.PLATFORM_TLS_SECRET_NAME as string | undefined)?.trim() || 'platform-tls';
        const clusterIssuerName = cfg.CLUSTER_ISSUER_NAME as string | undefined;
        const result = await reconcileIngressHosts(
          {
            adminPanelUrl: settings.adminPanelUrl ?? null,
            clientPanelUrl: settings.clientPanelUrl ?? null,
            tlsSecretName,
            protectAdminViaProxy: oidc.protectAdminViaProxy,
            protectClientViaProxy: oidc.protectClientViaProxy,
          },
          undefined,
          { kubeconfigPath, clusterIssuerName },
        );
        if (result.changed) {
          app.log.info(
            { adminPanelUrl: settings.adminPanelUrl, clientPanelUrl: settings.clientPanelUrl },
            'startup: ingress hosts reconciled from DB',
          );
        }
      } catch (err) {
        app.log.warn({ err }, 'startup: ingress host reconcile skipped (k8s unavailable)');
      }

      // PR 2 (network-access two-tier): re-reconcile every client
      // ResourceQuota on boot to ensure the new scopeSelector + plan-
      // exact limits are in place. Idempotent — quotas already in the
      // target shape are no-ops. Best-effort: failure of this hook
      // does NOT abort startup; per-client errors are logged.
      // Fire-and-forget: boot-time quota reconciliation walks every
      // client and round-trips the k8s API once per row. With 30+
      // clients that easily exceeds Fastify's 60s onReady timeout
      // and starves the readiness probe → CrashLoopBackOff. Kick it
      // off async so the API comes up immediately; the reconciler
      // logs scanned/reconciled/errors when it finishes.
      void (async () => {
        try {
          const { createK8sClients: createK8s } = await import('./modules/k8s-provisioner/k8s-client.js');
          const { reconcileAllClientQuotas } = await import('./modules/k8s-provisioner/quota-reconciler.js');
          const quotaK8s = createK8s((app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined);
          await reconcileAllClientQuotas(app.db, quotaK8s, app.log);
        } catch (err) {
          app.log.warn({ err }, 'startup: quota reconcile skipped (k8s unavailable)');
        }
      })();

      const webcronTimer = startWebcronScheduler(app.db);
      app.addHook('onClose', () => clearInterval(webcronTimer));

      const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
      const cleanupTimer = startIdleCleanup(kubeconfigPath);
      if (cleanupTimer) {
        app.addHook('onClose', () => clearInterval(cleanupTimer));
      }

      const metricsTimer = startMetricsScheduler(app.db);
      app.addHook('onClose', () => clearInterval(metricsTimer));

      // Phase 3.D.2: mailbox used_mb reconciliation (15 min default,
      // configurable via platform_settings key
      // `mailbox_usage_sync_interval_minutes`)
      const mailStatsTimer = startMailStatsScheduler(app.db);
      // Phase 3 T5.3: stop function halts the self-rescheduling
      // chain — plain clearInterval is not enough because the
      // chain re-arms itself.
      app.addHook('onClose', () => stopMailStatsScheduler(mailStatsTimer));

      // Storage lifecycle: snapshot expiry + weekly audit report.
      // Needs a K8sClients handle for the audit path (`du -sb` exec
      // into each tenant's file-manager sidecar).
      try {
        const { createK8sClients: createK8s } = await import('./modules/k8s-provisioner/k8s-client.js');
        const storageK8s = createK8s(kubeconfigPath);
        const storageLifecycleHandle = startStorageLifecycleScheduler(app.db, storageK8s, app.config as Record<string, unknown>);
        app.addHook('onClose', () => storageLifecycleHandle.stop());

        // Phase 5: lifecycle-hook retry tick. Drains failed
        // client_lifecycle_hook_runs rows whose next_attempt_at has
        // passed. Per-hook circuit-breaker bounded in-memory.
        const { startLifecycleHookRetryScheduler } = await import('./modules/client-lifecycle/scheduler.js');
        const lifecycleRetryStop = startLifecycleHookRetryScheduler(app.db, storageK8s);
        app.addHook('onClose', () => lifecycleRetryStop());
      } catch (err) {
        app.log.warn({ err }, 'storage-lifecycle / lifecycle-retry scheduler: startup skipped');
      }

      // Tenant Backup retention sweeper — deletes expired bundles
      // on the off-site target + GCs stuck `running` bundles older
      // than 24h. 5-min tick; first sweep fires immediately.
      try {
        const retentionTimer = startRetentionScheduler(app);
        app.addHook('onClose', () => clearInterval(retentionTimer));
      } catch (err) {
        app.log.warn({ err }, 'tenant-backup retention: scheduler startup skipped');
      }

      // Tenant Backup Tier-1 scheduler — fans out scheduled bundles
      // for clients whose client_backup_schedules.last_run_at is
      // older than the configured frequency (daily/weekly/monthly).
      // Cross-replica CAS via UPDATE ... RETURNING serialises ticks.
      try {
        const scheduleTimer = startBackupScheduleTick(app);
        app.addHook('onClose', () => clearInterval(scheduleTimer));
      } catch (err) {
        app.log.warn({ err }, 'tenant-backup schedule: scheduler startup skipped');
      }

      // System Backup sweeper (Phase 2.4c) — orphan-pending flip
      // (>10 min) + 90-day retention purge of failed pg_dump rows.
      try {
        const { startSystemBackupSweeper } = await import('./modules/system-backup/sweeper.js');
        const sweepStop = startSystemBackupSweeper(app.db, app.log as unknown as {
          info: (...a: unknown[]) => void;
          warn: (...a: unknown[]) => void;
          error: (...a: unknown[]) => void;
        });
        app.addHook('onClose', () => sweepStop());
      } catch (err) {
        app.log.warn({ err }, 'system-backup sweeper: scheduler startup skipped');
      }

      // System Backup pg_dump scheduler (Phase 4b slice 2) — runs
      // due rows from system_pg_dump_schedules; reuses the same
      // pg-dump-job-spawner the manual UI uses.
      try {
        const { startPgDumpScheduler } = await import('./modules/system-backup/pg-dump-scheduler.js');
        const k8s = (await import('./modules/k8s-provisioner/k8s-client.js')).createK8sClients();
        const pgDumpSchedStop = startPgDumpScheduler(app.db, k8s, app.log as unknown as {
          info: (...a: unknown[]) => void;
          warn: (...a: unknown[]) => void;
          error: (...a: unknown[]) => void;
        });
        app.addHook('onClose', () => pgDumpSchedStop());
      } catch (err) {
        app.log.warn({ err }, 'system-backup pg-dump scheduler: startup skipped');
      }

      // M12: DKIM rotation scheduler removed. Stalwart 0.16 manages DKIM
      // key generation and rotation natively. Platform now reads DKIM
      // status read-only from Stalwart's dnsZoneFile via JMAP.

      // Stalwart 0.16 principals-sync: reconciles platform mailbox +
      // email_domain mirror rows against Stalwart's JMAP principal store.
      // Disabled by STALWART_PRINCIPALS_SYNC_DISABLE=true.
      if (process.env.STALWART_PRINCIPALS_SYNC_DISABLE !== 'true') {
        const principalsSyncHandle = createPrincipalsSyncScheduler(app.db);
        principalsSyncHandle.start();
        app.addHook('onClose', () => { principalsSyncHandle.stop(); });
      }

      // Phase 3 T2.1: IMAPSync reconciler. Polls active K8s Jobs
      // and writes terminal status + log tail back to the DB.
      // Round-4 Phase 2: also start the webmail cert reconciler so
      // pending Certificates promote to ready as cert-manager
      // catches up.
      try {
        const { createK8sClients } = await import('./modules/k8s-provisioner/k8s-client.js');
        const kubePath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
        const k8sForImapsync = createK8sClients(kubePath);
        const imapsyncTimer = startImapSyncReconciler(app.db, k8sForImapsync);
        app.addHook('onClose', () => clearInterval(imapsyncTimer));

        const { startWebmailReconciler, stopWebmailReconciler } = await import(
          './modules/email-domains/webmail-reconciler.js'
        );
        const webmailReconTimer = startWebmailReconciler(app.db, k8sForImapsync);
        app.addHook('onClose', () => stopWebmailReconciler(webmailReconTimer));

        // M1: node-role taxonomy. Upserts cluster_nodes from k8s every
        // 60s. Shares the same k8s client instance as mail reconcilers
        // to avoid re-reading the kubeconfig. Stops cleanly on app
        // close.
        const nodeSyncHandle = startNodeSyncReconciler(app.db, k8sForImapsync);
        app.addHook('onClose', () => nodeSyncHandle.stop());

        // Issue 3 fix: per-node Calico + Longhorn CSI health watcher.
        // Emits an admin notification on regression / recovery so a
        // worker that joined but never reached Ready surfaces in the
        // bell icon, not just on the Cluster Nodes page.
        const { startNodeHealthReconciler } = await import('./modules/cluster-health/scheduler.js');
        const nodeHealthHandle = startNodeHealthReconciler(app.db, k8sForImapsync);
        app.addHook('onClose', () => nodeHealthHandle.stop());

        // M13: storage-policy advisor — emit a one-time admin
        // notification when the cluster reaches >=3 Ready servers
        // and policy is still on 'local'. Idempotent across restarts
        // via platform_storage_policy.ha_recommendation_notified_at.
        const { startStoragePolicyAdvisor } = await import('./modules/platform-storage-policy/scheduler.js');
        const storageAdvisorHandle = startStoragePolicyAdvisor(app.db, k8sForImapsync);
        app.addHook('onClose', () => storageAdvisorHandle.stop());

        // Cluster-storage capacity reconciler — 5-min tick that emits
        // admin notifications when any node OR the cluster as a whole
        // crosses 80 % (warning) or 95 % (critical) commitPct. Catches
        // the failure mode where new client provisioning / Apply HA
        // scale-up SILENTLY fails because Longhorn precheck rejects
        // ("insufficient storage") before the operator notices the
        // cluster filled up.
        const { startCapacityReconciler } = await import('./modules/platform-storage-policy/capacity-reconciler.js');
        const capacityReconcilerHandle = startCapacityReconciler(app.db, k8sForImapsync);
        app.addHook('onClose', () => capacityReconcilerHandle.stop());

        // System pod placement: pin Helm-installed singletons (Longhorn
        // CSI controllers, Calico typha + kube-controllers, Longhorn UI)
        // to server-role nodes, scale Calico typha with HA size, and
        // assert 10 % storageReserved on every worker disk so new
        // workers automatically get the lower reserve.
        const { startSystemPodPlacement } = await import('./modules/system-pod-placement/scheduler.js');
        const systemPodPlacementHandle = startSystemPodPlacement(app.db, k8sForImapsync);
        app.addHook('onClose', () => systemPodPlacementHandle.stop());

        // Backup-health: watches Jobs cluster-wide via the
        // platform.phoenix-host.net/backup-health-watch=true label and
        // emits one notification per failed Job UID. Routes admin or
        // client_admin recipients per the optional client-id label.
        const { startBackupHealthScheduler } = await import('./modules/backup-health/scheduler.js');
        const backupHealthStop = startBackupHealthScheduler({
          db: app.db,
          batch: k8sForImapsync.batch,
        });
        app.addHook('onClose', () => backupHealthStop());
      } catch (err) {
        app.log.warn({ err }, 'mail-imapsync: scheduler not started — k8s client unavailable');
      }

      // Periodic deployment status reconciler — detects crashes, OOM, CrashLoopBackOff
      const reconcileInterval = setInterval(async () => {
        try {
          const kubePath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
          const { createK8sClients } = await import('./modules/k8s-provisioner/k8s-client.js');
          const { reconcileDeploymentStatuses } = await import('./modules/deployments/status-reconciler.js');
          const k8s = createK8sClients(kubePath);
          await reconcileDeploymentStatuses(app.db, k8s);
        } catch (err) {
          app.log.warn({ err }, 'Deployment status reconciliation failed — skipping cycle');
        }
      }, 15_000); // Every 15 seconds
      app.addHook('onClose', () => clearInterval(reconcileInterval));

      // Periodic certificate status reconciler — syncs cert-manager TLS
      // Secret metadata into the ssl_certificates DB table so the UI can
      // display real cert status without live K8s queries on every page load.
      const certReconcileInterval = setInterval(async () => {
        try {
          const kubePath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
          const { createK8sClients } = await import('./modules/k8s-provisioner/k8s-client.js');
          const { reconcileCertificateStatuses } = await import('./modules/certificates/cert-reconciler.js');
          const k8s = createK8sClients(kubePath);
          const result = await reconcileCertificateStatuses(app.db, k8s);
          if (result.synced > 0) {
            app.log.info(`Certificate reconciler: synced ${result.synced}/${result.checked}`);
          }
          if (result.errors.length > 0) {
            app.log.warn({ errors: result.errors }, 'Certificate reconciler had errors');
          }
        } catch (err) {
          app.log.warn({ err }, 'Certificate reconciler failed — skipping cycle');
        }
      }, 60_000); // Every 60 seconds
      app.addHook('onClose', () => clearInterval(certReconcileInterval));

      // WAF log scraper — reads ModSecurity events from NGINX Ingress Controller logs
      try {
        const kubePath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
        const { createK8sClients: createK8sForWaf } = await import('./modules/k8s-provisioner/k8s-client.js');
        const k8sForWaf = createK8sForWaf(kubePath);
        if (k8sForWaf) {
          const { startWafLogScraper } = await import('./modules/ingress-routes/waf-log-scraper.js');
          const wafScraperTimer = startWafLogScraper(app.db, k8sForWaf);
          app.addHook('onClose', () => clearInterval(wafScraperTimer));
        }
      } catch (err) {
        app.log.warn({ err }, 'WAF log scraper not started');
      }

      // Daily prune of expired refresh tokens (Phase 3 split-token auth).
      // Keeps a 7-day forensic window after expiry; older rows are
      // hard-deleted to keep the table small. Failure is non-fatal.
      const refreshPruneInterval = setInterval(async () => {
        try {
          const { pruneExpiredRefreshTokens } = await import('./modules/auth/refresh-token-service.js');
          const removed = await pruneExpiredRefreshTokens(app.db);
          if (removed > 0) app.log.info(`refresh-token-prune: removed ${removed} expired rows`);
        } catch (err) {
          app.log.warn({ err }, 'refresh-token-prune failed — will retry tomorrow');
        }
      }, 24 * 60 * 60 * 1000); // 24h
      app.addHook('onClose', () => clearInterval(refreshPruneInterval));

      // Hourly prune of expired passkey challenges + consumed tokens.
      // Both have 5-min TTL so the table grows fast under sustained
      // login traffic — hourly is plenty. Failure is non-fatal.
      const passkeyPruneInterval = setInterval(async () => {
        try {
          const { pruneExpiredChallenges, pruneExpiredConsumedTokens } = await import('./modules/auth/passkey-service.js');
          const ch = await pruneExpiredChallenges(app.db);
          const tk = await pruneExpiredConsumedTokens(app.db);
          if (ch > 0 || tk > 0) {
            app.log.info(`passkey-prune: removed ${ch} challenges + ${tk} consumed tokens`);
          }
        } catch (err) {
          app.log.warn({ err }, 'passkey-prune failed — will retry next hour');
        }
      }, 60 * 60 * 1000); // 1h
      app.addHook('onClose', () => clearInterval(passkeyPruneInterval));

      // Phase 3 — disk-pressure image watcher + Phase 2 kubelet-GC drift
      // detector. Both share a k8s client. Failures are non-fatal.
      try {
        const { createK8sClients: createK8sForWatcher } = await import('./modules/k8s-provisioner/k8s-client.js');
        const watcherKubePath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
        const watcherK8s = createK8sForWatcher(watcherKubePath);

        const pressureWatcher = startImagePressureWatcher(app.db, watcherK8s, app.log);
        app.addHook('onClose', () => pressureWatcher.stop());

        const gcReconciler = startKubeletGcReconciler(app.db, watcherK8s, app.log);
        app.addHook('onClose', () => gcReconciler.stop());
      } catch (err) {
        app.log.warn({ err }, 'image-pressure-watcher / kubelet-gc-reconciler: startup skipped');
      }

      // Domain verification cron — hourly DNS re-check with regression notifications.
      // Does not require k8s clients; uses only DB + DNS resolution.
      //
      // Register the onClose hook SYNCHRONOUSLY with a closure that captures
      // the handle as it resolves — `addHook` after the server starts
      // listening throws FST_ERR_INSTANCE_ALREADY_LISTENING, which is what
      // happened on the first staging deploy of this feature.
      let verificationCronHandle: { stop: () => void } | null = null;
      app.addHook('onClose', () => verificationCronHandle?.stop());
      void startVerificationCron(app.db, app.log).then((handle) => {
        verificationCronHandle = handle;
      }).catch((err) => {
        app.log.warn({ err }, 'verification-cron: startup failed');
      });

      // Auto-sync: fire a one-time catalog sync for every active repo that has
      // never been synced (last_synced_at IS NULL). This ensures that on a
      // fresh bootstrap the default catalog repo (seeded by db/seed.ts) is
      // populated without requiring an operator to trigger a manual sync.
      //
      // Safe with multiple platform-api replicas: syncCatalogRepo marks the
      // repo as "syncing" immediately and the underlying upsert is idempotent,
      // so concurrent runs are harmless (they just duplicate work).
      //
      // Fire-and-forget — errors land in the repo's last_error column and are
      // visible in the admin Catalog UI. Never crash the startup path.
      void (async () => {
        try {
          const { autoSyncUnsyncedRepos } = await import('./modules/catalog/service.js');
          const queued = await autoSyncUnsyncedRepos(app.db);
          if (queued > 0) {
            app.log.info(`[catalog-auto-sync] Queued initial sync for ${queued} unsynced repo(s)`);
          }
        } catch (err) {
          app.log.warn({ err }, '[catalog-auto-sync] startup hook failed');
        }
      })();

      app.addHook('onClose', async () => { await closeRedis(); });
    });
  }

  return app;
}
