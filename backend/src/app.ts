import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCors from '@fastify/cors';
import fastifyCompress from '@fastify/compress';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import { errorHandler } from './middleware/error-handler.js';
import { registerAuditHook } from './middleware/audit.js';
import { registerRateLimit } from './middleware/rate-limit.js';
import { registerAuth } from './middleware/auth.js';
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
import { containerImageRoutes } from './modules/container-images/routes.js';
import { dashboardRoutes } from './modules/dashboard/routes.js';
import { auditLogRoutes } from './modules/audit-logs/routes.js';
import { workloadRepoRoutes } from './modules/workload-repos/routes.js';
import { applicationRepoRoutes } from './modules/application-repos/routes.js';
import { applicationUpgradeRoutes } from './modules/application-upgrades/routes.js';
import { workloadRoutes } from './modules/workloads/routes.js';
import { dnsRecordRoutes } from './modules/dns-records/routes.js';
import { hostingSettingsRoutes } from './modules/hosting-settings/routes.js';
import { protectedDirectoryRoutes } from './modules/protected-directories/routes.js';
import { sshKeyRoutes } from './modules/ssh-keys/routes.js';
import { resourceQuotaRoutes } from './modules/resource-quotas/routes.js';
import { oidcRoutes } from './modules/oidc/routes.js';
import { dnsServerRoutes } from './modules/dns-servers/routes.js';
import { k8sManifestRoutes } from './modules/k8s-manifests/routes.js';
import { notificationRoutes } from './modules/notifications/routes.js';
import { backupConfigRoutes } from './modules/backup-config/routes.js';
import { adminUserRoutes } from './modules/admin-users/routes.js';
import { healthRoutes } from './modules/health/routes.js';
import { exportImportRoutes } from './modules/export-import/routes.js';
import { emailDomainRoutes } from './modules/email-domains/routes.js';
import { mailboxRoutes } from './modules/mailboxes/routes.js';
import { emailAliasRoutes } from './modules/email-aliases/routes.js';
import { smtpRelayRoutes } from './modules/smtp-relay/routes.js';
import { platformUpdateRoutes } from './modules/platform-updates/routes.js';
import { sslCertRoutes } from './modules/ssl-certs/routes.js';
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

  // Health check
  app.get('/api/v1/admin/status', {
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
                status: { type: 'string', enum: ['healthy'] },
                timestamp: { type: 'string', format: 'date-time' },
                version: { type: 'string' },
              },
            },
          },
        },
      },
    },
  }, async () => ({
    data: {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: '0.1.0',
    },
  }));

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
  await app.register(containerImageRoutes, { prefix: '/api/v1' });
  await app.register(dashboardRoutes, { prefix: '/api/v1' });
  await app.register(auditLogRoutes, { prefix: '/api/v1' });
  await app.register(workloadRepoRoutes, { prefix: '/api/v1' });
  await app.register(applicationRepoRoutes, { prefix: '/api/v1' });
  await app.register(applicationUpgradeRoutes, { prefix: '/api/v1' });
  await app.register(workloadRoutes, { prefix: '/api/v1' });
  await app.register(dnsRecordRoutes, { prefix: '/api/v1' });
  await app.register(hostingSettingsRoutes, { prefix: '/api/v1' });
  await app.register(protectedDirectoryRoutes, { prefix: '/api/v1' });
  await app.register(sshKeyRoutes, { prefix: '/api/v1' });
  await app.register(resourceQuotaRoutes, { prefix: '/api/v1' });
  await app.register(oidcRoutes, { prefix: '/api/v1' });
  await app.register(dnsServerRoutes, { prefix: '/api/v1' });
  await app.register(k8sManifestRoutes, { prefix: '/api/v1' });
  await app.register(notificationRoutes, { prefix: '/api/v1' });
  await app.register(backupConfigRoutes, { prefix: '/api/v1' });
  await app.register(adminUserRoutes, { prefix: '/api/v1' });
  await app.register(healthRoutes, { prefix: '/api/v1' });
  await app.register(exportImportRoutes, { prefix: '/api/v1' });
  await app.register(emailDomainRoutes, { prefix: '/api/v1' });
  await app.register(mailboxRoutes, { prefix: '/api/v1' });
  await app.register(emailAliasRoutes, { prefix: '/api/v1' });
  await app.register(smtpRelayRoutes, { prefix: '/api/v1' });
  await app.register(platformUpdateRoutes, { prefix: '/api/v1' });
  await app.register(sslCertRoutes, { prefix: '/api/v1' });

  return app;
}
