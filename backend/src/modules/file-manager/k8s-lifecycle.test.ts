import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

function createMockK8sClients(): K8sClients {
  return {
    core: {
      readNamespacedService: vi.fn().mockRejectedValue(Object.assign(new Error('HTTP-Code: 404'), { statusCode: 404 })),
      createNamespacedService: vi.fn().mockResolvedValue({}),
      listNamespacedPod: vi.fn().mockResolvedValue({ items: [] }),
      deleteNamespacedService: vi.fn().mockResolvedValue({}),
    } as unknown as K8sClients['core'],
    apps: {
      readNamespacedDeployment: vi.fn().mockRejectedValue(Object.assign(new Error('HTTP-Code: 404'), { statusCode: 404 })),
      createNamespacedDeployment: vi.fn().mockResolvedValue({}),
      deleteNamespacedDeployment: vi.fn().mockResolvedValue({}),
    } as unknown as K8sClients['apps'],
    networking: {} as K8sClients['networking'],
  };
}

describe('File Manager K8s Lifecycle', () => {
  let mockK8s: K8sClients;

  beforeEach(() => {
    mockK8s = createMockK8sClients();
  });

  describe('ensureFileManagerRunning', () => {
    it('should create deployment and service if not exists', async () => {
      const { ensureFileManagerRunning } = await import('./k8s-lifecycle.js');
      await ensureFileManagerRunning(mockK8s, 'client-test-ns', 'file-manager-sidecar:latest');
      expect(mockK8s.apps.createNamespacedDeployment).toHaveBeenCalled();
      expect(mockK8s.core.createNamespacedService).toHaveBeenCalled();
    });

    it('should skip creation if deployment already exists', async () => {
      (mockK8s.apps.readNamespacedDeployment as ReturnType<typeof vi.fn>).mockResolvedValue({});
      (mockK8s.core.readNamespacedService as ReturnType<typeof vi.fn>).mockResolvedValue({});
      const { ensureFileManagerRunning } = await import('./k8s-lifecycle.js');
      await ensureFileManagerRunning(mockK8s, 'client-test-ns', 'file-manager-sidecar:latest');
      expect(mockK8s.apps.createNamespacedDeployment).not.toHaveBeenCalled();
    });
  });

  describe('stopFileManager', () => {
    it('should delete deployment and service', async () => {
      const { stopFileManager } = await import('./k8s-lifecycle.js');
      await stopFileManager(mockK8s, 'client-test-ns');
      expect(mockK8s.apps.deleteNamespacedDeployment).toHaveBeenCalled();
      expect(mockK8s.core.deleteNamespacedService).toHaveBeenCalled();
    });
  });

  describe('getFileManagerStatus', () => {
    it('should return not_deployed when deployment does not exist', async () => {
      const { getFileManagerStatus } = await import('./k8s-lifecycle.js');
      const status = await getFileManagerStatus(mockK8s, 'client-test-ns');
      expect(status.phase).toBe('not_deployed');
      expect(status.ready).toBe(false);
    });

    it('should return ready when pod is running', async () => {
      (mockK8s.apps.readNamespacedDeployment as ReturnType<typeof vi.fn>).mockResolvedValue({});
      (mockK8s.core.listNamespacedPod as ReturnType<typeof vi.fn>).mockResolvedValue({
        items: [{ status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } }],
      });
      const { getFileManagerStatus } = await import('./k8s-lifecycle.js');
      const status = await getFileManagerStatus(mockK8s, 'client-test-ns');
      expect(status.phase).toBe('ready');
      expect(status.ready).toBe(true);
    });

    it('should return starting when pod is pending', async () => {
      (mockK8s.apps.readNamespacedDeployment as ReturnType<typeof vi.fn>).mockResolvedValue({});
      (mockK8s.core.listNamespacedPod as ReturnType<typeof vi.fn>).mockResolvedValue({
        items: [{ status: { phase: 'Pending', conditions: [] } }],
      });
      const { getFileManagerStatus } = await import('./k8s-lifecycle.js');
      const status = await getFileManagerStatus(mockK8s, 'client-test-ns');
      expect(status.phase).toBe('starting');
      expect(status.ready).toBe(false);
    });
  });
});
