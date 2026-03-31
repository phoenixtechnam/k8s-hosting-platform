import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';

const mockSettings = {
  id: 'eol-1',
  graceDays: 90,
  warningDays: 30,
  autoUpgradeEnabled: false,
  createdAt: new Date('2026-01-01').toISOString(),
  updatedAt: new Date('2026-01-01').toISOString(),
};

const mockScanResult = {
  scannedAt: new Date().toISOString(),
  totalInstances: 12,
  eolCount: 2,
  warningCount: 3,
};

vi.mock('./service.js', () => ({
  getEolSettings: vi.fn().mockResolvedValue(mockSettings),
  updateEolSettings: vi.fn().mockResolvedValue({ ...mockSettings, graceDays: 60 }),
  runEolScan: vi.fn().mockResolvedValue(mockScanResult),
}));

const { eolScannerRoutes } = await import('./routes.js');

describe('eol-scanner routes', () => {
  let app: FastifyInstance;
  let adminToken: string;
  let supportToken: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);
    app.decorate('db', {});
    await app.register(eolScannerRoutes, { prefix: '/api/v1' });
    await app.ready();

    adminToken = app.jwt.sign({ sub: 'admin-1', role: 'super_admin', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
    supportToken = app.jwt.sign({ sub: 'support-1', role: 'support', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
  });

  afterAll(async () => {
    await app.close();
  });

  // --- Auth ---

  it('GET eol-settings should require auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/eol-settings' });
    expect(res.statusCode).toBe(401);
  });

  it('GET eol-settings should reject non-admin role', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/eol-settings',
      headers: { authorization: `Bearer ${supportToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  // --- GET ---

  it('GET eol-settings should return settings for admin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/eol-settings',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toBeDefined();
  });

  // --- PATCH ---

  it('PATCH eol-settings should update with valid body', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/eol-settings',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { graceDays: 60, warningDays: 14, autoUpgradeEnabled: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toBeDefined();
  });

  // --- POST run ---

  it('POST eol-scanner/run should require auth', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/admin/eol-scanner/run' });
    expect(res.statusCode).toBe(401);
  });

  it('POST eol-scanner/run should trigger scan for admin', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/eol-scanner/run',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toBeDefined();
    expect(res.json().data.totalInstances).toBe(12);
  });
});
