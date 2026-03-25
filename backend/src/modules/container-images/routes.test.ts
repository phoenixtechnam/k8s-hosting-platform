import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';
import { containerImageRoutes } from './routes.js';

const mockImages = [
  {
    id: 'img-1',
    code: 'nginx',
    name: 'NGINX',
    imageType: 'webserver',
    registryUrl: 'ghcr.io/hosting/nginx:1.25',
    digest: null,
    supportedVersions: ['1.25', '1.24'],
    status: 'active',
    createdAt: new Date('2026-01-01'),
  },
  {
    id: 'img-2',
    code: 'php-fpm',
    name: 'PHP-FPM',
    imageType: 'runtime',
    registryUrl: 'ghcr.io/hosting/php-fpm:8.3',
    digest: null,
    supportedVersions: ['8.3', '8.2'],
    status: 'active',
    createdAt: new Date('2026-01-01'),
  },
];

describe('container-images routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);

    // Stub db with a chainable select mock
    const mockDb = {
      select: () => ({
        from: () => Promise.resolve(mockImages),
      }),
    };
    app.decorate('db', mockDb);

    await app.register(containerImageRoutes, { prefix: '/api/v1' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/v1/container-images should return 200', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/container-images' });
    expect(res.statusCode).toBe(200);
  });

  it('should return a data array', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/container-images' });
    const body = res.json();
    expect(body.data).toBeDefined();
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('should return container image objects', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/container-images' });
    const body = res.json();
    expect(body.data).toHaveLength(2);
    expect(body.data[0]).toHaveProperty('code', 'nginx');
    expect(body.data[1]).toHaveProperty('code', 'php-fpm');
  });

  it('should not require authentication', async () => {
    // No Authorization header — should still succeed
    const res = await app.inject({ method: 'GET', url: '/api/v1/container-images' });
    expect(res.statusCode).toBe(200);
  });
});

describe('container-images routes (fallback path)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);

    let callCount = 0;
    const fallbackImages = [
      {
        id: 'img-1',
        code: 'nginx',
        name: 'NGINX',
        imageType: 'webserver',
        registryUrl: 'ghcr.io/hosting/nginx:1.25',
        digest: null,
        supportedVersions: ['1.25'],
        status: 'active',
        createdAt: new Date('2026-01-01'),
      },
    ];

    // First select().from() throws to trigger the fallback path
    const mockDb = {
      select: (columns?: Record<string, unknown>) => ({
        from: () => {
          callCount++;
          if (callCount === 1 && !columns) {
            throw new Error('migration 0002 columns missing');
          }
          return Promise.resolve(fallbackImages);
        },
      }),
    };
    app.decorate('db', mockDb);

    await app.register(containerImageRoutes, { prefix: '/api/v1' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('should fall back to core columns when full query fails', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/container-images' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toBeDefined();
    expect(Array.isArray(body.data)).toBe(true);
  });
});
