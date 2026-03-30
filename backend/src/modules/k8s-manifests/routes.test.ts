import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';

const mockManifests = [
  { filename: 'namespace.yaml', content: 'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: client-ns\n' },
  { filename: 'resource-quota.yaml', content: 'apiVersion: v1\nkind: ResourceQuota\n' },
];

vi.mock('./generator.js', () => ({
  generateClientManifests: vi.fn().mockResolvedValue(mockManifests),
}));

const { k8sManifestRoutes } = await import('./routes.js');

describe('k8s-manifest routes', () => {
  let app: FastifyInstance;
  let adminToken: string;
  let readOnlyToken: string;
  let supportToken: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);

    app.decorate('db', {});
    await app.register(k8sManifestRoutes, { prefix: '/api/v1' });
    await app.ready();

    adminToken = app.jwt.sign({ sub: 'admin-1', role: 'super_admin', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
    readOnlyToken = app.jwt.sign({ sub: 'reader-1', role: 'read_only', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
    supportToken = app.jwt.sign({ sub: 'support-1', role: 'support', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
  });

  afterAll(async () => {
    await app.close();
  });

  it('should require auth', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/clients/550e8400-e29b-41d4-a716-446655440000/manifests',
    });
    expect(res.statusCode).toBe(401);
  });

  it('should reject read_only role', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/clients/550e8400-e29b-41d4-a716-446655440000/manifests',
      headers: { authorization: `Bearer ${readOnlyToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('should reject support role', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/clients/550e8400-e29b-41d4-a716-446655440000/manifests',
      headers: { authorization: `Bearer ${supportToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('should generate manifests with empty body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/clients/550e8400-e29b-41d4-a716-446655440000/manifests',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.manifests).toHaveLength(2);
    expect(body.data.namespace).toBe('client-ns');
  });

  it('should generate manifests with overrides', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/clients/550e8400-e29b-41d4-a716-446655440000/manifests',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        overrides: {
          cpu_limit: '2000m',
          memory_limit: '4Gi',
          replica_count: 3,
        },
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it('should reject invalid replica_count', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/clients/550e8400-e29b-41d4-a716-446655440000/manifests',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        overrides: { replica_count: 99 },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });
});
