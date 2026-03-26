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

  it('should return image objects with expected fields', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/container-images' });
    const body = res.json();
    const image = body.data[0];
    expect(image).toHaveProperty('id');
    expect(image).toHaveProperty('code');
    expect(image).toHaveProperty('name');
    expect(image).toHaveProperty('imageType');
    expect(image).toHaveProperty('registryUrl');
    expect(image).toHaveProperty('supportedVersions');
    expect(image).toHaveProperty('status');
  });

  it('should return images with correct status', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/container-images' });
    const body = res.json();
    for (const image of body.data) {
      expect(image.status).toBe('active');
    }
  });
});

