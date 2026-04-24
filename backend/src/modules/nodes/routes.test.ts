import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted so the vi.mock factory (also hoisted) can reference these
// without tripping the "Cannot access X before initialization" error.
const { mockListNamespacedPod, mockPatchNode } = vi.hoisted(() => ({
  mockListNamespacedPod: vi.fn(),
  mockPatchNode: vi.fn(),
}));

vi.mock('../k8s-provisioner/k8s-client.js', () => ({
  createK8sClients: vi.fn().mockReturnValue({
    core: {
      listNamespacedPod: mockListNamespacedPod,
      patchNode: mockPatchNode,
    },
  }),
}));

import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { nodeRoutes } from './routes.js';

const JWT_SECRET = 'test-jwt-secret-for-nodes-routes-unit-tests';

function makeSelectChain(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(rows),
        }),
      }),
      orderBy: vi.fn().mockResolvedValue(rows),
    }),
  };
}

interface MockDb {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
}

function buildApp() {
  const app = Fastify({ logger: false });
  const mockDb: MockDb = {
    select: vi.fn(),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  };
  app.decorate('db', mockDb as unknown);
  app.decorate('config', { KUBECONFIG_PATH: '/tmp/test-kubeconfig.yaml' });
  return { app, mockDb };
}

async function setupApp() {
  const { app, mockDb } = buildApp();
  await app.register(fastifyJwt, { secret: JWT_SECRET });
  await app.register(nodeRoutes, { prefix: '/api/v1' });
  await app.ready();
  const adminToken = app.jwt.sign({ sub: 'admin-1', role: 'super_admin', panel: 'admin' });
  const clientToken = app.jwt.sign({ sub: 'client-1', role: 'client_admin', panel: 'client', clientId: 'c1' });
  return { app, mockDb, adminToken, clientToken };
}

describe('Nodes routes', () => {
  beforeEach(() => {
    mockListNamespacedPod.mockReset();
    mockPatchNode.mockReset();
  });

  describe('GET /api/v1/admin/nodes', () => {
    it('rejects requests without auth (401)', async () => {
      const { app } = await setupApp();
      const res = await app.inject({ method: 'GET', url: '/api/v1/admin/nodes' });
      expect(res.statusCode).toBe(401);
    });

    it('rejects client_admin tokens (403)', async () => {
      const { app, clientToken } = await setupApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/nodes',
        headers: { authorization: `Bearer ${clientToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('returns list envelope with total', async () => {
      const { app, mockDb, adminToken } = await setupApp();
      mockDb.select.mockReturnValue(makeSelectChain([
        { name: 'staging', role: 'server', canHostClientWorkloads: true },
      ]));
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/nodes',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data).toHaveLength(1);
    });
  });

  describe('GET /api/v1/admin/nodes/:name', () => {
    it('returns 404 when node missing', async () => {
      const { app, mockDb, adminToken } = await setupApp();
      mockDb.select.mockReturnValue(makeSelectChain([]));
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/nodes/nonexistent',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns the node row on success', async () => {
      const { app, mockDb, adminToken } = await setupApp();
      mockDb.select.mockReturnValue(makeSelectChain([
        { name: 'staging', role: 'server', canHostClientWorkloads: true, labels: {}, taints: [] },
      ]));
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/nodes/staging',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.name).toBe('staging');
    });
  });

  describe('PATCH /api/v1/admin/nodes/:name', () => {
    it('returns 400 on schema violation (invalid role)', async () => {
      const { app, adminToken } = await setupApp();
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/admin/nodes/staging',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { role: 'not-a-role' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns NODE_DEMOTION_BLOCKED when server→worker with system pods', async () => {
      const { app, mockDb, adminToken } = await setupApp();
      mockDb.select.mockReturnValue(makeSelectChain([
        { name: 'staging', role: 'server', canHostClientWorkloads: false, labels: {}, taints: [] },
      ]));
      mockListNamespacedPod.mockResolvedValueOnce({
        items: [{ metadata: { name: 'platform-api-xyz' } }],
      }).mockResolvedValue({ items: [] });
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/admin/nodes/staging',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { role: 'worker' },
      });
      expect(res.statusCode).toBe(409);
      // Default Fastify error handler isn't wired in this minimal app,
      // so the envelope shape differs from production; assert on
      // statusCode + that we aborted before touching k8s writes.
      expect(mockPatchNode).not.toHaveBeenCalled();
    });

    it('allows force=true to bypass the safety check', async () => {
      const { app, mockDb, adminToken } = await setupApp();
      let selectCallCount = 0;
      mockDb.select.mockImplementation(() => {
        selectCallCount += 1;
        // First call (pre-update) shows server role; second (post-update
        // refresh) shows the new worker role so the handler has
        // something to return.
        return makeSelectChain([
          selectCallCount === 1
            ? { name: 'staging', role: 'server', canHostClientWorkloads: false, labels: {}, taints: [] }
            : { name: 'staging', role: 'worker', canHostClientWorkloads: true, labels: {}, taints: [] },
        ]);
      });
      mockPatchNode.mockResolvedValue({});
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/admin/nodes/staging',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { role: 'worker', force: true },
      });
      expect(res.statusCode).toBe(200);
      expect(mockPatchNode).toHaveBeenCalled();
      expect(mockListNamespacedPod).not.toHaveBeenCalled();
    });
  });
});
