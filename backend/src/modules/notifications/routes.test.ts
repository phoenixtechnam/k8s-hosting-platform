import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';

const mockNotification = {
  id: 'n1',
  userId: 'admin-1',
  type: 'info',
  title: 'Test',
  message: 'Hello',
  isRead: 0,
  readAt: null,
  resourceType: null,
  resourceId: null,
  createdAt: new Date('2026-01-01').toISOString(),
};

vi.mock('./service.js', () => ({
  listNotifications: vi.fn().mockResolvedValue([mockNotification]),
  getUnreadCount: vi.fn().mockResolvedValue(3),
  markAsRead: vi.fn().mockResolvedValue(undefined),
  deleteNotification: vi.fn().mockResolvedValue(undefined),
}));

const { notificationRoutes } = await import('./routes.js');

describe('notification routes', () => {
  let app: FastifyInstance;
  let userToken: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);
    app.decorate('db', {});
    await app.register(notificationRoutes, { prefix: '/api/v1' });
    await app.ready();

    userToken = app.jwt.sign({ sub: 'admin-1', role: 'super_admin', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
  });

  afterAll(async () => {
    await app.close();
  });

  // ─── Auth ────────────────────────────────────────────────────────────────

  it('GET /notifications should require auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/notifications' });
    expect(res.statusCode).toBe(401);
  });

  // ─── GET /notifications ──────────────────────────────────────────────────

  it('GET /notifications should return list', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toBeDefined();
  });

  it('GET /notifications supports unread_only query', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications?unread_only=true',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  // ─── GET /notifications/unread-count ─────────────────────────────────────

  it('GET /notifications/unread-count should return count', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications/unread-count',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.count).toBe(3);
  });

  // ─── POST /notifications/mark-read ───────────────────────────────────────

  it('POST /notifications/mark-read should reject invalid body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/notifications/mark-read',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { ids: 'not-an-array' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /notifications/mark-read should succeed with valid ids', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/notifications/mark-read',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { ids: ['550e8400-e29b-41d4-a716-446655440000', '550e8400-e29b-41d4-a716-446655440001'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.updated).toBeDefined();
  });

  // ─── DELETE /notifications/:id ───────────────────────────────────────────

  it('DELETE /notifications/:id should return 204', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/notifications/n1',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(res.statusCode).toBe(204);
  });
});
