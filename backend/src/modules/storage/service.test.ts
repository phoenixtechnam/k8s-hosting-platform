import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before imports
const mockDb = {
  execute: vi.fn(),
};

const mockRedis = {
  info: vi.fn(),
};

vi.mock('../../shared/redis.js', () => ({
  getRedis: () => mockRedis,
}));

const {
  classifyImage,
  parseNodeImages,
  filterPurgeableImages,
  formatImageName,
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
});
