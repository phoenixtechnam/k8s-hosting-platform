import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

function createMockK8sClients(): K8sClients {
  const notFound = () => Object.assign(new Error('HTTP-Code: 404'), { statusCode: 404 });
  return {
    core: {
      readNamespacedService: vi.fn().mockRejectedValue(notFound()),
      createNamespacedService: vi.fn().mockResolvedValue({}),
      readNamespacedSecret: vi.fn().mockRejectedValue(notFound()),
      createNamespacedSecret: vi.fn().mockResolvedValue({}),
      listNamespacedPod: vi.fn().mockResolvedValue({ items: [] }),
      deleteNamespacedService: vi.fn().mockResolvedValue({}),
    } as unknown as K8sClients['core'],
    apps: {
      readNamespacedDeployment: vi.fn().mockRejectedValue(notFound()),
      createNamespacedDeployment: vi.fn().mockResolvedValue({}),
      replaceNamespacedDeployment: vi.fn().mockResolvedValue({}),
      deleteNamespacedDeployment: vi.fn().mockResolvedValue({}),
      patchNamespacedDeployment: vi.fn().mockResolvedValue({}),
    } as unknown as K8sClients['apps'],
    rbac: {
      readNamespacedRole: vi.fn().mockRejectedValue(notFound()),
      createNamespacedRole: vi.fn().mockResolvedValue({}),
      createNamespacedRoleBinding: vi.fn().mockResolvedValue({}),
    } as unknown as K8sClients['rbac'],
    networking: {} as K8sClients['networking'],
  } as K8sClients;
}

