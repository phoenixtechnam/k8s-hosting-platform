import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { K8sClients } from './k8s-client.js';

// ─── Mock K8s API responses ────────────────────────────────────────────────

function createMockK8sTenants(): K8sClients {
  return {
    core: {
      createNamespace: vi.fn().mockResolvedValue({}),
      readNamespace: vi.fn().mockRejectedValue(Object.assign(new Error('Not found'), { statusCode: 404 })),
      patchNamespace: vi.fn().mockResolvedValue({}),
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
    mockK8s = createMockK8sTenants();
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

    it('should create namespace with platform + tenant labels', async () => {
      const { applyNamespace } = await import('./service.js');
      await applyNamespace(mockK8s, 'tenant-test-ns', 'tenant-123');
      expect(mockK8s.core.createNamespace).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            metadata: expect.objectContaining({
              name: 'tenant-test-ns',
              labels: expect.objectContaining({
                platform: 'k8s-hosting',
                tenant: 'tenant-123',
              }),
            }),
          }),
        }),
      );
    });

    // ADR-036: PSS labels on every tenant namespace.
    it('should set Pod Security Standards labels at creation', async () => {
      const { applyNamespace } = await import('./service.js');
      await applyNamespace(mockK8s, 'tenant-test-ns', 'tenant-123');
      const callBody = (mockK8s.core.createNamespace as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        body: { metadata: { labels: Record<string, string> } };
      };
      expect(callBody.body.metadata.labels).toMatchObject({
        'pod-security.kubernetes.io/enforce': 'baseline',
        'pod-security.kubernetes.io/enforce-version': 'latest',
        'pod-security.kubernetes.io/warn': 'restricted',
        'pod-security.kubernetes.io/audit': 'restricted',
      });
    });

    // ADR-036 backfill behavior: when a namespace already exists, we
    // patch labels (strategic-merge) rather than skipping — that's
    // what makes the platform converge PSS coverage onto pre-ADR-036
    // tenants on the next provisioning touch.
    it('should patch PSS labels onto an existing namespace (backfill path)', async () => {
      (mockK8s.core.readNamespace as ReturnType<typeof vi.fn>).mockResolvedValue({});
      const { applyNamespace } = await import('./service.js');
      await applyNamespace(mockK8s, 'existing-ns', 'tenant-123');
      expect(mockK8s.core.createNamespace).not.toHaveBeenCalled();
      expect(mockK8s.core.patchNamespace).toHaveBeenCalledTimes(1);
      const patchCall = (mockK8s.core.patchNamespace as ReturnType<typeof vi.fn>).mock.calls[0];
      const patchBody = patchCall[0] as {
        name: string;
        body: { metadata: { labels: Record<string, string> } };
      };
      expect(patchBody.name).toBe('existing-ns');
      expect(patchBody.body.metadata.labels).toMatchObject({
        platform: 'k8s-hosting',
        tenant: 'tenant-123',
        'pod-security.kubernetes.io/enforce': 'baseline',
        'pod-security.kubernetes.io/warn': 'restricted',
        'pod-security.kubernetes.io/audit': 'restricted',
      });
      // Patch must be strategic-merge so label maps union, not replace.
      const override = patchCall[1] as { _expectedContentType?: string };
      expect(override?._expectedContentType).toBe('application/strategic-merge-patch+json');
    });

    // 2026-05-17 firewall-toggle PSA fix: enforce level tracks the
    // `allow_host_ports_*` toggles. When the operator enables host
    // ports cluster-wide, every tenant namespace's enforce label
    // must be `privileged` so PSA admits hostPort pods (baseline
    // forbids them outright — that's why pre-fix the platform-api
    // gate let the deploy through but kubelet still rejected the
    // Pod).
    it('should set enforce=privileged when allowHostPorts is true (host-ports toggle on)', async () => {
      const { applyNamespace } = await import('./service.js');
      await applyNamespace(mockK8s, 'tenant-test-ns', 'tenant-123', { allowHostPorts: true });
      const callBody = (mockK8s.core.createNamespace as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        body: { metadata: { labels: Record<string, string> } };
      };
      expect(callBody.body.metadata.labels).toMatchObject({
        'pod-security.kubernetes.io/enforce': 'privileged',
        // warn + audit stay at restricted — kubectl + audit log keep
        // flagging restricted violations even when enforce is loosened.
        'pod-security.kubernetes.io/warn': 'restricted',
        'pod-security.kubernetes.io/audit': 'restricted',
      });
    });

    it('should default to enforce=baseline when allowHostPorts is unset (back-compat)', async () => {
      const { applyNamespace } = await import('./service.js');
      // No options arg — same as every pre-2026-05-17 caller.
      await applyNamespace(mockK8s, 'tenant-test-ns', 'tenant-123');
      const callBody = (mockK8s.core.createNamespace as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        body: { metadata: { labels: Record<string, string> } };
      };
      expect(callBody.body.metadata.labels['pod-security.kubernetes.io/enforce']).toBe('baseline');
    });

    it('should patch enforce=privileged onto an existing namespace when allowHostPorts is on (backfill path)', async () => {
      (mockK8s.core.readNamespace as ReturnType<typeof vi.fn>).mockResolvedValue({});
      const { applyNamespace } = await import('./service.js');
      await applyNamespace(mockK8s, 'existing-ns', 'tenant-123', { allowHostPorts: true });
      const patchCall = (mockK8s.core.patchNamespace as ReturnType<typeof vi.fn>).mock.calls[0];
      const patchBody = patchCall[0] as { body: { metadata: { labels: Record<string, string> } } };
      expect(patchBody.body.metadata.labels['pod-security.kubernetes.io/enforce']).toBe('privileged');
    });

    it('should patch enforce=baseline onto an existing namespace when allowHostPorts flips off (restore-security path)', async () => {
      // The OFF direction is the operationally important one: the
      // operator just turned host ports OFF and the cluster MUST
      // catch up by tightening enforce back to baseline. A bug here
      // would silently leave tenant namespaces at privileged after
      // the operator believes they've restored the safe default.
      (mockK8s.core.readNamespace as ReturnType<typeof vi.fn>).mockResolvedValue({});
      const { applyNamespace } = await import('./service.js');
      await applyNamespace(mockK8s, 'existing-ns', 'tenant-123', { allowHostPorts: false });
      const patchCall = (mockK8s.core.patchNamespace as ReturnType<typeof vi.fn>).mock.calls[0];
      const patchBody = patchCall[0] as { body: { metadata: { labels: Record<string, string> } } };
      expect(patchBody.body.metadata.labels['pod-security.kubernetes.io/enforce']).toBe('baseline');
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
      // Asymmetric QoS (ADR-037): CPU enforced on `requests.cpu`
      // (pods burst freely), memory enforced on both axes (Guaranteed).
      const podSpec = (podCall![0] as { body: { spec: { hard: Record<string, string>; scopeSelector: object } } }).body.spec;
      expect(podSpec).toMatchObject({
        hard: {
          'requests.cpu': '2',
          'requests.memory': '4Gi',
          'limits.memory': '4Gi',
        },
        scopeSelector: {
          matchExpressions: [
            { scopeName: 'PriorityClass', operator: 'In', values: ['tenant-default'] },
          ],
        },
      });
      // Critically: no `limits.cpu` key — that's what allows CPU bursting.
      expect(podSpec.hard).not.toHaveProperty('limits.cpu');
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
      await applyPVC(mockK8s, 'tenant-fresh', '10', 'longhorn');
      const [call] = mockK8s.core.createNamespacedPersistentVolumeClaim.mock.calls;
      const labels = call[0].body.metadata.labels;
      expect(labels['recurring-job-group.longhorn.io/default']).toBe('enabled');
      expect(labels['app.kubernetes.io/part-of']).toBe('hosting-platform');
      expect(labels['app.kubernetes.io/component']).toBe('tenant-storage');
    });

    it('should stamp canonical platform/* labels for the PVC→PV mirror reconciler', async () => {
      // The PV name is auto-generated by CSI external-provisioner and
      // looks like `pvc-<uuid>`. Without these labels operators looking
      // at `kubectl get pv` or the Longhorn UI cannot tell which volume
      // belongs to which tenant. The storage-policy reconciler mirrors
      // these from PVC → bound PV at steady state.
      const { applyPVC } = await import('./service.js');
      await applyPVC(mockK8s, 'tenant-acme-abc12345', '10', 'longhorn');
      const [call] = mockK8s.core.createNamespacedPersistentVolumeClaim.mock.calls;
      const labels = call[0].body.metadata.labels;
      expect(labels['platform/role']).toBe('tenant-storage');
      expect(labels['platform/owner']).toBe('tenant-abc12345');
      expect(labels['platform/canonical-name']).toBe('tenant-acme-abc12345-storage');
      expect(labels['platform/managed-by']).toBe('platform-api');
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
        message: 'resourcequotas is forbidden: User "system:serviceaccount:platform:platform-api" cannot create resource "resourcequotas" in the namespace "tenant-x"',
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
