import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCors from '@fastify/cors';
import fastifyCompress from '@fastify/compress';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import { errorHandler } from './middleware/error-handler.js';
import { registerAuditHook } from './middleware/audit.js';
import { registerRateLimit } from './middleware/rate-limit.js';
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
import { resourceQuotaRoutes } from './modules/resource-quotas/routes.js';
import { oidcRoutes } from './modules/oidc/routes.js';
import { dnsServerRoutes } from './modules/dns-servers/routes.js';
import { k8sManifestRoutes } from './modules/k8s-manifests/routes.js';
import { provisioningRoutes } from './modules/k8s-provisioner/routes.js';
import { fileManagerRoutes } from './modules/file-manager/routes.js';
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
import { platformUpdateRoutes } from './modules/platform-updates/routes.js';
import { sslCertRoutes } from './modules/ssl-certs/routes.js';
import { eolScannerRoutes } from './modules/eol-scanner/routes.js';
import { tlsSettingsRoutes } from './modules/tls-settings/routes.js';
import { ingressRouteRoutes } from './modules/ingress-routes/routes.js';
import { sqliteRoutes } from './modules/sqlite/routes.js';
import { startWebcronScheduler } from './modules/cron-jobs/scheduler.js';
import { startIdleCleanup } from './modules/file-manager/idle-cleanup.js';
import { startMetricsScheduler } from './modules/metrics/metrics-scheduler.js';
import { startMailStatsScheduler, stopMailStatsScheduler } from './modules/mail-stats/scheduler.js';
import { startDkimScheduler } from './modules/email-dkim/scheduler.js';
import { startImapSyncReconciler } from './modules/mail-imapsync/scheduler.js';
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
  await app.register(fastifyJwt, { secret: deps.config.JWT_SECRET });
  await registerRateLimit(app);

  // Decorate
  app.decorate('db', deps.db);
  app.decorate('config', deps.config);
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
  await app.register(resourceQuotaRoutes, { prefix: '/api/v1' });
  await app.register(oidcRoutes, { prefix: '/api/v1' });
  await app.register(dnsServerRoutes, { prefix: '/api/v1' });
  await app.register(k8sManifestRoutes, { prefix: '/api/v1' });
  await app.register(provisioningRoutes, { prefix: '/api/v1' });
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
  await app.register(platformUpdateRoutes, { prefix: '/api/v1' });
  await app.register(sslCertRoutes, { prefix: '/api/v1' });
  await app.register(eolScannerRoutes, { prefix: '/api/v1' });
  await app.register(tlsSettingsRoutes, { prefix: '/api/v1' });
  await app.register(ingressRouteRoutes, { prefix: '/api/v1' });
  await app.register(sqliteRoutes, { prefix: '/api/v1' });

  // Start background schedulers (skip in test environment)
  if (deps.config.NODE_ENV !== 'test') {
    app.addHook('onReady', async () => {
      // Connect Redis eagerly on startup
      try {
        await getRedis().connect();
      } catch (err) {
        console.warn('[redis] Failed to connect on startup:', err instanceof Error ? err.message : String(err));
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
        } catch {
          // K8s not available — skip this cycle
        }
      }, 15_000); // Every 15 seconds
      app.addHook('onClose', () => clearInterval(reconcileInterval));

      app.addHook('onClose', async () => { await closeRedis(); });
    });
  }

  return app;
}