describe('File Manager K8s Lifecycle', () => {
  let mockK8s: K8sClients;

  beforeEach(() => {
    mockK8s = createMockK8sClients();
  });

  describe('ensureFileManagerRunning', () => {
    it('should create deployment and service if not exists', async () => {
      const { ensureFileManagerRunning } = await import('./k8s-lifecycle.js');
      await ensureFileManagerRunning(mockK8s, 'client-test-ns', 'file-manager:latest');
      expect(mockK8s.apps.createNamespacedDeployment).toHaveBeenCalled();
      expect(mockK8s.core.createNamespacedService).toHaveBeenCalled();
    });

    it('should skip recreation if deployment exists with correct spec and >=1 replica', async () => {
      // ADR-037: deployBody has memory limit 128Mi but NO cpu limit.
      // Match that here so the mismatch check produces resourcesMismatch=false.
      (mockK8s.apps.readNamespacedDeployment as ReturnType<typeof vi.fn>).mockResolvedValue({
        spec: { replicas: 1, template: { spec: {
          volumes: [{ persistentVolumeClaim: { claimName: 'client-test-ns-storage' } }],
          containers: [{ image: 'file-manager:latest', securityContext: { capabilities: { add: ['SYS_ADMIN', 'DAC_OVERRIDE', 'FOWNER', 'CHOWN'] } }, imagePullPolicy: 'Always', resources: { limits: { memory: '128Mi' } } }],
        } } },
      });
      (mockK8s.core.readNamespacedService as ReturnType<typeof vi.fn>).mockResolvedValue({});
      const { ensureFileManagerRunning } = await import('./k8s-lifecycle.js');
      await ensureFileManagerRunning(mockK8s, 'client-test-ns', 'file-manager:latest');
      expect(mockK8s.apps.deleteNamespacedDeployment).not.toHaveBeenCalled();
      // Should not recreate since PVC is correct
      expect(mockK8s.apps.createNamespacedDeployment).not.toHaveBeenCalled();
      // Replicas already at 1 → no scale patch either.
      expect(mockK8s.apps.patchNamespacedDeployment).not.toHaveBeenCalled();
    });

    it('should rescale to 1 if deployment exists with correct spec but cleanup-loop scaled it to 0', async () => {
      (mockK8s.apps.readNamespacedDeployment as ReturnType<typeof vi.fn>).mockResolvedValue({
        spec: { replicas: 0, template: { spec: {
          volumes: [{ persistentVolumeClaim: { claimName: 'client-test-ns-storage' } }],
          containers: [{ image: 'file-manager:latest', securityContext: { capabilities: { add: ['SYS_ADMIN', 'DAC_OVERRIDE', 'FOWNER', 'CHOWN'] } }, imagePullPolicy: 'Always', resources: { limits: { memory: '128Mi' } } }],
        } } },
      });
      (mockK8s.core.readNamespacedService as ReturnType<typeof vi.fn>).mockResolvedValue({});
      const { ensureFileManagerRunning } = await import('./k8s-lifecycle.js');
      await ensureFileManagerRunning(mockK8s, 'client-test-ns', 'file-manager:latest');
      expect(mockK8s.apps.deleteNamespacedDeployment).not.toHaveBeenCalled();
      expect(mockK8s.apps.createNamespacedDeployment).not.toHaveBeenCalled();
      // Bug fix: must rescale from 0 → 1, otherwise /start is a no-op.
      expect(mockK8s.apps.patchNamespacedDeployment).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'file-manager',
          namespace: 'client-test-ns',
          body: { spec: { replicas: 1 } },
        }),
        expect.anything(),
      );
    });

    it('should recreate if existing deployment carries a stale cpu limit (pre-ADR-037 migration)', async () => {
      // Pre-ADR-037 spec had `cpu: '500m'` limit. ADR-037 removed the
      // cpu limit (asymmetric QoS — cpu request only). Existing
      // deployments with a leftover cpu limit must recreate so they
      // converge to the new spec. Caught 2026-05-14 (lifecycle-e2e):
      // the old mismatch check was `existingCpuLim !== '500m'`, which
      // wrongly fired on every fresh ADR-037-compliant deployment
      // (cpuLim='') causing infinite recreate-at-replicas-0 loops,
      // i.e. /files/start was permanently a no-op.
      (mockK8s.apps.readNamespacedDeployment as ReturnType<typeof vi.fn>).mockResolvedValue({
        spec: { replicas: 1, template: { spec: {
          volumes: [{ persistentVolumeClaim: { claimName: 'client-test-ns-storage' } }],
          containers: [{ image: 'file-manager:latest', securityContext: { capabilities: { add: ['SYS_ADMIN', 'DAC_OVERRIDE', 'FOWNER', 'CHOWN'] } }, imagePullPolicy: 'Always', resources: { limits: { cpu: '500m', memory: '128Mi' } } }],
        } } },
      });
      (mockK8s.core.readNamespacedService as ReturnType<typeof vi.fn>).mockResolvedValue({});
      const { ensureFileManagerRunning } = await import('./k8s-lifecycle.js');
      await ensureFileManagerRunning(mockK8s, 'client-test-ns', 'file-manager:latest');
      // Stale cpu limit present → delete + recreate.
      expect(mockK8s.apps.deleteNamespacedDeployment).toHaveBeenCalled();
      expect(mockK8s.apps.createNamespacedDeployment).toHaveBeenCalled();
    });

    it('should delete and recreate deployment if PVC claim is wrong', async () => {
      (mockK8s.apps.readNamespacedDeployment as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({}) // first call: exists check
        .mockResolvedValueOnce({   // second call: read spec
          spec: { template: { spec: { volumes: [{ persistentVolumeClaim: { claimName: 'wrong-pvc' } }] } } },
        });
      (mockK8s.core.readNamespacedService as ReturnType<typeof vi.fn>).mockResolvedValue({});
      const { ensureFileManagerRunning } = await import('./k8s-lifecycle.js');
      await ensureFileManagerRunning(mockK8s, 'client-test-ns', 'file-manager:latest');
      expect(mockK8s.apps.deleteNamespacedDeployment).toHaveBeenCalled();
      expect(mockK8s.apps.createNamespacedDeployment).toHaveBeenCalled();
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
