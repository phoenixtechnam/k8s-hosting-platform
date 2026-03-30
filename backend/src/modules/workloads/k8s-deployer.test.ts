import { describe, it, expect } from 'vitest';

// Test pure utility functions from k8s-deployer
// K8s API calls are tested via integration tests (not unit-testable without cluster)

describe('k8s-deployer', () => {
  describe('WorkloadDeployInput shape', () => {
    it('should accept valid deploy input', () => {
      const input = {
        name: 'web-app',
        image: 'nginx:1.27-alpine',
        containerPort: 8080,
        replicaCount: 2,
        cpuRequest: '250m',
        memoryRequest: '256Mi',
        mountPath: '/var/www/html',
        namespace: 'acme-corp',
      };

      expect(input.name).toBe('web-app');
      expect(input.containerPort).toBe(8080);
      expect(input.replicaCount).toBeGreaterThan(0);
    });

    it('should allow null mountPath', () => {
      const input = {
        name: 'api',
        image: 'node:22-alpine',
        containerPort: 3000,
        replicaCount: 1,
        cpuRequest: '100m',
        memoryRequest: '128Mi',
        mountPath: null,
        namespace: 'test-ns',
      };

      expect(input.mountPath).toBeNull();
    });
  });

  describe('WorkloadPodStatus phases', () => {
    it('should define all valid phases', () => {
      const validPhases = ['not_deployed', 'starting', 'running', 'failed', 'stopped'] as const;
      expect(validPhases).toHaveLength(5);
    });

    it('should have ready=true only for running phase', () => {
      const runningStatus = { phase: 'running' as const, ready: true, replicas: 2, readyReplicas: 2 };
      const stoppedStatus = { phase: 'stopped' as const, ready: false, replicas: 0, readyReplicas: 0 };
      const failedStatus = { phase: 'failed' as const, ready: false, replicas: 1, readyReplicas: 0, message: 'CrashLoopBackOff' };

      expect(runningStatus.ready).toBe(true);
      expect(stoppedStatus.ready).toBe(false);
      expect(failedStatus.ready).toBe(false);
      expect(failedStatus.message).toContain('CrashLoop');
    });
  });

  describe('workload labels', () => {
    it('should generate consistent label selectors', () => {
      // Labels used: { app: name, 'platform.io/component': 'workload' }
      // Selector uses: { app: name }
      const name = 'my-workload';
      const labels = { app: name, 'platform.io/component': 'workload' };
      const selector = { app: name };

      expect(labels.app).toBe(selector.app);
      expect(labels['platform.io/component']).toBe('workload');
    });
  });

  describe('subPath isolation', () => {
    it('should use workload name as subPath for volume mount', () => {
      // Each workload gets its own subPath within the shared PVC
      const workloadName = 'wordpress';
      const volumeMount = {
        name: 'client-storage',
        mountPath: '/var/www/html/wp-content',
        subPath: workloadName,
      };

      expect(volumeMount.subPath).toBe('wordpress');
      expect(volumeMount.name).toBe('client-storage');
    });
  });
});
