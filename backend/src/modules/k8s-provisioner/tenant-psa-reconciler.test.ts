import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock the CoreV1Api loader ────────────────────────────────────────────────

const mockPatchNamespace = vi.fn();

vi.mock('@kubernetes/client-node', () => {
  // `new KubeConfig()` requires a class — vi.fn() returns a function
  // that isn't `new`-able. Use a real class so the loader works.
  class MockKubeConfig {
    loadFromCluster() { /* no-op */ }
    makeApiClient() { return { patchNamespace: mockPatchNamespace }; }
  }
  class MockCoreV1Api {}
  return {
    KubeConfig: MockKubeConfig,
    CoreV1Api: MockCoreV1Api,
  };
});

vi.mock('../../db/schema.js', () => ({
  tenants: {
    id: { name: 'id' },
    kubernetesNamespace: { name: 'kubernetes_namespace' },
  },
}));

// Build a minimal Database mock that returns the supplied tenant rows
// from a select().from(tenants).where(...) chain.
function mockDbWithTenants(rows: Array<{ id: string; kubernetesNamespace: string | null }>) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve(rows)),
      })),
    })),
  } as unknown as import('../../db/index.js').Database;
}

const { reconcileTenantNamespacePsa } = await import('./tenant-psa-reconciler.js');

describe('reconcileTenantNamespacePsa', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('patches every tenant namespace to enforce=privileged when allowHostPorts=true', async () => {
    const db = mockDbWithTenants([
      { id: 't1', kubernetesNamespace: 'tenant-a' },
      { id: 't2', kubernetesNamespace: 'tenant-b' },
    ]);
    mockPatchNamespace.mockResolvedValue({});

    const result = await reconcileTenantNamespacePsa(db, true);

    expect(result).toEqual({ attempted: 2, succeeded: 2, failed: [] });
    expect(mockPatchNamespace).toHaveBeenCalledTimes(2);
    for (const call of mockPatchNamespace.mock.calls) {
      const body = call[0] as { body: { metadata: { labels: Record<string, string> } } };
      expect(body.body.metadata.labels['pod-security.kubernetes.io/enforce']).toBe('privileged');
      // warn + audit stay at restricted regardless of enforce level
      expect(body.body.metadata.labels['pod-security.kubernetes.io/warn']).toBe('restricted');
      expect(body.body.metadata.labels['pod-security.kubernetes.io/audit']).toBe('restricted');
    }
  });

  it('patches every tenant namespace back to enforce=baseline when allowHostPorts=false', async () => {
    const db = mockDbWithTenants([
      { id: 't1', kubernetesNamespace: 'tenant-a' },
      { id: 't2', kubernetesNamespace: 'tenant-b' },
    ]);
    mockPatchNamespace.mockResolvedValue({});

    const result = await reconcileTenantNamespacePsa(db, false);

    expect(result).toEqual({ attempted: 2, succeeded: 2, failed: [] });
    for (const call of mockPatchNamespace.mock.calls) {
      const body = call[0] as { body: { metadata: { labels: Record<string, string> } } };
      expect(body.body.metadata.labels['pod-security.kubernetes.io/enforce']).toBe('baseline');
    }
  });

  it('reports per-namespace failures in the result without aborting the loop', async () => {
    const db = mockDbWithTenants([
      { id: 't1', kubernetesNamespace: 'tenant-a' },
      { id: 't2', kubernetesNamespace: 'tenant-b-fails' },
      { id: 't3', kubernetesNamespace: 'tenant-c' },
    ]);
    mockPatchNamespace.mockImplementation((arg: { name: string }) => {
      if (arg.name === 'tenant-b-fails') {
        return Promise.reject(new Error('forbidden by RBAC'));
      }
      return Promise.resolve({});
    });

    const result = await reconcileTenantNamespacePsa(db, true);

    expect(result.attempted).toBe(3);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toContain('tenant-b-fails');
    expect(result.failed[0]).toContain('forbidden by RBAC');
    // All three patches were attempted — the loop didn't abort early.
    expect(mockPatchNamespace).toHaveBeenCalledTimes(3);
  });

  it('skips tenants with no kubernetesNamespace (not yet provisioned)', async () => {
    // Provisioning races: a tenant row exists but its namespace
    // hasn't been created yet. The DB query in production filters
    // these out with `IS NOT NULL AND != ''`, but the unit test
    // verifies the loop's defensive in-iteration guard anyway.
    const db = mockDbWithTenants([
      { id: 't1', kubernetesNamespace: 'tenant-a' },
      { id: 't2', kubernetesNamespace: null },
      { id: 't3', kubernetesNamespace: '' },
    ]);
    mockPatchNamespace.mockResolvedValue({});

    await reconcileTenantNamespacePsa(db, true);

    // Only tenant-a gets patched; t2 + t3 are skipped silently.
    expect(mockPatchNamespace).toHaveBeenCalledTimes(1);
    const firstCall = mockPatchNamespace.mock.calls[0][0] as { name: string };
    expect(firstCall.name).toBe('tenant-a');
  });

  it('returns a no-op result when no tenants have namespaces (fresh cluster)', async () => {
    const db = mockDbWithTenants([]);

    const result = await reconcileTenantNamespacePsa(db, true);

    expect(result).toEqual({ attempted: 0, succeeded: 0, failed: [] });
    expect(mockPatchNamespace).not.toHaveBeenCalled();
  });
});
