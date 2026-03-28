import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';

const mockRepo = {
  id: 'repo-1',
  name: 'Official Catalog',
  url: 'https://github.com/phoenixtechnam/hosting-platform-application-catalog',
  branch: 'main',
  authToken: null,
  syncIntervalMinutes: 60,
  lastSyncedAt: null,
  status: 'active',
  lastError: null,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};

const mockCatalogEntry = {
  id: 'cat-1',
  code: 'wordpress',
  name: 'WordPress',
  version: '6.x',
  description: 'Managed WordPress',
  category: 'cms',
  minPlan: 'starter',
  tenancy: ['single-tenant'],
  components: [],
  networking: {},
  volumes: [],
  resources: {},
  healthCheck: {},
  parameters: [],
  tags: ['cms', 'wordpress'],
  status: 'available',
  sourceRepoId: 'repo-1',
  manifestUrl: 'https://raw.githubusercontent.com/phoenixtechnam/hosting-platform-application-catalog/main/wordpress/manifest.json',
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};

// Mock the service module before importing routes
vi.mock('./service.js', () => ({
  listRepos: vi.fn().mockResolvedValue([mockRepo]),
  addRepo: vi.fn().mockResolvedValue({ ...mockRepo, id: 'new-repo-id' }),
  deleteRepo: vi.fn().mockResolvedValue(undefined),
  syncRepo: vi.fn().mockResolvedValue(undefined),
  restoreDefaultRepo: vi.fn().mockResolvedValue(mockRepo),
  listCatalogEntries: vi.fn().mockResolvedValue([mockCatalogEntry]),
}));

// Import routes AFTER mocking
const { applicationRepoRoutes } = await import('./routes.js');

describe('application-repos routes', () => {
  let app: FastifyInstance;
  let adminToken: string;
  let readOnlyToken: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);

    // Decorate with a stub db (service is mocked, so db won't be used)
    app.decorate('db', {});
    await app.register(applicationRepoRoutes, { prefix: '/api/v1' });
    await app.ready();

    adminToken = app.jwt.sign({ sub: 'admin-1', role: 'super_admin', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
    readOnlyToken = app.jwt.sign({ sub: 'reader-1', role: 'read_only', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/v1/admin/application-repos should return 200 with data array', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/application-repos',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toBeDefined();
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('GET /api/v1/admin/application-repos should require admin auth', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/application-repos',
    });
    expect(res.statusCode).toBe(401);
  });

  it('GET /api/v1/admin/application-repos should reject non-admin roles', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/application-repos',
      headers: { authorization: `Bearer ${readOnlyToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('POST /api/v1/admin/application-repos should return 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/application-repos',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: 'My Catalog',
        url: 'https://github.com/org/catalog-repo',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.data).toBeDefined();
    expect(body.data.id).toBe('new-repo-id');
  });

  it('POST /api/v1/admin/application-repos should reject invalid URL', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/application-repos',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: 'Bad Repo',
        url: 'not-a-url',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/v1/admin/application-repos should reject missing name', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/application-repos',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        url: 'https://github.com/org/catalog-repo',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('DELETE /api/v1/admin/application-repos/:id should return 204', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/admin/application-repos/repo-1',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(204);
  });

  it('POST /api/v1/admin/application-repos/:id/sync should return 200', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/application-repos/repo-1/sync',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.message).toContain('Sync completed');
  });

  it('POST /api/v1/admin/application-repos should require auth', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/application-repos',
      payload: {
        name: 'My Catalog',
        url: 'https://github.com/org/catalog-repo',
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it('POST /api/v1/admin/application-repos/restore-default should return 200 with repo data', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/application-repos/restore-default',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toBeDefined();
    expect(body.data.name).toBe('Official Catalog');
  });

  it('POST /api/v1/admin/application-repos/restore-default should require admin auth', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/application-repos/restore-default',
    });
    expect(res.statusCode).toBe(401);
  });

  it('POST /api/v1/admin/application-repos/restore-default should reject non-admin roles', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/application-repos/restore-default',
      headers: { authorization: `Bearer ${readOnlyToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('DELETE /api/v1/admin/application-repos/:id should call deleteRepo service', async () => {
    const { deleteRepo } = await import('./service.js');
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/admin/application-repos/repo-to-delete',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(204);
    expect(deleteRepo).toHaveBeenCalledWith(expect.anything(), 'repo-to-delete');
  });

  it('POST /api/v1/admin/application-repos should return 400 when addRepo throws validation error', async () => {
    const { addRepo } = await import('./service.js');
    const { ApiError } = await import('../../shared/errors.js');
    vi.mocked(addRepo).mockRejectedValueOnce(
      new ApiError('REPO_VALIDATION_FAILED', 'Cannot access repository: 404 Not Found. Verify the URL and auth token.', 400),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/application-repos',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: 'Unreachable Repo',
        url: 'https://github.com/org/nonexistent',
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe('REPO_VALIDATION_FAILED');
  });

  it('GET /api/v1/admin/application-catalog should return 200 with data array', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/application-catalog',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toBeDefined();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data[0].code).toBe('wordpress');
  });

  it('GET /api/v1/admin/application-catalog should require auth', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/application-catalog',
    });
    expect(res.statusCode).toBe(401);
  });
});
