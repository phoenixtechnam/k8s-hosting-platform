import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { hashNewPassword } from './service.js';

const mockUser = {
  id: 'u1',
  email: 'admin@example.com',
  passwordHash: await hashNewPassword('correct-password'),
  fullName: 'Admin User',
  roleName: 'admin',
  status: 'active',
};

const mockSet = vi.fn().mockReturnThis();
const mockWhere = vi.fn().mockResolvedValue([]);
const mockSelectWhere = vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([mockUser]) });
const mockUpdateSet = vi.fn().mockReturnValue({ where: mockWhere });

const mockDb = {
  select: vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: mockSelectWhere,
    }),
  }),
  update: vi.fn().mockReturnValue({
    set: mockUpdateSet,
  }),
};

vi.mock('./service.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./service.js')>();
  return {
    ...original,
    authenticateUser: vi.fn().mockResolvedValue({
      id: 'u1',
      email: 'admin@example.com',
      fullName: 'Admin User',
      role: 'admin',
    }),
  };
});

vi.mock('../oidc/service.js', () => ({
  isLocalAuthDisabled: vi.fn().mockResolvedValue(false),
}));

const { authRoutes } = await import('./routes.js');

describe('auth routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    app.setErrorHandler(errorHandler);

    app.decorate('db', mockDb);
    await app.register(authRoutes, { prefix: '/api/v1' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /api/v1/auth/login should return token on valid credentials', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'admin@example.com', password: 'correct-password' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.token).toBeDefined();
    expect(body.data.user.email).toBe('admin@example.com');
    expect(body.data.user.role).toBe('admin');
  });

  it('POST /api/v1/auth/login should reject invalid email format', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'not-valid', password: 'anything' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('POST /api/v1/auth/login should reject missing password', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'admin@example.com' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('GET /api/v1/auth/me should return user info with valid token', async () => {
    const token = app.jwt.sign({ sub: 'u1', role: 'admin', iat: Math.floor(Date.now() / 1000) });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.id).toBe('u1');
    expect(body.data.role).toBe('admin');
  });

  it('GET /api/v1/auth/me should reject without token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
    });

    // jwtVerify throws a Fastify error which gets caught by the error handler
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  // ─── PATCH /api/v1/auth/password ───

  it('PATCH /api/v1/auth/password should return 401 without auth', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/auth/password',
      payload: { current_password: 'old', new_password: 'newpass123' },
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('PATCH /api/v1/auth/password should return 400 with missing fields', async () => {
    const token = app.jwt.sign({ sub: 'u1', role: 'admin', iat: Math.floor(Date.now() / 1000) });
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/auth/password',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('PATCH /api/v1/auth/password should return 400 when new_password is too short', async () => {
    const token = app.jwt.sign({ sub: 'u1', role: 'admin', iat: Math.floor(Date.now() / 1000) });
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/auth/password',
      headers: { authorization: `Bearer ${token}` },
      payload: { current_password: 'correct-password', new_password: 'ab' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('PATCH /api/v1/auth/password should return 401 with wrong current password', async () => {
    const token = app.jwt.sign({ sub: 'u1', role: 'admin', iat: Math.floor(Date.now() / 1000) });
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/auth/password',
      headers: { authorization: `Bearer ${token}` },
      payload: { current_password: 'wrong-password', new_password: 'newpass123' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_TOKEN');
  });

  it('PATCH /api/v1/auth/password should return 200 on successful password change', async () => {
    const token = app.jwt.sign({ sub: 'u1', role: 'admin', iat: Math.floor(Date.now() / 1000) });
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/auth/password',
      headers: { authorization: `Bearer ${token}` },
      payload: { current_password: 'correct-password', new_password: 'newpass123' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.message).toBe('Password updated successfully');
  });
});
