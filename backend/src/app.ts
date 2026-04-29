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
import { fileManagerRoutes } from './modules/file-manager/routes.js';
import { storageLifecycleRoutes } from './modules/storage-lifecycle/routes.js';
import { notificationRoutes } from './modules/notifications/routes.js';
import { backupConfigRoutes } from './modules/backup-config/routes.js';
import { adminUserRoutes } from './modules/admin-users/routes.js';
import { healthRoutes } from './modules/health/routes.js';
import { exportImportRoutes } from './modules/export-import/routes.js';
import { emailDomainRoutes } from './modules/email-domains/routes.js';
import { emailDkimRoutes } from './modules/email-dkim/routes.js';
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
import { startDkimScheduler } from './modules/email-dkim/scheduler.js';
import { startImapSyncReconciler } from './modules/mail-imapsync/scheduler.js';
import { startNodeSyncReconciler } from './modules/nodes/scheduler.js';
import { getRedis, closeRedis } from './shared/redis.js';
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
  const app = Fastify({
    logger: deps.config.NODE_ENV !== 'test' && {
      level: deps.config.LOG_LEVEL,
    },
    genReqId: () => crypto.randomUUID(),
    bodyLimit: 50 * 1024 * 1024, // 50MB for SQL imports
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
  await app.register(fileManagerRoutes, { prefix: '/api/v1' });
  await app.register(notificationRoutes, { prefix: '/api/v1' });
  await app.register(backupConfigRoutes, { prefix: '/api/v1' });
  await app.register(adminUserRoutes, { prefix: '/api/v1' });
  await app.register(healthRoutes, { prefix: '/api/v1' });
  await app.register(exportImportRoutes, { prefix: '/api/v1' });
  await app.register(emailDomainRoutes, { prefix: '/api/v1' });
  await app.register(emailDkimRoutes, { prefix: '/api/v1' });
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
      try {
        const { createK8sClients: createK8s } = await import('./modules/k8s-provisioner/k8s-client.js');
        const { reconcileAllClientQuotas } = await import('./modules/k8s-provisioner/quota-reconciler.js');
        const quotaK8s = createK8s((app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined);
        await reconcileAllClientQuotas(app.db, quotaK8s, app.log);
      } catch (err) {
        app.log.warn({ err }, 'startup: quota reconcile skipped (k8s unavailable)');
      }

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
      } catch (err) {
        app.log.warn({ err }, 'storage-lifecycle scheduler: startup skipped');
      }

      // Phase 3 T1.1: DKIM rotation scheduler. Auto-rotates primary-mode
      // email domains, retires old keys after the grace period, and
      // purges retired keys after the retention period.
      const dkimEncKey = process.env.OIDC_ENCRYPTION_KEY ?? '0'.repeat(64);
      const dkimTimer = startDkimScheduler(app.db, dkimEncKey);
      app.addHook('onClose', () => clearInterval(dkimTimer));

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

      app.addHook('onClose', async () => { await closeRedis(); });
    });
  }

  return app;
}
