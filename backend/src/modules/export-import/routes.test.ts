import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';

const mockExport = {
  version: '1.0',
  exportedAt: '2026-01-01T00:00:00.000Z',
  clients: [],
  domains: [],
  hostingPlans: [],
  dnsServers: [],
};

const mockImportResult = {
  dryRun: false,
  created: 2,
  updated: 0,
  skipped: 1,
  errors: [],
};

vi.mock('./service.js', () => ({
  exportAll: vi.fn().mockResolvedValue(mockExport),
  importData: vi.fn().mockResolvedValue(mockImportResult),
}));

const { exportImportRoutes } = await import('./routes.js');

describe('export-import routes', () => {
  let app: FastifyInstance;
  let superAdminToken: string;
  let adminToken: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);
    app.decorate('db', {});
    await app.register(exportImportRoutes, { prefix: '/api/v1' });
    await app.ready();

    superAdminToken = app.jwt.sign({ sub: 'admin-1', role: 'super_admin', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
    adminToken = app.jwt.sign({ sub: 'admin-2', role: 'admin', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
  });

  afterAll(async () => {
    await app.close();
  });

  // ─── Auth ────────────────────────────────────────────────────────────────

  it('GET /admin/export should require auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/export' });
    expect(res.statusCode).toBe(401);
  });

  it('GET /admin/export should reject non-super_admin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/export',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  // ─── GET /admin/export ───────────────────────────────────────────────────

  it('GET /admin/export should return export data for super_admin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/export',
      headers: { authorization: `Bearer ${superAdminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.version).toBe('1.0');
  });

  // ─── POST /admin/import ──────────────────────────────────────────────────

  it('POST /admin/import should reject non-super_admin', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/import',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { version: '1.0' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('POST /admin/import should import data for super_admin', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/import',
      headers: { authorization: `Bearer ${superAdminToken}` },
      payload: { version: '1.0', clients: [], domains: [], hostingPlans: [] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.created).toBeDefined();
  });

  it('POST /admin/import supports dry_run query param', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/import?dry_run=true',
      headers: { authorization: `Bearer ${superAdminToken}` },
      payload: { version: '1.0' },
    });
    expect(res.statusCode).toBe(200);
  });
});
