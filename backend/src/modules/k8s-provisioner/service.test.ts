import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { K8sClients } from './k8s-client.js';

// ─── Mock K8s API responses ────────────────────────────────────────────────

function createMockK8sClients(): K8sClients {
  return {
    core: {
      createNamespace: vi.fn().mockResolvedValue({}),
      readNamespace: vi.fn().mockRejectedValue(Object.assign(new Error('Not found'), { statusCode: 404 })),
      createNamespacedResourceQuota: vi.fn().mockResolvedValue({}),
      // Phase F+G fix: applyPVC now reads-then-creates to dodge the
      // ResourceQuota admission firing 403 before the existence check.
      // Mock 404 so the create branch still runs in the existing tests.
      readNamespacedPersistentVolumeClaim: vi.fn().mockRejectedValue(
        Object.assign(new Error('HTTP-Code: 404'), { statusCode: 404 }),
      ),
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

    it('should create TWO ResourceQuotas: a Pod-scoped one (CPU/memory) + an unscoped storage one', async () => {
      const { applyResourceQuota } = await import('./service.js');
      await applyResourceQuota(mockK8s, 'test-ns', { cpu: '2', memory: '4', storage: '50' });
      // K8s rejects requests.storage under a PriorityClass scope
      // ("unsupported scope applied to resource"), so we split:
      //   - <ns>-quota          : PriorityClass=tenant-default → counts cpu/memory of tenant Pods
      //   - <ns>-storage-quota  : unscoped → namespace-wide PVC budget
      const calls = (mockK8s.core.createNamespacedResourceQuota as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.length).toBe(2);
      const podCall = calls.find((c) => (c[0] as { body: { metadata: { name: string } } }).body.metadata.name === 'test-ns-quota');
      const storageCall = calls.find((c) => (c[0] as { body: { metadata: { name: string } } }).body.metadata.name === 'test-ns-storage-quota');
      expect(podCall).toBeDefined();
      expect(storageCall).toBeDefined();
      expect((podCall![0] as { body: { spec: { hard: Record<string, string>; scopeSelector: object } } }).body.spec).toMatchObject({
        hard: { 'limits.cpu': '2', 'limits.memory': '4Gi' },
        scopeSelector: {
          matchExpressions: [
            { scopeName: 'PriorityClass', operator: 'In', values: ['tenant-default'] },
          ],
        },
      });
      expect((storageCall![0] as { body: { spec: { hard: Record<string, string> } } }).body.spec.hard).toEqual({
        'requests.storage': '50Gi',
      });
    });

    it('should create two NetworkPolicies: deny cross-ns + allow intra-ns', async () => {
      const { applyNetworkPolicy } = await import('./service.js');
      await applyNetworkPolicy(mockK8s, 'test-ns');
      expect(mockK8s.networking.createNamespacedNetworkPolicy).toHaveBeenCalledTimes(3);

      const mockFn = mockK8s.networking.createNamespacedNetworkPolicy as unknown as ReturnType<typeof vi.fn>;
      const calls = mockFn.mock.calls as Array<[{ body: { metadata: { name: string }; spec: { ingress: Array<{ _from?: unknown[] }> } } }]>;
      const names = calls.map(c => c[0].body.metadata.name).sort();
      expect(names).toEqual(['allow-intra-namespace', 'allow-platform-api', 'default-deny-ingress']);

      // The intra-namespace rule is the critical one for multi-component
      // apps — without it, default-deny-ingress blocks wordpress → mariadb.
      const intra = calls.find(c => c[0].body.metadata.name === 'allow-intra-namespace')![0].body;
      expect(intra.spec.ingress[0]._from).toEqual([{ podSelector: {} }]);
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

    it('should label new tenant PVCs into the Longhorn default backup group', async () => {
      // Silent-footgun guard: every fresh tenant PVC must carry the
      // recurring-job-group label so Longhorn's backup schedule picks
      // it up. Missing label = silently excluded from backups.
      const { applyPVC } = await import('./service.js');
      await applyPVC(mockK8s, 'client-fresh', '10', 'longhorn');
      const [call] = mockK8s.core.createNamespacedPersistentVolumeClaim.mock.calls;
      const labels = call[0].body.metadata.labels;
      expect(labels['recurring-job-group.longhorn.io/default']).toBe('enabled');
      expect(labels['app.kubernetes.io/part-of']).toBe('hosting-platform');
      expect(labels['app.kubernetes.io/component']).toBe('tenant-storage');
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

  describe('formatK8sError', () => {
    it('extracts the k8s Status message from an embedded response body', async () => {
      const { formatK8sError } = await import('./service.js');
      // Shape thrown by @kubernetes/client-node v1.4 on a 403 — the body is
      // a JSON-stringified Status object, quotes are backslash-escaped.
      const body = JSON.stringify({
        kind: 'Status',
        apiVersion: 'v1',
        status: 'Failure',
        message: 'resourcequotas is forbidden: User "system:serviceaccount:platform:platform-api" cannot create resource "resourcequotas" in the namespace "client-x"',
        reason: 'Forbidden',
        code: 403,
      });
      const raw = `HTTP-Code: 403\nMessage: Unknown API Status Code!\nBody: ${JSON.stringify(body)}\nHeaders: {"audit-id":"abc"}`;
      const out = formatK8sError(new Error(raw));
      expect(out).toContain('resourcequotas is forbidden');
      expect(out).toContain('HTTP 403');
      expect(out).not.toContain('audit-id');
      expect(out).not.toContain('Headers:');
    });

    it('falls back to first line when the error has no parsable body', async () => {
      const { formatK8sError } = await import('./service.js');
      const err = new Error('Connection refused\nstack trace...');
      expect(formatK8sError(err)).toBe('Connection refused');
    });

    it('truncates very long single-line messages', async () => {
      const { formatK8sError } = await import('./service.js');
      const err = new Error('x'.repeat(1000));
      const out = formatK8sError(err);
      expect(out.length).toBeLessThanOrEqual(501);
      expect(out.endsWith('…')).toBe(true);
    });

    it('handles non-Error values', async () => {
      const { formatK8sError } = await import('./service.js');
      expect(formatK8sError('boom')).toBe('boom');
      expect(formatK8sError(42)).toBe('42');
    });
  });
});
