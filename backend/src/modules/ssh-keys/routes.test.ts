import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';

const mockKey = {
  id: 'key-1',
  clientId: 'c1',
  name: 'My Key',
  publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA test@example',
  keyFingerprint: 'SHA256:abc123',
  keyAlgorithm: 'ED25519',
  createdAt: new Date('2026-01-01').toISOString(),
};

vi.mock('./service.js', () => ({
  listSshKeys: vi.fn().mockResolvedValue([mockKey]),
  createSshKey: vi.fn().mockResolvedValue(mockKey),
  deleteSshKey: vi.fn().mockResolvedValue(undefined),
}));

const { sshKeyRoutes } = await import('./routes.js');

describe('ssh-key routes', () => {
  let app: FastifyInstance;
  let adminToken: string;
  let readOnlyToken: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);
    app.decorate('db', {});
    await app.register(sshKeyRoutes, { prefix: '/api/v1' });
    await app.ready();

    adminToken = app.jwt.sign({ sub: 'admin-1', role: 'super_admin', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
    readOnlyToken = app.jwt.sign({ sub: 'reader-1', role: 'read_only', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
  });

  afterAll(async () => {
    await app.close();
  });

  // ─── Auth ────────────────────────────────────────────────────────────────

  it('GET ssh-keys should require auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/clients/c1/ssh-keys' });
    expect(res.statusCode).toBe(401);
  });

  it('GET ssh-keys should reject read_only role', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients/c1/ssh-keys',
      headers: { authorization: `Bearer ${readOnlyToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  // ─── GET ─────────────────────────────────────────────────────────────────

  it('GET ssh-keys should return list for admin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients/c1/ssh-keys',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toBeDefined();
  });

  // ─── POST ────────────────────────────────────────────────────────────────

  it('POST ssh-keys should reject empty body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/clients/c1/ssh-keys',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST ssh-keys should create with valid body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/clients/c1/ssh-keys',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: 'My Key',
        public_key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyData test@example',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data).toBeDefined();
  });

  // ─── DELETE ──────────────────────────────────────────────────────────────

  it('DELETE ssh-keys/:keyId should return 204', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/clients/c1/ssh-keys/key-1',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(204);
  });
});
