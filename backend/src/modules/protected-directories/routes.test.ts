import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';

const mockDir = {
  id: 'dir-1',
  domainId: 'd1',
  path: '/admin',
  realm: 'Restricted Area',
  createdAt: new Date('2026-01-01').toISOString(),
};

const mockUser = {
  id: 'du-1',
  directoryId: 'dir-1',
  username: 'testuser',
  enabled: true,
  createdAt: new Date('2026-01-01').toISOString(),
};

vi.mock('./service.js', () => ({
  listDirectories: vi.fn().mockResolvedValue([mockDir]),
  createDirectory: vi.fn().mockResolvedValue(mockDir),
  getDirectory: vi.fn().mockResolvedValue(mockDir),
  updateDirectory: vi.fn().mockResolvedValue({ ...mockDir, realm: 'Updated' }),
  deleteDirectory: vi.fn().mockResolvedValue(undefined),
  listDirectoryUsers: vi.fn().mockResolvedValue([mockUser]),
  createDirectoryUser: vi.fn().mockResolvedValue(mockUser),
  changeDirectoryUserPassword: vi.fn().mockResolvedValue(undefined),
  toggleDirectoryUser: vi.fn().mockResolvedValue(undefined),
  deleteDirectoryUser: vi.fn().mockResolvedValue(undefined),
}));

const { protectedDirectoryRoutes } = await import('./routes.js');

describe('protected-directory routes', () => {
  let app: FastifyInstance;
  let adminToken: string;
  let readOnlyToken: string;

  const base = '/api/v1/clients/c1/domains/d1/protected-directories';

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);
    app.decorate('db', {});
    await app.register(protectedDirectoryRoutes, { prefix: '/api/v1' });
    await app.ready();

    adminToken = app.jwt.sign({ sub: 'admin-1', role: 'super_admin', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
    readOnlyToken = app.jwt.sign({ sub: 'reader-1', role: 'read_only', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
  });

  afterAll(async () => {
    await app.close();
  });

  // ─── Auth ────────────────────────────────────────────────────────────────

  it('GET dirs should require auth', async () => {
    const res = await app.inject({ method: 'GET', url: base });
    expect(res.statusCode).toBe(401);
  });

  it('GET dirs should reject read_only role', async () => {
    const res = await app.inject({
      method: 'GET',
      url: base,
      headers: { authorization: `Bearer ${readOnlyToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  // ─── Directory CRUD ──────────────────────────────────────────────────────

  it('GET dirs should return list for admin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: base,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toBeDefined();
  });

  it('POST dirs should reject empty body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: base,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST dirs should create with valid body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: base,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { path: '/admin' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data).toBeDefined();
  });

  it('GET dirs/:dirId should return single dir', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${base}/dir-1`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('PATCH dirs/:dirId should update', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `${base}/dir-1`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { realm: 'Updated' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('DELETE dirs/:dirId should return 204', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `${base}/dir-1`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(204);
  });

  // ─── Directory Users ─────────────────────────────────────────────────────

  it('GET dirs/:dirId/users should return list', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${base}/dir-1/users`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toBeDefined();
  });

  it('POST dirs/:dirId/users should reject empty body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${base}/dir-1/users`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST dirs/:dirId/users should create with valid body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${base}/dir-1/users`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { username: 'testuser', password: 'SecureP@ss123' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('POST dirs/:dirId/users/:userId/change-password should reject empty body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${base}/dir-1/users/du-1/change-password`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST dirs/:dirId/users/:userId/change-password should succeed', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${base}/dir-1/users/du-1/change-password`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { password: 'NewSecure@123' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('POST dirs/:dirId/users/:userId/disable should succeed', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${base}/dir-1/users/du-1/disable`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('DELETE dirs/:dirId/users/:userId should return 204', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `${base}/dir-1/users/du-1`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(204);
  });
});
