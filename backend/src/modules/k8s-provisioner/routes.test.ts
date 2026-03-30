import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the k8s-client module before importing routes
vi.mock('./k8s-client.js', () => ({
  createK8sClients: vi.fn().mockReturnValue({
    core: {
      createNamespace: vi.fn().mockResolvedValue({}),
      readNamespace: vi.fn().mockRejectedValue({ statusCode: 404 }),
      createNamespacedResourceQuota: vi.fn().mockResolvedValue({}),
      createNamespacedPersistentVolumeClaim: vi.fn().mockResolvedValue({}),
      createNamespacedServiceAccount: vi.fn().mockResolvedValue({}),
      createNamespacedService: vi.fn().mockResolvedValue({}),
    },
    apps: {
      createNamespacedDeployment: vi.fn().mockResolvedValue({}),
    },
    networking: {
      createNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
      createNamespacedIngress: vi.fn().mockResolvedValue({}),
    },
  }),
}));

// Mock the service to avoid real k8s calls in route tests
vi.mock('./service.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    runProvisionNamespace: vi.fn().mockResolvedValue(undefined),
  };
});

import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { provisioningRoutes } from './routes.js';

const JWT_SECRET = 'test-jwt-secret-for-provisioning-routes';

function buildTestApp() {
  const app = Fastify({ logger: false });

  // Mock DB with chain methods
  const mockDb = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
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
  };

  app.decorate('db', mockDb as unknown);
  app.decorate('config', { KUBECONFIG_PATH: '/tmp/test-kubeconfig.yaml' });

  return { app, mockDb };
}

async function setupApp() {
  const { app, mockDb } = buildTestApp();
  await app.register(fastifyJwt, { secret: JWT_SECRET });
  await app.register(provisioningRoutes, { prefix: '/api/v1' });
  await app.ready();

  const adminToken = app.jwt.sign({
    sub: 'admin-user-123',
    role: 'super_admin',
    panel: 'admin',
  });

  const clientToken = app.jwt.sign({
    sub: 'client-user-123',
    role: 'client_admin',
    panel: 'client',
    clientId: 'client-123',
  });

  return { app, mockDb, adminToken, clientToken };
}

describe('Provisioning Routes', () => {
  describe('POST /api/v1/admin/clients/:clientId/provision', () => {
    it('should return 401 without auth', async () => {
      const { app } = await setupApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/clients/some-id/provision',
      });
      expect(res.statusCode).toBe(401);
    });

    it('should return 403 for client_admin role', async () => {
      const { app, clientToken } = await setupApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/clients/some-id/provision',
        headers: { authorization: `Bearer ${clientToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('should return 404 when client not found', async () => {
      const { app, mockDb, adminToken } = await setupApp();
      // DB returns empty for client lookup
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/clients/nonexistent-id/provision',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    });

    it('should return 202 when provisioning is triggered', async () => {
      const { app, mockDb, adminToken } = await setupApp();
      // DB returns a client
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'client-123',
              companyName: 'Test Co',
              kubernetesNamespace: 'client-test-ns',
              planId: 'plan-1',
              provisioningStatus: 'unprovisioned',
            }]),
          }),
        }),
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/clients/client-123/provision',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(202);
      const body = JSON.parse(res.body);
      expect(body.data).toHaveProperty('taskId');
      expect(body.data).toHaveProperty('status', 'pending');
    });
  });

  describe('GET /api/v1/admin/clients/:clientId/provision/status', () => {
    it('should return 401 without auth', async () => {
      const { app } = await setupApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/clients/some-id/provision/status',
      });
      expect(res.statusCode).toBe(401);
    });

    it('should return task status when found', async () => {
      const { app, mockDb, adminToken } = await setupApp();
      const now = new Date();
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{
                id: 'task-1',
                clientId: 'client-123',
                type: 'provision_namespace',
                status: 'running',
                currentStep: 'Create Namespace',
                totalSteps: 4,
                completedSteps: 1,
                stepsLog: [],
                errorMessage: null,
                startedBy: 'admin-123',
                startedAt: now,
                completedAt: null,
                createdAt: now,
                updatedAt: now,
              } as Record<string, unknown>]),
            }),
          }),
        }),
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/clients/client-123/provision/status',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.status).toBe('running');
    });
  });

  describe('GET /api/v1/admin/provisioning/tasks', () => {
    it('should return active tasks summary', async () => {
      const { app, mockDb, adminToken } = await setupApp();
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/provisioning/tasks',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data).toHaveProperty('count');
      expect(body.data).toHaveProperty('tasks');
    });
  });
});
