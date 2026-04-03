import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { K8sClients } from './k8s-client.js';

// ─── Mock K8s API responses ────────────────────────────────────────────────

function createMockK8sClients(): K8sClients {
  return {
    core: {
      createNamespace: vi.fn().mockResolvedValue({}),
      readNamespace: vi.fn().mockRejectedValue(Object.assign(new Error('Not found'), { statusCode: 404 })),
      createNamespacedResourceQuota: vi.fn().mockResolvedValue({}),
      createNamespacedPersistentVolumeClaim: vi.fn().mockResolvedValue({}),
      createNamespacedServiceAccount: vi.fn().mockResolvedValue({}),
      createNamespacedService: vi.fn().mockResolvedValue({}),
    } as unknown as K8sClients['core'],
    apps: {
      createNamespacedDeployment: vi.fn().mockResolvedValue({}),
    } as unknown as K8sClients['apps'],
    networking: {
      createNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
      createNamespacedIngress: vi.fn().mockResolvedValue({}),
    } as unknown as K8sClients['networking'],
  };
}

// ─── Mock DB ────────────────────────────────────────────────────────────────

function createMockDb() {
  const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
  return {
    updates,
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
  };
}

describe('K8s Provisioner Service', () => {
  let mockK8s: K8sClients;
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    mockK8s = createMockK8sClients();
    mockDb = createMockDb();
  });

  describe('provisionNamespace', () => {
    it('should define PROVISION_STEPS with correct step names', async () => {
      const { PROVISION_STEPS } = await import('./service.js');
      expect(PROVISION_STEPS).toContain('Create Namespace');
      expect(PROVISION_STEPS).toContain('Create ResourceQuota');
      expect(PROVISION_STEPS).toContain('Create NetworkPolicy');
      expect(PROVISION_STEPS).toContain('Create PVC');
      expect(PROVISION_STEPS.length).toBeGreaterThanOrEqual(4);
    });

    it('should create namespace with correct labels', async () => {
      const { applyNamespace } = await import('./service.js');
      await applyNamespace(mockK8s, 'client-test-ns', 'client-123');
      expect(mockK8s.core.createNamespace).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            metadata: expect.objectContaining({
              name: 'client-test-ns',
              labels: expect.objectContaining({
                platform: 'k8s-hosting',
                client: 'client-123',
              }),
            }),
          }),
        }),
      );
    });

    it('should skip namespace creation if it already exists', async () => {
      (mockK8s.core.readNamespace as ReturnType<typeof vi.fn>).mockResolvedValue({});
      const { applyNamespace } = await import('./service.js');
      await applyNamespace(mockK8s, 'existing-ns', 'client-123');
      expect(mockK8s.core.createNamespace).not.toHaveBeenCalled();
    });

    it('should create ResourceQuota with plan limits plus system reserve', async () => {
      const { applyResourceQuota } = await import('./service.js');
      await applyResourceQuota(mockK8s, 'test-ns', { cpu: '2', memory: '4', storage: '50' });
      // Plan: 2 CPU / 4Gi + system reserve: 0.5 CPU / 0.5 Gi
      expect(mockK8s.core.createNamespacedResourceQuota).toHaveBeenCalledWith(
        expect.objectContaining({
          namespace: 'test-ns',
          body: expect.objectContaining({
            spec: expect.objectContaining({
              hard: {
                'limits.cpu': '2.50',
                'limits.memory': '4.50Gi',
                'requests.storage': '50Gi',
              },
            }),
          }),
        }),
      );
    });

    it('should create NetworkPolicy allowing only ingress-nginx', async () => {
      const { applyNetworkPolicy } = await import('./service.js');
      await applyNetworkPolicy(mockK8s, 'test-ns');
      expect(mockK8s.networking.createNamespacedNetworkPolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          namespace: 'test-ns',
          body: expect.objectContaining({
            spec: expect.objectContaining({
              policyTypes: ['Ingress'],
            }),
          }),
        }),
      );
    });

    it('should create PVC with correct storage class and size', async () => {
      const { applyPVC } = await import('./service.js');
      await applyPVC(mockK8s, 'test-ns', '50', 'local-path');
      expect(mockK8s.core.createNamespacedPersistentVolumeClaim).toHaveBeenCalledWith(
        expect.objectContaining({
          namespace: 'test-ns',
          body: expect.objectContaining({
            metadata: expect.objectContaining({
              name: 'test-ns-storage',
            }),
            spec: expect.objectContaining({
              storageClassName: 'local-path',
              resources: { requests: { storage: '50Gi' } },
            }),
          }),
        }),
      );
    });
  });

  describe('buildStepsLog', () => {
    it('should initialize all steps as pending', async () => {
      const { buildStepsLog, PROVISION_STEPS } = await import('./service.js');
      const log = buildStepsLog(PROVISION_STEPS);
      expect(log).toHaveLength(PROVISION_STEPS.length);
      for (const step of log) {
        expect(step.status).toBe('pending');
        expect(step.startedAt).toBeNull();
        expect(step.completedAt).toBeNull();
      }
    });
  });

  describe('updateStepStatus', () => {
    it('should mark a step as running with timestamp', async () => {
      const { buildStepsLog, updateStepStatus, PROVISION_STEPS } = await import('./service.js');
      const log = buildStepsLog(PROVISION_STEPS);
      const updated = updateStepStatus(log, 'Create Namespace', 'running');
      const step = updated.find(s => s.name === 'Create Namespace');
      expect(step?.status).toBe('running');
      expect(step?.startedAt).toBeTruthy();
    });

    it('should mark a step as completed with timestamp', async () => {
      const { buildStepsLog, updateStepStatus, PROVISION_STEPS } = await import('./service.js');
      let log = buildStepsLog(PROVISION_STEPS);
      log = updateStepStatus(log, 'Create Namespace', 'running');
      log = updateStepStatus(log, 'Create Namespace', 'completed');
      const step = log.find(s => s.name === 'Create Namespace');
      expect(step?.status).toBe('completed');
      expect(step?.completedAt).toBeTruthy();
    });

    it('should mark a step as failed with error message', async () => {
      const { buildStepsLog, updateStepStatus, PROVISION_STEPS } = await import('./service.js');
      let log = buildStepsLog(PROVISION_STEPS);
      log = updateStepStatus(log, 'Create PVC', 'failed', 'Storage class not found');
      const step = log.find(s => s.name === 'Create PVC');
      expect(step?.status).toBe('failed');
      expect(step?.error).toBe('Storage class not found');
    });
  });
});
