import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';

const mockMailbox = {
  id: 'mb-1',
  emailDomainId: 'ed-1',
  clientId: 'c1',
  localPart: 'info',
  fullAddress: 'info@example.com',
  displayName: 'Info Mailbox',
  quotaMb: 1024,
  usedMb: 50,
  status: 'active',
  mailboxType: 'mailbox',
  autoReply: 0,
  createdAt: new Date('2026-01-01').toISOString(),
  updatedAt: new Date('2026-01-01').toISOString(),
};

const mockAccess = {
  id: 'acc-1',
  mailboxId: 'mb-1',
  userId: 'u-1',
  accessLevel: 'full',
};

vi.mock('../../db/schema.js', () => ({
  mailboxes: {
    id: 'id',
    emailDomainId: 'emailDomainId',
    clientId: 'clientId',
    localPart: 'localPart',
    fullAddress: 'fullAddress',
    displayName: 'displayName',
    quotaMb: 'quotaMb',
    usedMb: 'usedMb',
    status: 'status',
    mailboxType: 'mailboxType',
    autoReply: 'autoReply',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
  },
}));

vi.mock('./service.js', () => ({
  createMailbox: vi.fn().mockResolvedValue(mockMailbox),
  listMailboxes: vi.fn().mockResolvedValue([mockMailbox]),
  getMailbox: vi.fn().mockResolvedValue(mockMailbox),
  updateMailbox: vi.fn().mockResolvedValue({ ...mockMailbox, displayName: 'Updated' }),
  deleteMailbox: vi.fn().mockResolvedValue(undefined),
  listMailboxAccess: vi.fn().mockResolvedValue([mockAccess]),
  grantMailboxAccess: vi.fn().mockResolvedValue(mockAccess),
  revokeMailboxAccess: vi.fn().mockResolvedValue(undefined),
  generateWebmailToken: vi.fn().mockResolvedValue({ token: 'wm-tok', mailbox: 'info@example.com', webmailUrl: 'https://wm.example.com' }),
  getAccessibleMailboxes: vi.fn().mockResolvedValue([mockMailbox]),
}));

const { mailboxRoutes } = await import('./routes.js');

describe('mailbox routes', () => {
  let app: FastifyInstance;
  let adminToken: string;
  let readOnlyToken: string;
  let clientUserToken: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);

    // Stub db for admin route's direct select
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockResolvedValue([mockMailbox]),
      }),
    };
    app.decorate('db', mockDb);
    await app.register(mailboxRoutes, { prefix: '/api/v1' });
    await app.ready();

    adminToken = app.jwt.sign({ sub: 'admin-1', role: 'super_admin', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
    readOnlyToken = app.jwt.sign({ sub: 'reader-1', role: 'read_only', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
    clientUserToken = app.jwt.sign({ sub: 'cu-1', role: 'client_user', panel: 'client', clientId: 'c1', iat: Math.floor(Date.now() / 1000) });
  });

  afterAll(async () => {
    await app.close();
  });

  // ── Auth ──

  it('GET /clients/:clientId/mailboxes should require auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/clients/c1/mailboxes' });
    expect(res.statusCode).toBe(401);
  });

  it('GET /clients/:clientId/mailboxes should reject read_only', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients/c1/mailboxes',
      headers: { authorization: `Bearer ${readOnlyToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  // ── List ──

  it('GET /clients/:clientId/mailboxes should return list for admin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients/c1/mailboxes',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
  });

  it('GET /clients/:clientId/mailboxes should allow client_user', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients/c1/mailboxes',
      headers: { authorization: `Bearer ${clientUserToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  // ── Create ──

  it('POST should reject invalid body (missing local_part)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/clients/c1/email/domains/ed-1/mailboxes',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { password: 'short' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('MISSING_REQUIRED_FIELD');
  });

  it('POST should reject client_user role', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/clients/c1/email/domains/ed-1/mailboxes',
      headers: { authorization: `Bearer ${clientUserToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('POST should create with valid body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/clients/c1/email/domains/ed-1/mailboxes',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        local_part: 'info',
        password: 'SecurePass123!',
      },
    });
    expect(res.statusCode).toBe(201);
  });

  // ── Get ──

  it('GET /:id should return mailbox', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients/c1/mailboxes/mb-1',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  // ── Update ──

  it('PATCH should reject invalid status', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/clients/c1/mailboxes/mb-1',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: 'invalid' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('MISSING_REQUIRED_FIELD');
  });

  it('PATCH should update with valid data', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/clients/c1/mailboxes/mb-1',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { display_name: 'New Name' },
    });
    expect(res.statusCode).toBe(200);
  });

  // ── Delete ──

  it('DELETE should return 204', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/clients/c1/mailboxes/mb-1',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(204);
  });

  // ── Access management ──

  it('GET /access should return access list', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients/c1/mailboxes/mb-1/access',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('POST /access should reject missing user_id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/clients/c1/mailboxes/mb-1/access',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('MISSING_REQUIRED_FIELD');
  });

  it('POST /access should grant with valid body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/clients/c1/mailboxes/mb-1/access',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { user_id: '550e8400-e29b-41d4-a716-446655440000', access_level: 'full' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('DELETE /access/:userId should return 204', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/clients/c1/mailboxes/mb-1/access/u-1',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(204);
  });

  // ── Admin route ──

  it('GET /admin/email/mailboxes should require admin role', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/email/mailboxes',
      headers: { authorization: `Bearer ${readOnlyToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('GET /admin/email/mailboxes should return all for admin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/email/mailboxes',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
  });
});
