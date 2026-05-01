import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock DB ──────────────────────────────────────────────────────────────────

const mockInsert = vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue([]) });
const mockDb = {
  insert: mockInsert,
} as unknown as import('../../db/index.js').Database;

// ── Mock storage/service internals ───────────────────────────────────────────

const mockGetInUseImages = vi.fn<[], Promise<Set<string>>>();
const mockRunPurgeOnNode = vi.fn();

vi.mock('./service.js', () => ({
  getInUseImages: mockGetInUseImages,
  runPurgeOnNode: mockRunPurgeOnNode,
  // Real implementation re-exported for the in-use guard normalisation path
  isAnyNameInUse: (names: readonly string[], set: ReadonlySet<string>): boolean => {
    for (const n of names) {
      if (set.has(n)) return true;
      const stripped = n.replace(/^docker\.io\/library\//, '');
      if (set.has(stripped)) return true;
      if (!n.includes('/') && set.has(`docker.io/library/${n}`)) return true;
    }
    return false;
  },
}));

vi.mock('../../db/schema.js', () => ({
  imageReapLog: {},
}));

const { reapImageNow, scheduleReap } = await import('./image-reaper.js');

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeK8s(nodes: { name: string; images: { names: string[]; sizeBytes: number }[] }[]) {
  return {
    core: {
      listNode: vi.fn().mockResolvedValue({
        items: nodes.map(n => ({
          metadata: { name: n.name },
          status: { images: n.images.map(img => ({ names: img.names, sizeBytes: img.sizeBytes })) },
        })),
      }),
    },
  } as unknown as import('../k8s-provisioner/k8s-client.js').K8sClients;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('image-reaper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset insert mock chain
    const valuesMock = vi.fn().mockResolvedValue([]);
    mockInsert.mockReturnValue({ values: valuesMock });
  });

  describe('reapImageNow', () => {
    it('skips and logs when image is still in use', async () => {
      mockGetInUseImages.mockResolvedValue(new Set(['ghcr.io/foo/bar:v1.0']));
      const k8s = makeK8s([]);

      const result = await reapImageNow(mockDb, k8s, {
        image: 'ghcr.io/foo/bar:v1.0',
        triggeredBy: 'deployment_delete',
      });

      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('in_use');
      expect(mockRunPurgeOnNode).not.toHaveBeenCalled();
      expect(mockInsert).toHaveBeenCalledOnce();
    });

    it('returns not_present when image is absent from all nodes', async () => {
      mockGetInUseImages.mockResolvedValue(new Set());
      const k8s = makeK8s([{ name: 'node-1', images: [{ names: ['other:latest'], sizeBytes: 0 }] }]);

      const result = await reapImageNow(mockDb, k8s, {
        image: 'ghcr.io/foo/bar:v1.0',
        triggeredBy: 'deployment_delete',
      });

      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('not_present');
      expect(mockRunPurgeOnNode).not.toHaveBeenCalled();
    });

    it('calls runPurgeOnNode for each node that has the image', async () => {
      mockGetInUseImages.mockResolvedValue(new Set());
      const k8s = makeK8s([
        { name: 'node-1', images: [{ names: ['ghcr.io/foo/bar:v1.0'], sizeBytes: 100_000_000 }] },
        { name: 'node-2', images: [{ names: ['ghcr.io/foo/bar:v1.0'], sizeBytes: 100_000_000 }] },
      ]);
      mockRunPurgeOnNode.mockResolvedValue({
        node: 'node-1',
        removedDisplayNames: ['ghcr.io/foo/bar:v1.0'],
        failedDisplayNames: [],
        freedBytes: 100_000_000,
      });

      const result = await reapImageNow(mockDb, k8s, {
        image: 'ghcr.io/foo/bar:v1.0',
        triggeredBy: 'deployment_delete',
        triggerRef: 'deploy-abc',
      });

      expect(mockRunPurgeOnNode).toHaveBeenCalledTimes(2);
      expect(result.skipped).toBe(false);
      // Both nodes returned success in mock
      expect(result.nodes).toHaveLength(2);
      expect(result.reclaimedBytes).toBe(200_000_000);
    });

    it('logs success row into image_reap_log', async () => {
      mockGetInUseImages.mockResolvedValue(new Set());
      const k8s = makeK8s([
        { name: 'node-1', images: [{ names: ['myapp:v2.0'], sizeBytes: 50_000_000 }] },
      ]);
      mockRunPurgeOnNode.mockResolvedValue({
        node: 'node-1',
        removedDisplayNames: ['myapp:v2.0'],
        failedDisplayNames: [],
        freedBytes: 50_000_000,
      });

      await reapImageNow(mockDb, k8s, {
        image: 'myapp:v2.0',
        triggeredBy: 'deployment_delete',
        triggerRef: 'deploy-xyz',
      });

      expect(mockInsert).toHaveBeenCalledOnce();
      const valuesArg = mockInsert.mock.results[0].value.values.mock.calls[0][0];
      expect(valuesArg.imageName).toBe('myapp:v2.0');
      expect(valuesArg.triggeredBy).toBe('deployment_delete');
      expect(valuesArg.triggerRef).toBe('deploy-xyz');
      expect(valuesArg.succeeded).toBe(true);
      expect(valuesArg.bytesReclaimed).toBe(50_000_000);
    });

    it('handles k8s listNode failure gracefully', async () => {
      mockGetInUseImages.mockResolvedValue(new Set());
      const k8s = {
        core: { listNode: vi.fn().mockRejectedValue(new Error('k8s down')) },
      } as unknown as import('../k8s-provisioner/k8s-client.js').K8sClients;

      const result = await reapImageNow(mockDb, k8s, {
        image: 'myapp:v2.0',
        triggeredBy: 'manual_purge',
      });

      expect(result.skipped).toBe(false);
      expect(result.reason).toBe('k8s_error');
      expect(mockRunPurgeOnNode).not.toHaveBeenCalled();
    });
  });

  describe('scheduleReap', () => {
    it('schedules reap with timeout and does not throw', () => {
      vi.useFakeTimers();
      mockGetInUseImages.mockResolvedValue(new Set(['myapp:v1.0']));
      const k8s = makeK8s([]);

      // Should not throw
      expect(() => {
        scheduleReap(mockDb, k8s, {
          image: 'myapp:v1.0',
          triggeredBy: 'deployment_delete',
          graceMs: 1000,
        });
      }).not.toThrow();

      vi.useRealTimers();
    });
  });
});
