import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { registerAuth, authenticate, authenticateSession, requireRole, requireClientRoleByMethod } from './auth.js';
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

    // Session-cookie route (used by nginx auth_request on the Stalwart
    // subdomain). Bearer still works too for curl-testability.
    app.get('/session-only', { preHandler: [authenticateSession] }, async (request) => {
      return { user: request.user };
    });

    // Phase 6: method-aware client role guard test routes
    app.get('/client-rsrc', {
      preHandler: [authenticate, requireClientRoleByMethod()],
    }, async () => ({ ok: true }));
    app.post('/client-rsrc', {
      preHandler: [authenticate, requireClientRoleByMethod()],
    }, async () => ({ ok: true }));
    app.patch('/client-rsrc', {
      preHandler: [authenticate, requireClientRoleByMethod()],
    }, async () => ({ ok: true }));
    app.delete('/client-rsrc', {
      preHandler: [authenticate, requireClientRoleByMethod()],
    }, async () => ({ ok: true }));

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

  it('should reject non-Bearer auth schemes (Bearer-only guard)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth-only',
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('MISSING_BEARER_TOKEN');
  });

  it('ignores platform_session cookie on Bearer-only routes (CSRF-safe)', async () => {
    // The shared authenticate() middleware deliberately rejects cookie-
    // only requests so that SameSite=Lax + subdomain-hosted tenant
    // content can't CSRF state-changing API calls. Cookie support lives
    // on authenticateSession() for read-only gates (see below).
    const res = await app.inject({
      method: 'GET',
      url: '/auth-only',
      headers: { cookie: `platform_session=${validToken}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('MISSING_BEARER_TOKEN');
  });

  describe('authenticateSession (cookie-aware, read-only gate)', () => {
    it('accepts a platform_session cookie when no Authorization header', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/session-only',
        headers: { cookie: `platform_session=${validToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().user.sub).toBe('user-1');
    });

    it('Authorization header wins over platform_session cookie', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/session-only',
        headers: {
          authorization: `Bearer ${validToken}`,
          cookie: `platform_session=${supportToken}`,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().user.role).toBe('admin');
    });

    it('rejects an invalid cookie-supplied token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/session-only',
        headers: { cookie: 'platform_session=not.a.valid.jwt' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('INVALID_TOKEN');
    });

    it('ignores unrelated cookies', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/session-only',
        headers: { cookie: `foo=bar; platform_session=${validToken}; other=baz` },
      });
      expect(res.statusCode).toBe(200);
    });

    it('rejects when no credential is present at all', async () => {
      const res = await app.inject({ method: 'GET', url: '/session-only' });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('MISSING_BEARER_TOKEN');
    });
  });

  describe('requireClientRoleByMethod (Phase 6)', () => {
    const iat = Math.floor(Date.now() / 1000);
    let clientAdminToken: string;
    let clientUserToken: string;
    let readOnlyToken: string;
    let supportTokenLocal: string;

    beforeAll(() => {
      clientAdminToken = app.jwt.sign({ sub: 'ca', role: 'client_admin', panel: 'client', clientId: 'c1', iat });
      clientUserToken = app.jwt.sign({ sub: 'cu', role: 'client_user', panel: 'client', clientId: 'c1', iat });
      readOnlyToken = app.jwt.sign({ sub: 'ro', role: 'read_only', panel: 'admin', iat });
      supportTokenLocal = app.jwt.sign({ sub: 'sup', role: 'support', panel: 'admin', iat });
    });

    it('allows client_user to GET (read)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/client-rsrc',
        headers: { authorization: `Bearer ${clientUserToken}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it('rejects read_only admin on client resources (admin-panel role)', async () => {
      // `read_only` is for admin dashboard / metrics / health
      // aggregate reads — it should NOT have access to individual
      // client resource endpoints like /clients/:id/domains.
      const res = await app.inject({
        method: 'GET',
        url: '/client-rsrc',
        headers: { authorization: `Bearer ${readOnlyToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('rejects client_user POST (write)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/client-rsrc',
        headers: { authorization: `Bearer ${clientUserToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(403);
    });

    it('rejects client_user PATCH (write)', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/client-rsrc',
        headers: { authorization: `Bearer ${clientUserToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(403);
    });

    it('rejects client_user DELETE (write)', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/client-rsrc',
        headers: { authorization: `Bearer ${clientUserToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('rejects read_only admin POST (read_only cannot write)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/client-rsrc',
        headers: { authorization: `Bearer ${readOnlyToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(403);
    });

    it('allows client_admin POST (client_admin can write)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/client-rsrc',
        headers: { authorization: `Bearer ${clientAdminToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
    });

    it('allows support POST (staff can write)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/client-rsrc',
        headers: { authorization: `Bearer ${supportTokenLocal}` },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
    });

    it('allows client_admin DELETE', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/client-rsrc',
        headers: { authorization: `Bearer ${clientAdminToken}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it('rejects unauthenticated requests', async () => {
      const res = await app.inject({ method: 'POST', url: '/client-rsrc', payload: {} });
      expect(res.statusCode).toBe(401);
    });
  });
});
