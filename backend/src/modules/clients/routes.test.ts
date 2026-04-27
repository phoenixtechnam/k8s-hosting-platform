import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';

const mockClient = {
  id: 'c1',
  companyName: 'Acme Corp',
  companyEmail: 'admin@acme.com',
  status: 'active',
  createdAt: new Date('2026-01-01').toISOString(),
};

// Mock the service module before importing routes
vi.mock('./service.js', () => ({
  createClient: vi.fn().mockResolvedValue({ ...mockClient, id: 'new-id' }),
  getClientById: vi.fn().mockResolvedValue(mockClient),
  listClients: vi.fn().mockResolvedValue({
    data: [mockClient],
    pagination: { cursor: null, has_more: false, page_size: 1, total_count: 1 },
  }),
  updateClient: vi.fn().mockResolvedValue({ ...mockClient, companyName: 'Updated' }),
  deleteClient: vi.fn().mockResolvedValue(undefined),
}));

// Mock the sub-users-service so the routes layer can be tested
// without a live database. The tests here are purely about
// role-gating and request wiring; deeper behavior (plan limits,
// last-admin guard, etc.) is covered in sub-users-service.test.ts.
const listSubUsersMock = vi.fn().mockResolvedValue([
  {
    id: 'u1',
    email: 'alice@c1.com',
    fullName: 'Alice',
    roleName: 'client_admin',
    status: 'active',
    createdAt: new Date('2026-01-01'),
    lastLoginAt: null,
  },
]);
const createSubUserMock = vi.fn().mockImplementation(
  (_db: unknown, _clientId: string, input: { email: string; full_name: string; role_name?: string }) => {
    return Promise.resolve({
      id: 'u-new',
      email: input.email,
      fullName: input.full_name,
      // Reflect the role from the payload so tests can assert the
      // route wires the parsed body through to the service.
      roleName: input.role_name ?? 'client_user',
      status: 'active',
      createdAt: new Date('2026-01-02'),
    });
  },
);
const deleteSubUserMock = vi.fn().mockResolvedValue(undefined);
const resetSubUserPasswordMock = vi.fn().mockResolvedValue(undefined);
const updateSubUserMock = vi.fn().mockImplementation(
  (_db: unknown, _clientId: string, userId: string, payload: { fullName?: string; roleName?: string; status?: string }) => {
    return Promise.resolve({
      id: userId,
      email: 'alice@c1.com',
      fullName: payload.fullName ?? 'Alice',
      roleName: payload.roleName ?? 'client_user',
      status: payload.status ?? 'active',
      createdAt: new Date('2026-01-01'),
      lastLoginAt: null,
    });
  },
);

vi.mock('./sub-users-service.js', () => ({
  listSubUsers: (...args: unknown[]) => listSubUsersMock(...args),
  createSubUser: (...args: unknown[]) => createSubUserMock(...args),
  updateSubUser: (...args: unknown[]) => updateSubUserMock(...args),
  resetSubUserPassword: (...args: unknown[]) => resetSubUserPasswordMock(...args),
  deleteSubUser: (...args: unknown[]) => deleteSubUserMock(...args),
  makeDrizzleSubUsersDb: vi.fn().mockReturnValue({}),
  getEffectiveMaxSubUsers: vi.fn().mockResolvedValue(10),
}));

// Import routes AFTER mocking
const { clientRoutes } = await import('./routes.js');

