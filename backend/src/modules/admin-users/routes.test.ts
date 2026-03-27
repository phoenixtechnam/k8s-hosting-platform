import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';

const mockAdminUsers = [
  { id: 'u1', email: 'admin@test.com', fullName: 'Admin One', roleName: 'super_admin', status: 'active', lastLoginAt: null, createdAt: new Date('2026-01-01') },
  { id: 'u2', email: 'support@test.com', fullName: 'Support User', roleName: 'support', status: 'active', lastLoginAt: null, createdAt: new Date('2026-01-02') },
];

const mockClientUser = { id: 'u3', email: 'client@test.com', fullName: 'Client User', roleName: 'client_admin', panel: 'client', status: 'active' };

// Track inserted/deleted users for test assertions
let insertedUser: Record<string, unknown> | null = null;
let deletedId: string | null = null;

const whereFn = vi.fn().mockReturnThis();
const limitFn = vi.fn().mockReturnThis();

const mockDb = {
  select: vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockImplementation(() => {
        // Default: return admin users list
        return Promise.resolve(mockAdminUsers);
      }),
    }),
  }),
  insert: vi.fn().mockReturnValue({
    values: vi.fn().mockResolvedValue(undefined),
  }),
  update: vi.fn().mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  }),
  delete: vi.fn().mockReturnValue({
    where: vi.fn().mockImplementation(() => {
      return Promise.resolve(undefined);
    }),
  }),
};

// We mock at the DB level since admin-users has no separate service module
const { adminUserRoutes } = await import('./routes.js');

describe('admin user routes', () => {
  let app: FastifyInstance;
  let superAdminToken: string;
  let adminToken: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);
    app.decorate('db', mockDb);
    await app.register(adminUserRoutes, { prefix: '/api/v1' });
    await app.ready();

    superAdminToken = app.jwt.sign({ sub: 'u1', role: 'super_admin', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
    adminToken = app.jwt.sign({ sub: 'u2', role: 'admin', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /admin/users returns only admin panel users', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: { authorization: `Bearer ${superAdminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toBeDefined();
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('GET /admin/users accessible by admin role', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('POST /admin/users creates admin user with valid role', async () => {
    // Mock: select for duplicate check returns empty, then select for created user
    const selectFromWhere = vi.fn()
      .mockResolvedValueOnce([]) // duplicate check
      .mockResolvedValueOnce([{ id: 'new-id', email: 'new@test.com', fullName: 'New Admin', roleName: 'admin', status: 'active', lastLoginAt: null, createdAt: new Date() }]);

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: selectFromWhere,
      }),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers: { authorization: `Bearer ${superAdminToken}` },
      payload: {
        email: 'new@test.com',
        full_name: 'New Admin',
        password: 'SecurePass123!',
        role_name: 'admin',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.email).toBe('new@test.com');
  });

  it('POST /admin/users rejects creation with invalid role', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers: { authorization: `Bearer ${superAdminToken}` },
      payload: {
        email: 'bad@test.com',
        full_name: 'Bad Role',
        password: 'SecurePass123!',
        role_name: 'invalid_role',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('POST /admin/users rejects non-super_admin', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        email: 'new@test.com',
        full_name: 'New Admin',
        password: 'SecurePass123!',
        role_name: 'admin',
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('DELETE /admin/users/:id prevents self-deletion', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/admin/users/u1', // same as superAdminToken sub
      headers: { authorization: `Bearer ${superAdminToken}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('OPERATION_NOT_ALLOWED');
    expect(res.json().error.message).toContain('own account');
  });

  it('DELETE /admin/users/:id prevents last super_admin deletion', async () => {
    // Mock: select for existing user returns super_admin, then select for count returns only 1
    const selectFromWhere = vi.fn()
      .mockResolvedValueOnce([{ id: 'u-other', email: 'other@test.com', roleName: 'super_admin', panel: 'admin', status: 'active' }]) // existing check
      .mockResolvedValueOnce([{ id: 'u-other' }]); // super_admin count = 1

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: selectFromWhere,
      }),
    });

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/admin/users/u-other',
      headers: { authorization: `Bearer ${superAdminToken}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toContain('last super_admin');
  });
});
