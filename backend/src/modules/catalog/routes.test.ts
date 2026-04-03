import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';

const mockCatalogEntry = {
  id: 'ce-1',
  code: 'wordpress',
  name: 'WordPress',
  type: 'application',
  version: '6.5',
  description: 'Popular CMS',
  category: 'cms',
  featured: 0,
  popular: 0,
  status: 'available',
  tags: '["cms","php"]',
  components: null,
  networking: null,
  volumes: null,
  resources: null,
  healthCheck: null,
  parameters: null,
  tenancy: null,
  services: null,
  provides: null,
  envVars: null,
  sourceRepoId: 'repo-1',
  manifestUrl: 'https://example.com/wordpress/manifest.json',
  url: null,
  documentation: null,
  createdAt: new Date('2026-01-01'),
};

// Track updates for assertions
let lastUpdateSet: Record<string, unknown> | null = null;

const mockDb = {
  select: vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockImplementation(() => {
        return Promise.resolve([{ ...mockCatalogEntry, featured: lastUpdateSet?.featured ?? 0, popular: lastUpdateSet?.popular ?? 0 }]);
      }),
      orderBy: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([]),
      }),
    }),
  }),
  update: vi.fn().mockReturnValue({
    set: vi.fn().mockImplementation((values: Record<string, unknown>) => {
      lastUpdateSet = values;
      return {
        where: vi.fn().mockResolvedValue(undefined),
      };
    }),
  }),
  insert: vi.fn().mockReturnValue({
    values: vi.fn().mockResolvedValue(undefined),
  }),
  delete: vi.fn().mockReturnValue({
    where: vi.fn().mockResolvedValue(undefined),
  }),
};

const { catalogRoutes } = await import('./routes.js');

describe('catalog badge routes', () => {
  let app: FastifyInstance;
  let adminToken: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);
    app.decorate('db', mockDb);
    await app.register(catalogRoutes, { prefix: '/api/v1' });
    await app.ready();

    adminToken = app.jwt.sign({ sub: 'u1', role: 'super_admin', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
  });

  afterAll(async () => {
    await app.close();
  });

  it('PATCH /admin/catalog/:id/badges returns 200 with updated entry', async () => {
    lastUpdateSet = null;
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/catalog/ce-1/badges',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { featured: true, popular: false },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toBeDefined();
    expect(body.data.id).toBe('ce-1');
  });

  it('PATCH /admin/catalog/:id/badges returns 401 without auth', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/catalog/ce-1/badges',
      payload: { featured: true },
    });

    expect(res.statusCode).toBe(401);
  });
});
