import type { FastifyInstance } from 'fastify';
import fastifyRateLimit from '@fastify/rate-limit';

interface RateLimitOptions {
  max?: number;
  timeWindow?: string;
}

export async function registerRateLimit(
  app: FastifyInstance,
  options?: RateLimitOptions,
): Promise<void> {
  if (process.env.DISABLE_RATE_LIMIT === 'true') {
    app.log.info('Rate limiting disabled via DISABLE_RATE_LIMIT env var');
    return;
  }

  await app.register(fastifyRateLimit, {
    max: options?.max ?? 100,
    timeWindow: options?.timeWindow ?? '1 minute',
    keyGenerator: (request) => {
      // Use authenticated user ID if available, otherwise IP
      const user = (request as unknown as { user?: { sub: string } }).user;
      return user?.sub ?? request.ip;
    },
    errorResponseBuilder: (_request, context) => {
      return {
        statusCode: 429,
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: `Too many requests. Please retry after ${Math.ceil(context.ttl / 1000)} seconds`,
          status: 429,
          timestamp: new Date().toISOString(),
          details: { retry_after: Math.ceil(context.ttl / 1000) },
          remediation: 'Implement exponential backoff and retry',
        },
      };
    },
  });
}
