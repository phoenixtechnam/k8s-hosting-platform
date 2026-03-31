import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';

// Chainable DB mock
const mockDbResult: unknown[] = [];
const chainable = (): Record<string, unknown> => ({
  select: () => chainable(),
  from: () => chainable(),
  where: () => chainable(),
  orderBy: () => chainable(),
  limit: () => Promise.resolve(mockDbResult),
  insert: () => ({ values: () => Promise.resolve() }),
  update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  delete: () => ({ where: () => Promise.resolve() }),
  then: (resolve: (v: unknown) => void) => resolve(mockDbResult),
});

vi.mock('./service.js', () => ({
  validateUpgradeRequest: vi.fn().mockReturnValue({ valid: true }),
  getAvailableUpgradesForInstance: vi.fn().mockReturnValue([]),
  createUpgradeRecord: vi.fn().mockReturnValue({
    id: 'upg-1',
    instanceId: 'inst-1',
    fromVersion: '1.0.0',
    toVersion: '2.0.0',
    status: 'pending',
    triggeredBy: 'admin-1',
    triggerType: 'manual',
    progressPct: 0,
    statusMessage: null,
    errorMessage: null,
    createdAt: new Date('2026-01-01').toISOString(),
  }),
}));

// Mock drizzle-orm operators used by routes
vi.mock('drizzle-orm', () => ({
  eq: vi.fn().mockReturnValue({}),
  and: vi.fn().mockReturnValue({}),
  inArray: vi.fn().mockReturnValue({}),
  desc: vi.fn().mockReturnValue({}),
}));

// Mock db/schema.js table references
vi.mock('../../db/schema.js', () => ({
  applicationInstances: {
    id: 'id',
    clientId: 'clientId',
    applicationCatalogId: 'applicationCatalogId',
    installedVersion: 'installedVersion',
    targetVersion: 'targetVersion',
    createdAt: 'createdAt',
  },
  applicationVersions: {
    applicationCatalogId: 'applicationCatalogId',
  },
  applicationUpgrades: {
    id: 'id',
    instanceId: 'instanceId',
    status: 'status',
    createdAt: 'createdAt',
  },
}));

const { applicationUpgradeRoutes } = await import('./routes.js');

describe('application-upgrades routes', () => {
  let app: FastifyInstance;
  let adminToken: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);
    app.decorate('db', chainable());
    await app.register(applicationUpgradeRoutes, { prefix: '/api/v1' });
    await app.ready();

    adminToken = app.jwt.sign({ sub: 'admin-1', role: 'super_admin', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
  });

  afterAll(async () => {
    await app.close();
  });

  // --- Auth ---

  it('GET admin/application-instances should require auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/application-instances' });
    expect(res.statusCode).toBe(401);
  });

  it('GET admin/application-upgrades should require auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/application-upgrades' });
    expect(res.statusCode).toBe(401);
  });

  // --- GET admin/application-instances ---

  it('GET admin/application-instances should return 200 for admin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/application-instances',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toBeDefined();
  });

  // --- GET admin/application-upgrades ---

  it('GET admin/application-upgrades should return 200 for admin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/application-upgrades',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toBeDefined();
  });

  // --- POST upgrade with missing body ---

  it('POST upgrade should return 400 with missing body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/application-instances/inst-1/upgrade',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  // --- Client routes ---

  it('GET client application-instances should require auth', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients/client-1/application-instances',
    });
    expect(res.statusCode).toBe(401);
  });

  it('GET client application-instances should return 200 for admin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients/client-1/application-instances',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toBeDefined();
  });
});