describe('client routes', () => {
  let app: FastifyInstance;
  let adminToken: string;
  let readOnlyToken: string;
  let supportToken: string;
  let clientAdminToken: string;
  let clientAdminNoClientIdToken: string;
  let clientUserToken: string;
  let otherClientAdminToken: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);

    // Decorate with a stub db. Phase 3: routes that disable users or
    // reset passwords also revoke refresh tokens via
    // revokeAllUserRefreshTokens — that hits db.update().set().where().
    // Stub the chain so the route can complete; the service-layer
    // mocks supply the real assertion data.
    const noopUpdate = {
      set: () => ({ where: async () => undefined }),
    };
    app.decorate('db', { update: () => noopUpdate });
    await app.register(clientRoutes, { prefix: '/api/v1' });
    await app.ready();

    const iat = Math.floor(Date.now() / 1000);
    adminToken = app.jwt.sign({ sub: 'admin-1', role: 'super_admin', panel: 'admin', iat });
    readOnlyToken = app.jwt.sign({ sub: 'reader-1', role: 'read_only', panel: 'admin', iat });
    supportToken = app.jwt.sign({ sub: 'support-1', role: 'support', panel: 'admin', iat });
    clientAdminToken = app.jwt.sign({
      sub: 'ca-1', role: 'client_admin', panel: 'client', clientId: 'c1', iat,
    });
    clientAdminNoClientIdToken = app.jwt.sign({
      // Phase 1 hardening: client-panel tokens without a clientId
      // claim must be rejected by requireClientAccess(). The bug
      // previously allowed them through whenever the URL-param
      // clientId happened to be present.
      sub: 'ca-broken', role: 'client_admin', panel: 'client', iat,
    });
    clientUserToken = app.jwt.sign({
      sub: 'cu-1', role: 'client_user', panel: 'client', clientId: 'c1', iat,
    });
    otherClientAdminToken = app.jwt.sign({
      sub: 'ca-2', role: 'client_admin', panel: 'client', clientId: 'c2', iat,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    listSubUsersMock.mockClear();
    createSubUserMock.mockClear();
    updateSubUserMock.mockClear();
    resetSubUserPasswordMock.mockClear();
    deleteSubUserMock.mockClear();
  });

  it('GET /api/v1/clients should require auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/clients' });
    expect(res.statusCode).toBe(401);
  });

  it('GET /api/v1/clients should require admin role', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients',
      headers: { authorization: `Bearer ${readOnlyToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('GET /api/v1/clients should return paginated results for admin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toBeDefined();
    expect(body.pagination).toBeDefined();
  });

  it('GET /api/v1/clients/:id should return client', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients/c1',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('POST /api/v1/clients should reject invalid body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/clients',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { company_name: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(['MISSING_REQUIRED_FIELD', 'VALIDATION_ERROR']).toContain(res.json().error.code);
  });

  it('POST /api/v1/clients should create client with valid body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/clients',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        company_name: 'New Corp',
        company_email: 'admin@newcorp.com',
        plan_id: '550e8400-e29b-41d4-a716-446655440000',
        region_id: '550e8400-e29b-41d4-a716-446655440001',
      },
    });
    expect(res.statusCode).toBe(201);
  });

  it('PATCH /api/v1/clients/:id should reject invalid field values', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/clients/c1',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: 'invalid-status' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_FIELD_VALUE');
  });

  it('PATCH /api/v1/clients/:id should update with valid data', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/clients/c1',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { company_name: 'Updated Corp' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('DELETE /api/v1/clients/:id should return 204', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/clients/c1',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(204);
  });

  // ─── Sub-User Routes (Phase 1 regression coverage) ──────────────────────
  //
  // The previous version of clients/routes.ts installed
  // `requireRole('super_admin','admin')` as a plugin-wide hook which
  // rejected client_admin / client_user tokens before the permissive
  // per-route hooks could run, producing 403 on GET /users. These
  // tests lock in the per-route hook structure and the client_user
  // read permission added alongside.

  describe('GET /api/v1/clients/:clientId/users', () => {
    it('returns 401 without auth', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/clients/c1/users' });
      expect(res.statusCode).toBe(401);
    });

    it('rejects read_only admin with 403', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/clients/c1/users',
        headers: { authorization: `Bearer ${readOnlyToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('allows super_admin', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/clients/c1/users',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toHaveLength(1);
      expect(listSubUsersMock).toHaveBeenCalledWith(expect.anything(), 'c1');
    });

    it('allows support role', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/clients/c1/users',
        headers: { authorization: `Bearer ${supportToken}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it('allows client_admin for their own client (regression: the plugin-wide hook bug)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/clients/c1/users',
        headers: { authorization: `Bearer ${clientAdminToken}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it('allows client_user read access for their own client', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/clients/c1/users',
        headers: { authorization: `Bearer ${clientUserToken}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it('rejects client_admin from another client (cross-tenant)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/clients/c1/users',
        headers: { authorization: `Bearer ${otherClientAdminToken}` },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('CLIENT_ACCESS_DENIED');
    });

    it('rejects a client-panel token with no clientId claim (Phase 1 hardening)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/clients/c1/users',
        headers: { authorization: `Bearer ${clientAdminNoClientIdToken}` },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('CLIENT_ACCESS_DENIED');
    });
  });

  describe('POST /api/v1/clients/:clientId/users', () => {
    const validBody = { email: 'new@c1.com', full_name: 'New User', password: 'password123' };

    it('allows client_admin to create a sub-user in their own client', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/clients/c1/users',
        headers: { authorization: `Bearer ${clientAdminToken}` },
        payload: validBody,
      });
      expect(res.statusCode).toBe(201);
      expect(createSubUserMock).toHaveBeenCalled();
    });

    it('rejects client_user (read-only cannot create)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/clients/c1/users',
        headers: { authorization: `Bearer ${clientUserToken}` },
        payload: validBody,
      });
      expect(res.statusCode).toBe(403);
      expect(createSubUserMock).not.toHaveBeenCalled();
    });

    it('rejects support role (read-only staff cannot create)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/clients/c1/users',
        headers: { authorization: `Bearer ${supportToken}` },
        payload: validBody,
      });
      expect(res.statusCode).toBe(403);
    });

    it('rejects client_admin from another client', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/clients/c1/users',
        headers: { authorization: `Bearer ${otherClientAdminToken}` },
        payload: validBody,
      });
      expect(res.statusCode).toBe(403);
    });

    it('rejects a malformed email (Zod validation)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/clients/c1/users',
        headers: { authorization: `Bearer ${clientAdminToken}` },
        payload: { email: 'notanemail', full_name: 'Bad', password: 'password123' },
      });
      expect(res.statusCode).toBe(400);
      expect(createSubUserMock).not.toHaveBeenCalled();
    });

    it('rejects a password shorter than 8 characters', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/clients/c1/users',
        headers: { authorization: `Bearer ${clientAdminToken}` },
        payload: { email: 'ok@c1.com', full_name: 'OK', password: 'short' },
      });
      expect(res.statusCode).toBe(400);
      expect(createSubUserMock).not.toHaveBeenCalled();
    });

    it('rejects a missing full_name', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/clients/c1/users',
        headers: { authorization: `Bearer ${clientAdminToken}` },
        payload: { email: 'ok@c1.com', full_name: '', password: 'password123' },
      });
      expect(res.statusCode).toBe(400);
      expect(createSubUserMock).not.toHaveBeenCalled();
    });

    it('accepts role_name=client_admin in the body (Phase 2)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/clients/c1/users',
        headers: { authorization: `Bearer ${clientAdminToken}` },
        payload: {
          email: 'promoted@c1.com',
          full_name: 'Promoted',
          password: 'password123',
          role_name: 'client_admin',
        },
      });
      expect(res.statusCode).toBe(201);
      expect(createSubUserMock).toHaveBeenCalledWith(
        expect.anything(),
        'c1',
        expect.objectContaining({ role_name: 'client_admin' }),
        expect.anything(),
      );
      // Assert the roleName is reflected in the response body — this
      // catches bugs where the route forgets to pass role_name through.
      expect(res.json().data.roleName).toBe('client_admin');
    });

    it('rejects client_user attempting to create a client_admin (authz before body parse)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/clients/c1/users',
        headers: { authorization: `Bearer ${clientUserToken}` },
        payload: {
          email: 'escalate@c1.com',
          full_name: 'Escalate',
          password: 'password123',
          role_name: 'client_admin',
        },
      });
      expect(res.statusCode).toBe(403);
      expect(createSubUserMock).not.toHaveBeenCalled();
    });

    it('accepts role_name=client_user in the body', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/clients/c1/users',
        headers: { authorization: `Bearer ${clientAdminToken}` },
        payload: {
          email: 'member@c1.com',
          full_name: 'Member',
          password: 'password123',
          role_name: 'client_user',
        },
      });
      expect(res.statusCode).toBe(201);
    });

    it('rejects role_name outside the enum', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/clients/c1/users',
        headers: { authorization: `Bearer ${clientAdminToken}` },
        payload: {
          email: 'bad@c1.com',
          full_name: 'Bad',
          password: 'password123',
          role_name: 'super_admin',
        },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('PATCH /api/v1/clients/:clientId/users/:userId (Phase 3)', () => {
    it('allows client_admin to rename a sub-user', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/clients/c1/users/u1',
        headers: { authorization: `Bearer ${clientAdminToken}` },
        payload: { full_name: 'Renamed' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.fullName).toBe('Renamed');
      expect(updateSubUserMock).toHaveBeenCalledWith(
        expect.anything(),
        'c1',
        'u1',
        expect.objectContaining({ fullName: 'Renamed' }),
      );
    });

    it('allows status changes (disable)', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/clients/c1/users/u1',
        headers: { authorization: `Bearer ${clientAdminToken}` },
        payload: { status: 'disabled' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.status).toBe('disabled');
    });

    it('allows role changes', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/clients/c1/users/u1',
        headers: { authorization: `Bearer ${clientAdminToken}` },
        payload: { role_name: 'client_admin' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.roleName).toBe('client_admin');
    });

    it('rejects an empty patch body', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/clients/c1/users/u1',
        headers: { authorization: `Bearer ${clientAdminToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(updateSubUserMock).not.toHaveBeenCalled();
    });

    it('rejects invalid status values', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/clients/c1/users/u1',
        headers: { authorization: `Bearer ${clientAdminToken}` },
        payload: { status: 'pending' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects client_user (read-only cannot edit)', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/clients/c1/users/u1',
        headers: { authorization: `Bearer ${clientUserToken}` },
        payload: { full_name: 'Evil' },
      });
      expect(res.statusCode).toBe(403);
      expect(updateSubUserMock).not.toHaveBeenCalled();
    });

    it('rejects cross-client edits', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/clients/c1/users/u1',
        headers: { authorization: `Bearer ${otherClientAdminToken}` },
        payload: { full_name: 'Hack' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('requires auth', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/clients/c1/users/u1',
        payload: { full_name: 'Anon' },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /api/v1/clients/:clientId/users/:userId/reset-password (Phase 4)', () => {
    const validBody = { new_password: 'brand-new-pw-123' };

    it('allows client_admin to reset a sub-user password', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/clients/c1/users/u1/reset-password',
        headers: { authorization: `Bearer ${clientAdminToken}` },
        payload: validBody,
      });
      expect(res.statusCode).toBe(204);
      expect(resetSubUserPasswordMock).toHaveBeenCalledWith(
        expect.anything(),
        'c1',
        'u1',
        'brand-new-pw-123',
      );
    });

    it('rejects passwords shorter than 8 characters', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/clients/c1/users/u1/reset-password',
        headers: { authorization: `Bearer ${clientAdminToken}` },
        payload: { new_password: 'short' },
      });
      expect(res.statusCode).toBe(400);
      expect(resetSubUserPasswordMock).not.toHaveBeenCalled();
    });

    it('rejects a missing new_password field', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/clients/c1/users/u1/reset-password',
        headers: { authorization: `Bearer ${clientAdminToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects client_user (read-only cannot reset passwords)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/clients/c1/users/u1/reset-password',
        headers: { authorization: `Bearer ${clientUserToken}` },
        payload: validBody,
      });
      expect(res.statusCode).toBe(403);
      expect(resetSubUserPasswordMock).not.toHaveBeenCalled();
    });

    it('rejects cross-client password resets', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/clients/c1/users/u1/reset-password',
        headers: { authorization: `Bearer ${otherClientAdminToken}` },
        payload: validBody,
      });
      expect(res.statusCode).toBe(403);
    });

    it('requires auth', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/clients/c1/users/u1/reset-password',
        payload: validBody,
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('DELETE /api/v1/clients/:clientId/users/:userId', () => {
    it('allows client_admin to delete a sub-user in their own client', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/v1/clients/c1/users/u1',
        headers: { authorization: `Bearer ${clientAdminToken}` },
      });
      expect(res.statusCode).toBe(204);
      expect(deleteSubUserMock).toHaveBeenCalledWith(expect.anything(), 'c1', 'u1');
    });

    it('rejects client_user', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/v1/clients/c1/users/u1',
        headers: { authorization: `Bearer ${clientUserToken}` },
      });
      expect(res.statusCode).toBe(403);
      expect(deleteSubUserMock).not.toHaveBeenCalled();
    });

    it('rejects cross-client', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/v1/clients/c1/users/u1',
        headers: { authorization: `Bearer ${otherClientAdminToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('requires auth', async () => {
      const res = await app.inject({ method: 'DELETE', url: '/api/v1/clients/c1/users/u1' });
      expect(res.statusCode).toBe(401);
    });
  });
});
