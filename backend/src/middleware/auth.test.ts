import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { registerAuth, authenticate, requireRole } from './auth.js';
import { errorHandler } from './error-handler.js';

describe('auth middleware', () => {
  let app: FastifyInstance;
  let validToken: string;
  let supportToken: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);

    // Protected route requiring admin
    app.get('/admin-only', { preHandler: [authenticate, requireRole('admin')] }, async (request) => {
      return { user: request.user };
    });

    // Protected route requiring admin or support
    app.get('/admin-support', { preHandler: [authenticate, requireRole('admin', 'support')] }, async (request) => {
      return { user: request.user };
    });

    // Auth-only route (any role)
    app.get('/auth-only', { preHandler: [authenticate] }, async (request) => {
      return { user: request.user };
    });

    await app.ready();

    validToken = app.jwt.sign({ sub: 'user-1', role: 'admin', iat: Math.floor(Date.now() / 1000) });
    supportToken = app.jwt.sign({ sub: 'user-2', role: 'support', iat: Math.floor(Date.now() / 1000) });
  });

  afterAll(async () => {
    await app.close();
  });

  it('should reject request without Authorization header', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth-only' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('MISSING_BEARER_TOKEN');
  });

  it('should reject request with invalid token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth-only',
      headers: { authorization: 'Bearer invalid.token.here' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_TOKEN');
  });

  it('should accept valid token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth-only',
      headers: { authorization: `Bearer ${validToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.sub).toBe('user-1');
    expect(res.json().user.role).toBe('admin');
  });

  it('should enforce admin role', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin-only',
      headers: { authorization: `Bearer ${supportToken}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('INSUFFICIENT_PERMISSIONS');
  });

  it('should allow admin on admin-only route', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin-only',
      headers: { authorization: `Bearer ${validToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('should allow support on admin-support route', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin-support',
      headers: { authorization: `Bearer ${supportToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('should reject non-Bearer auth schemes', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth-only',
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('MISSING_BEARER_TOKEN');
  });
});
