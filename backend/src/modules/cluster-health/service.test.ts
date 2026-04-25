import { describe, it, expect, vi } from 'vitest';
import { collectClusterHealth, collectNodeSubsystemHealth } from './service.js';

// Helper to build a K8sClients-shaped mock with just the methods these
// tests exercise. Cast to `any` at call sites — the real client surface
// is huge and not relevant to what's under test here.
function makeK8s(overrides: Record<string, unknown> = {}) {
  return {
    apps: {
      readNamespacedDeployment: vi.fn(),
      readNamespacedDaemonSet: vi.fn(),
      ...(overrides.apps as object | undefined ?? {}),
    },
    core: {
      listNode: vi.fn().mockResolvedValue({ items: [] }),
      listNamespacedPod: vi.fn().mockResolvedValue({ items: [] }),
      ...(overrides.core as object | undefined ?? {}),
    },
    storage: {
      listCSINode: vi.fn().mockResolvedValue({ items: [] }),
      ...(overrides.storage as object | undefined ?? {}),
    },
    custom: {
      // legacy field — should NOT be touched by the new implementation
      listClusterCustomObject: vi.fn().mockRejectedValue(new Error('should not be called')),
    },
  };
}

describe('cluster-health service', () => {
  // -------- collectClusterHealth --------

  it('marks deployment healthy when ready === desired', async () => {
    const k8s = makeK8s({
      apps: {
        readNamespacedDeployment: vi.fn().mockResolvedValue({
          spec: { replicas: 2 },
          status: { readyReplicas: 2 },
        }),
        readNamespacedDaemonSet: vi.fn().mockResolvedValue({
          status: { desiredNumberScheduled: 1, numberReady: 1 },
        }),
      },
    });

    const out = await collectClusterHealth(k8s as unknown as Parameters<typeof collectClusterHealth>[0]);
    const cm = out.find((c) => c.name === 'cert-manager');
    expect(cm?.healthy).toBe(true);
    expect(cm?.ready).toBe(2);
    expect(cm?.desired).toBe(2);
  });

  it('marks optional component as "not installed" on 404', async () => {
    const k8s = makeK8s({
      apps: {
        readNamespacedDeployment: vi.fn().mockImplementation(({ name }: { name: string }) => {
          if (name === 'cnpg-controller-manager') {
            const err = new Error('not found') as Error & { code: number };
            err.code = 404;
            return Promise.reject(err);
          }
          return Promise.resolve({ spec: { replicas: 1 }, status: { readyReplicas: 1 } });
        }),
        readNamespacedDaemonSet: vi.fn().mockResolvedValue({
          status: { desiredNumberScheduled: 1, numberReady: 1 },
        }),
      },
    });

    const out = await collectClusterHealth(k8s as unknown as Parameters<typeof collectClusterHealth>[0]);
    const cnpg = out.find((c) => c.name === 'cnpg-controller-manager');
    expect(cnpg?.healthy).toBe(false);
    expect(cnpg?.message).toBe('not installed');
  });

  // -------- collectNodeSubsystemHealth --------

  it('reports csiDriverRegistered: true when storage.listCSINode returns the longhorn driver', async () => {
    const k8s = makeK8s({
      core: {
        listNode: vi.fn().mockResolvedValue({
          items: [{ metadata: { name: 'staging' } }],
        }),
        listNamespacedPod: vi.fn().mockImplementation(({ namespace }: { namespace: string }) => {
          if (namespace === 'calico-system') {
            return Promise.resolve({
              items: [{
                metadata: { name: 'calico-node-abc', labels: { 'k8s-app': 'calico-node' } },
                spec: { nodeName: 'staging' },
                status: { phase: 'Running', containerStatuses: [{ ready: true, name: 'calico-node' }] },
              }],
            });
          }
          if (namespace === 'longhorn-system') {
            return Promise.resolve({
              items: [{
                metadata: { name: 'longhorn-csi-plugin-xyz', labels: { app: 'longhorn-csi-plugin' } },
                spec: { nodeName: 'staging' },
                status: { phase: 'Running', containerStatuses: [
                  { ready: true, name: 'longhorn-csi-plugin' },
                  { ready: true, name: 'driver-registrar' },
                  { ready: true, name: 'longhorn-liveness-probe' },
                ] },
              }],
            });
          }
          return Promise.resolve({ items: [] });
        }),
      },
      storage: {
        listCSINode: vi.fn().mockResolvedValue({
          items: [{
            metadata: { name: 'staging' },
            spec: { drivers: [{ name: 'csi.tigera.io' }, { name: 'driver.longhorn.io' }] },
          }],
        }),
      },
    });

    const out = await collectNodeSubsystemHealth(k8s as unknown as Parameters<typeof collectClusterHealth>[0]);
    expect(out).toHaveLength(1);
    expect(out[0].nodeName).toBe('staging');
    expect(out[0].calico).toBe('healthy');
    expect(out[0].longhornCsi).toBe('healthy');
    expect(out[0].csiDriverRegistered).toBe(true);
  });

  it('reports csiDriverRegistered: false when CSINode lacks the longhorn driver', async () => {
    const k8s = makeK8s({
      core: {
        listNode: vi.fn().mockResolvedValue({
          items: [{ metadata: { name: 'admin' } }],
        }),
      },
      storage: {
        listCSINode: vi.fn().mockResolvedValue({
          items: [{
            metadata: { name: 'admin' },
            // Only Calico CSI registered — Longhorn never finished registration.
            spec: { drivers: [{ name: 'csi.tigera.io' }] },
          }],
        }),
      },
    });

    const out = await collectNodeSubsystemHealth(k8s as unknown as Parameters<typeof collectClusterHealth>[0]);
    expect(out[0].csiDriverRegistered).toBe(false);
  });

  it('flags Calico subsystem as degraded when calico-node container not ready', async () => {
    const k8s = makeK8s({
      core: {
        listNode: vi.fn().mockResolvedValue({
          items: [{ metadata: { name: 'admin' } }],
        }),
        listNamespacedPod: vi.fn().mockImplementation(({ namespace }: { namespace: string }) => {
          if (namespace === 'calico-system') {
            return Promise.resolve({
              items: [{
                metadata: { name: 'calico-node-bad', labels: { 'k8s-app': 'calico-node' } },
                spec: { nodeName: 'admin' },
                status: { phase: 'Running', containerStatuses: [{ ready: false, name: 'calico-node' }] },
              }],
            });
          }
          return Promise.resolve({ items: [] });
        }),
      },
    });

    const out = await collectNodeSubsystemHealth(k8s as unknown as Parameters<typeof collectClusterHealth>[0]);
    expect(out[0].calico).toBe('degraded');
    expect(out[0].calicoMessage).toContain('calico-node');
    expect(out[0].longhornCsi).toBe('missing');
  });

  it('falls back gracefully when listCSINode rejects (RBAC missing, API down)', async () => {
    const k8s = makeK8s({
      core: {
        listNode: vi.fn().mockResolvedValue({
          items: [{ metadata: { name: 'staging' } }],
        }),
      },
      storage: {
        listCSINode: vi.fn().mockRejectedValue(new Error('forbidden')),
      },
    });

    const out = await collectNodeSubsystemHealth(k8s as unknown as Parameters<typeof collectClusterHealth>[0]);
    expect(out[0].csiDriverRegistered).toBe(false);
  });

  it('does NOT call the legacy customObjects path', async () => {
    const customSpy = vi.fn().mockResolvedValue({ items: [] });
    const k8s = {
      ...makeK8s({
        core: {
          listNode: vi.fn().mockResolvedValue({
            items: [{ metadata: { name: 'staging' } }],
          }),
        },
      }),
      custom: { listClusterCustomObject: customSpy },
    };

    await collectNodeSubsystemHealth(k8s as unknown as Parameters<typeof collectClusterHealth>[0]);
    expect(customSpy).not.toHaveBeenCalled();
  });
});
