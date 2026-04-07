import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before imports
const mockDb = {
  execute: vi.fn(),
  select: vi.fn(() => ({ from: vi.fn(() => Promise.resolve([])) })),
};

const mockRedis = {
  info: vi.fn(),
};

vi.mock('../../shared/redis.js', () => ({
  getRedis: () => mockRedis,
}));

// Mock file-manager service (dynamic import inside service)
vi.mock('../file-manager/service.js', () => ({
  proxyToFileManager: vi.fn().mockRejectedValue(new Error('not running')),
}));

const {
  classifyImage,
  parseNodeImages,
  filterPurgeableImages,
  formatImageName,
  getStorageOverview,
  getImageInventory,
  purgeUnusedImages,
} = await import('./service.js');

describe('storage service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── classifyImage ──────────────────────────────────────────────────────────

  describe('classifyImage', () => {
    it('should classify platform images as protected', () => {
      expect(classifyImage('hosting-platform-backend:latest').protected).toBe(true);
      expect(classifyImage('hosting-platform-admin-panel:latest').protected).toBe(true);
      expect(classifyImage('hosting-platform-client-panel:latest').protected).toBe(true);
      expect(classifyImage('file-manager-sidecar:latest').protected).toBe(true);
      expect(classifyImage('docker.io/library/file-manager-sidecar:latest').protected).toBe(true);
    });

    it('should classify k8s/k3s system images as protected', () => {
      expect(classifyImage('rancher/k3s:v1.31.4').protected).toBe(true);
      expect(classifyImage('registry.k8s.io/kustomize/kustomize:v5.4.3').protected).toBe(true);
      expect(classifyImage('ghcr.io/dexidp/dex:v2.39.1').protected).toBe(true);
      expect(classifyImage('rancher/mirrored-pause:3.6').protected).toBe(true);
    });

    it('should classify app images as not protected', () => {
      expect(classifyImage('mariadb:11').protected).toBe(false);
      expect(classifyImage('mysql:8').protected).toBe(false);
      expect(classifyImage('postgres:17').protected).toBe(false);
      expect(classifyImage('wordpress:latest').protected).toBe(false);
      expect(classifyImage('docker.io/library/mariadb:10').protected).toBe(false);
    });
  });

  // ─── parseNodeImages ────────────────────────────────────────────────────────

  describe('parseNodeImages', () => {
    it('should parse K8s node.status.images into normalized entries', () => {
      const nodeImages = [
        {
          names: ['docker.io/library/mariadb:11', 'docker.io/library/mariadb@sha256:abc'],
          sizeBytes: 330_000_000,
        },
        {
          names: ['docker.io/library/file-manager-sidecar:latest'],
          sizeBytes: 175_000_000,
        },
      ];

      const result = parseNodeImages(nodeImages);

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('docker.io/library/mariadb:11');
      expect(result[0].sizeBytes).toBe(330_000_000);
      expect(result[1].name).toBe('docker.io/library/file-manager-sidecar:latest');
    });

    it('should skip entries with no names', () => {
      const nodeImages = [
        { names: null, sizeBytes: 100 },
        { names: [], sizeBytes: 200 },
        { names: ['valid:tag'], sizeBytes: 300 },
      ];

      const result = parseNodeImages(nodeImages);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('valid:tag');
    });

    it('should prefer tag names over digest-only names', () => {
      const nodeImages = [
        {
          names: [
            'docker.io/library/mariadb@sha256:abc123',
            'docker.io/library/mariadb:11',
          ],
          sizeBytes: 1000,
        },
      ];

      const result = parseNodeImages(nodeImages);

      expect(result[0].name).toBe('docker.io/library/mariadb:11');
    });

    it('should use digest-only name if no tag is present', () => {
      const nodeImages = [
        { names: ['docker.io/library/mariadb@sha256:abc'], sizeBytes: 1000 },
      ];

      const result = parseNodeImages(nodeImages);

      expect(result[0].name).toBe('docker.io/library/mariadb@sha256:abc');
    });
  });

  // ─── filterPurgeableImages ──────────────────────────────────────────────────

  describe('filterPurgeableImages', () => {
    it('should return only non-protected, non-in-use images', () => {
      const images = [
        { name: 'mariadb:11', sizeBytes: 100, inUse: true, protected: false },
        { name: 'mariadb:10', sizeBytes: 100, inUse: false, protected: false },
        { name: 'hosting-platform-backend:latest', sizeBytes: 200, inUse: false, protected: true },
        { name: 'wordpress:latest', sizeBytes: 500, inUse: false, protected: false },
      ];

      const result = filterPurgeableImages(images);

      expect(result).toHaveLength(2);
      expect(result.map(i => i.name).sort()).toEqual(['mariadb:10', 'wordpress:latest']);
    });

    it('should return empty array when all images are protected or in use', () => {
      const images = [
        { name: 'mariadb:11', sizeBytes: 100, inUse: true, protected: false },
        { name: 'hosting-platform-backend:latest', sizeBytes: 200, inUse: false, protected: true },
      ];

      expect(filterPurgeableImages(images)).toHaveLength(0);
    });
  });

  // ─── formatImageName ────────────────────────────────────────────────────────

  describe('formatImageName', () => {
    it('should strip docker.io/library/ prefix from official images', () => {
      expect(formatImageName('docker.io/library/mariadb:11')).toBe('mariadb:11');
      expect(formatImageName('docker.io/library/postgres:17')).toBe('postgres:17');
    });

    it('should keep non-docker-hub image names as-is', () => {
      expect(formatImageName('ghcr.io/dexidp/dex:v2.39.1')).toBe('ghcr.io/dexidp/dex:v2.39.1');
      expect(formatImageName('registry.k8s.io/kustomize/kustomize:v5.4.3')).toBe('registry.k8s.io/kustomize/kustomize:v5.4.3');
    });

    it('should handle already-normalized names', () => {
      expect(formatImageName('mariadb:11')).toBe('mariadb:11');
      expect(formatImageName('file-manager-sidecar:latest')).toBe('file-manager-sidecar:latest');
    });
  });

  // ─── getStorageOverview ─────────────────────────────────────────────────────

  describe('getStorageOverview', () => {
    function createMockK8s(overrides: Record<string, unknown> = {}) {
      return {
        core: {
          listNode: vi.fn().mockResolvedValue({
            items: [{
              metadata: { name: 'test-node' },
              status: {
                capacity: { 'ephemeral-storage': '100Gi' },
                images: [
                  { names: ['docker.io/library/mariadb:11'], sizeBytes: 330_000_000 },
                  { names: ['file-manager-sidecar:latest'], sizeBytes: 175_000_000 },
                ],
              },
            }],
          }),
          listPodForAllNamespaces: vi.fn().mockResolvedValue({ items: [] }),
          ...(overrides.core as Record<string, unknown> ?? {}),
        },
      };
    }

    it('should aggregate storage data from all sources', async () => {
      mockDb.execute.mockResolvedValue({ rows: [{ size: 10_000_000 }] });
      mockRedis.info.mockResolvedValue('used_memory:5000000\r\n');
      const k8s = createMockK8s();

      const result = await getStorageOverview(
        mockDb as unknown as Parameters<typeof getStorageOverview>[0],
        k8s as unknown as Parameters<typeof getStorageOverview>[1],
        undefined,
      );

      expect(result.node.name).toBe('test-node');
      expect(result.node.totalBytes).toBeGreaterThan(0);
      expect(result.system.platformDatabase.usedBytes).toBe(10_000_000);
      expect(result.system.redis.usedBytes).toBe(5_000_000);
      expect(result.system.dockerImages.count).toBe(2);
      expect(result.system.dockerImages.totalBytes).toBe(505_000_000);
      expect(result.total.systemBytes).toBeGreaterThan(0);
      expect(Array.isArray(result.clients)).toBe(true);
    });

    it('should handle K8s API errors gracefully', async () => {
      mockDb.execute.mockRejectedValue(new Error('db error'));
      mockRedis.info.mockRejectedValue(new Error('redis error'));
      const k8s = {
        core: {
          listNode: vi.fn().mockRejectedValue(new Error('k8s down')),
          listPodForAllNamespaces: vi.fn().mockRejectedValue(new Error('k8s down')),
        },
      };

      const result = await getStorageOverview(
        mockDb as unknown as Parameters<typeof getStorageOverview>[0],
        k8s as unknown as Parameters<typeof getStorageOverview>[1],
        undefined,
      );

      expect(result.node.name).toBe('unknown');
      expect(result.system.platformDatabase.usedBytes).toBe(0);
      expect(result.system.redis.usedBytes).toBe(0);
      expect(result.system.dockerImages.count).toBe(0);
    });
  });

  // ─── getImageInventory ───────────────────────────────────────────────────────

  describe('getImageInventory', () => {
    it('should classify images and identify in-use ones', async () => {
      const k8s = {
        core: {
          listNode: vi.fn().mockResolvedValue({
            items: [{
              status: {
                images: [
                  { names: ['docker.io/library/mariadb:11'], sizeBytes: 100_000_000 },
                  { names: ['docker.io/library/mysql:9'], sizeBytes: 250_000_000 },
                  { names: ['file-manager-sidecar:latest'], sizeBytes: 175_000_000 },
                ],
              },
            }],
          }),
          listPodForAllNamespaces: vi.fn().mockResolvedValue({
            items: [{
              spec: { containers: [{ image: 'mariadb:11' }] },
            }],
          }),
        },
      };

      const result = await getImageInventory(k8s as unknown as Parameters<typeof getImageInventory>[0]);

      expect(result.images).toHaveLength(3);
      const mariadb = result.images.find(i => i.name === 'mariadb:11');
      expect(mariadb?.inUse).toBe(true);
      expect(mariadb?.protected).toBe(false);
      const mysql = result.images.find(i => i.name === 'mysql:9');
      expect(mysql?.inUse).toBe(false);
      expect(mysql?.protected).toBe(false);
      const fm = result.images.find(i => i.name === 'file-manager-sidecar:latest');
      expect(fm?.protected).toBe(true);
      expect(result.purgeableCount).toBe(1); // only mysql:9
      expect(result.purgeableBytes).toBe(250_000_000);
    });

    it('should handle missing node images gracefully', async () => {
      const k8s = {
        core: {
          listNode: vi.fn().mockResolvedValue({ items: [] }),
          listPodForAllNamespaces: vi.fn().mockResolvedValue({ items: [] }),
        },
      };
      const result = await getImageInventory(k8s as unknown as Parameters<typeof getImageInventory>[0]);
      expect(result.images).toHaveLength(0);
      expect(result.totalBytes).toBe(0);
      expect(result.purgeableCount).toBe(0);
    });
  });

  // ─── purgeUnusedImages ───────────────────────────────────────────────────────

  describe('purgeUnusedImages', () => {
    it('should return dry-run preview of purgeable images', async () => {
      const k8s = {
        core: {
          listNode: vi.fn().mockResolvedValue({
            items: [{
              status: {
                images: [
                  { names: ['docker.io/library/mysql:9'], sizeBytes: 250_000_000 },
                ],
              },
            }],
          }),
          listPodForAllNamespaces: vi.fn().mockResolvedValue({ items: [] }),
        },
      };

      const result = await purgeUnusedImages(k8s as unknown as Parameters<typeof purgeUnusedImages>[0], true);

      expect(result.dryRun).toBe(true);
      expect(result.removedImages).toEqual(['mysql:9']);
      expect(result.freedBytes).toBe(250_000_000);
      expect(result.errors).toEqual([]);
    });

    it('should return empty result in dry-run when no purgeable images', async () => {
      const k8s = {
        core: {
          listNode: vi.fn().mockResolvedValue({
            items: [{
              status: {
                images: [
                  { names: ['file-manager-sidecar:latest'], sizeBytes: 175_000_000 },
                ],
              },
            }],
          }),
          listPodForAllNamespaces: vi.fn().mockResolvedValue({ items: [] }),
        },
      };

      const result = await purgeUnusedImages(k8s as unknown as Parameters<typeof purgeUnusedImages>[0], true);

      expect(result.dryRun).toBe(true);
      expect(result.removedImages).toEqual([]);
      expect(result.freedBytes).toBe(0);
    });

    it('should not attempt purge when no purgeable images in non-dry-run mode', async () => {
      const createNamespacedPod = vi.fn();
      const k8s = {
        core: {
          listNode: vi.fn().mockResolvedValue({
            items: [{
              status: {
                images: [
                  { names: ['file-manager-sidecar:latest'], sizeBytes: 175_000_000 },
                ],
              },
            }],
          }),
          listPodForAllNamespaces: vi.fn().mockResolvedValue({ items: [] }),
          createNamespacedPod,
        },
      };

      const result = await purgeUnusedImages(k8s as unknown as Parameters<typeof purgeUnusedImages>[0], false);

      expect(result.dryRun).toBe(false);
      expect(result.removedImages).toEqual([]);
      expect(createNamespacedPod).not.toHaveBeenCalled();
    });
  });
});
