import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';

const mockDatabase = {
  id: 'db1',
  clientId: 'c1',
  name: 'mydb',
  databaseType: 'mysql',
  username: 'db_mydb_abcd1234',
  passwordHash: 'hashed',
  port: 3306,
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
};

vi.mock('./service.js', () => ({
  createDatabase: vi.fn().mockResolvedValue({ record: mockDatabase, password: 'plaintext-pass' }),
  getDatabaseById: vi.fn().mockResolvedValue(mockDatabase),
  listDatabases: vi.fn().mockResolvedValue({
    data: [mockDatabase],
    pagination: { cursor: null, has_more: false, page_size: 1, total_count: 1 },
  }),
  deleteDatabase: vi.fn().mockResolvedValue(undefined),
  rotateCredentials: vi.fn().mockResolvedValue({ record: mockDatabase, password: 'new-plaintext-pass' }),
}));

const { databaseRoutes } = await import('./routes.js');

describe('database routes', () => {
  let app: FastifyInstance;
  let adminToken: string;
  let supportToken: string;
  let readOnlyToken: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);

    app.decorate('db', {});
    await app.register(databaseRoutes, { prefix: '/api/v1' });
    await app.ready();

    adminToken = app.jwt.sign({ sub: 'admin-1', role: 'super_admin', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
    supportToken = app.jwt.sign({ sub: 'support-1', role: 'support', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
    readOnlyToken = app.jwt.sign({ sub: 'reader-1', role: 'read_only', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
  });

  afterAll(async () => {
    await app.close();
  });

  it('should require auth for listing databases', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/clients/c1/databases' });
    expect(res.statusCode).toBe(401);
  });

  it('should reject read-only role', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients/c1/databases',
      headers: { authorization: `Bearer ${readOnlyToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('should allow admin to list databases', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients/c1/databases',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
  });

  it('should allow support to list databases', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients/c1/databases',
      headers: { authorization: `Bearer ${supportToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('POST should create database with valid body and return 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/clients/c1/databases',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'mydb' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.data.password).toBe('plaintext-pass');
  });

  it('POST should reject invalid name', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/clients/c1/databases',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST should reject name with special characters', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/clients/c1/databases',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'my-db!' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /:databaseId should return database', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients/c1/databases/db1',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.id).toBe('db1');
  });

  it('DELETE should return 204', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/clients/c1/databases/db1',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(204);
  });

  it('PATCH credentials should return 200 with new password', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/clients/c1/databases/db1/credentials',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.password).toBe('new-plaintext-pass');
  });

  it('PATCH credentials should require auth', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/clients/c1/databases/db1/credentials',
    });
    expect(res.statusCode).toBe(401);
  });
});
