import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCors from '@fastify/cors';
import { errorHandler } from './middleware/error-handler.js';
import { registerAuditHook } from './middleware/audit.js';
import { registerRateLimit } from './middleware/rate-limit.js';
import { registerAuth } from './middleware/auth.js';
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
import type { Config } from './config/index.js';
import type { Database } from './db/index.js';

export interface AppDependencies {
  readonly config: Config;
  readonly db: Database;
}

declare module 'fastify' {
  interface FastifyInstance {
    db: Database;
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
  await app.register(fastifyCors, { origin: true });
  await app.register(fastifyJwt, { secret: deps.config.JWT_SECRET });
  await registerRateLimit(app);

  // Decorate
  app.decorate('db', deps.db);
  registerAuth(app);

  // Error handler
  app.setErrorHandler(errorHandler);

  // Audit logging (fire-and-forget on mutations)
  registerAuditHook(app, deps.db);

  // Health check
  app.get('/api/v1/admin/status', async () => ({
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

  return app;
}
