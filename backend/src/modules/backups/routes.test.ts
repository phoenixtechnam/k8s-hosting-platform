import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';

const mockBackup = {
  id: 'b1',
  clientId: 'c1',
  backupType: 'manual',
  status: 'completed',
};

vi.mock('./service.js', () => ({
  createBackup: vi.fn().mockResolvedValue(mockBackup),
  listBackups: vi.fn().mockResolvedValue({
    data: [mockBackup],
    pagination: { cursor: null, has_more: false, page_size: 1, total_count: 1 },
  }),
  deleteBackup: vi.fn().mockResolvedValue(undefined),
}));

const { backupRoutes } = await import('./routes.js');

describe('backup routes', () => {
  let app: FastifyInstance;
  let adminToken: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);

    app.decorate('db', {});
    await app.register(backupRoutes, { prefix: '/api/v1' });
    await app.ready();

    adminToken = app.jwt.sign({ sub: 'admin-1', role: 'admin', iat: Math.floor(Date.now() / 1000) });
  });

  afterAll(async () => {
    await app.close();
  });

  it('should require auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/clients/c1/backups' });
    expect(res.statusCode).toBe(401);
  });

  it('GET should return paginated backups', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients/c1/backups',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
  });

  it('POST should reject invalid backup_type', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/clients/c1/backups',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { backup_type: 'invalid' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST should create backup with valid body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/clients/c1/backups',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { backup_type: 'manual' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('DELETE should return 204', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/clients/c1/backups/b1',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(204);
  });
});
