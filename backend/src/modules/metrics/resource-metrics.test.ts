import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock Redis before importing the module under test
const mockRedis = {
  get: vi.fn(),
  setex: vi.fn(),
  mget: vi.fn(),
};

vi.mock('../../shared/redis.js', () => ({
  getRedis: () => mockRedis,
}));

// Mock file-manager service (dynamic import inside collectClientMetrics)
vi.mock('../file-manager/service.js', () => ({
  proxyToFileManager: vi.fn().mockRejectedValue(new Error('not running')),
}));

const { getCachedMetrics, getAllCachedMetrics, collectClientMetrics } = await import('./resource-metrics.js');

describe('resource-metrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── getCachedMetrics ───────────────────────────────────────────────────────

  describe('getCachedMetrics', () => {
    it('should return null when no cached data exists', async () => {
      mockRedis.get.mockResolvedValue(null);

      const result = await getCachedMetrics('client-1');

      expect(result).toBeNull();
      expect(mockRedis.get).toHaveBeenCalledWith('metrics:client-1');
    });

    it('should return parsed ResourceMetrics when cached', async () => {
      const cached = {
        clientId: 'client-1',
        cpu: { inUse: 0.5, reserved: 1, available: 2 },
        memory: { inUse: 1.5, reserved: 2, available: 4 },
        storage: { inUse: 5, reserved: 10, available: 50 },
        lastUpdatedAt: '2026-04-04T12:00:00.000Z',
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(cached));

      const result = await getCachedMetrics('client-1');

      expect(result).toEqual(cached);
      expect(result?.clientId).toBe('client-1');
      expect(result?.cpu.inUse).toBe(0.5);
      expect(result?.cpu.reserved).toBe(1);
      expect(result?.cpu.available).toBe(2);
      expect(result?.memory.inUse).toBe(1.5);
      expect(result?.storage.available).toBe(50);
      expect(result?.lastUpdatedAt).toBe('2026-04-04T12:00:00.000Z');
    });
  });

  // ─── getAllCachedMetrics ─────────────────────────────────────────────────────

  describe('getAllCachedMetrics', () => {
    it('should return empty object for empty client list', async () => {
      const result = await getAllCachedMetrics([]);

      expect(result).toEqual({});
      expect(mockRedis.mget).not.toHaveBeenCalled();
    });

    it('should return metrics for clients that have cached data', async () => {
      const metrics1 = {
        clientId: 'c1',
        cpu: { inUse: 0.1, reserved: 0.5, available: 2 },
        memory: { inUse: 0.5, reserved: 1, available: 4 },
        storage: { inUse: 2, reserved: 5, available: 50 },
        lastUpdatedAt: '2026-04-04T12:00:00.000Z',
      };
      mockRedis.mget.mockResolvedValue([JSON.stringify(metrics1), null]);

      const result = await getAllCachedMetrics(['c1', 'c2']);

      expect(Object.keys(result)).toEqual(['c1']);
      expect(result.c1).toEqual(metrics1);
      expect(result.c2).toBeUndefined();
      expect(mockRedis.mget).toHaveBeenCalledWith('metrics:c1', 'metrics:c2');
    });

    it('should handle all nulls from Redis', async () => {
      mockRedis.mget.mockResolvedValue([null, null, null]);

      const result = await getAllCachedMetrics(['c1', 'c2', 'c3']);

      expect(result).toEqual({});
    });
  });

  // ─── collectClientMetrics ───────────────────────────────────────────────────

  describe('collectClientMetrics', () => {
    const mockK8s = {
      core: {
        readNamespacedResourceQuota: vi.fn(),
      },
      apps: {},
      networking: {},
      custom: {
        listNamespacedCustomObject: vi.fn(),
      },
    };

    const planLimits = { cpuLimit: 4, memoryLimitGi: 8, storageLimitGi: 100 };

    beforeEach(() => {
      mockK8s.custom.listNamespacedCustomObject.mockReset();
      mockK8s.core.readNamespacedResourceQuota.mockReset();
      mockRedis.setex.mockResolvedValue('OK');
    });

    it('should return metrics with correct structure', async () => {
      // No pods, no quota
      mockK8s.custom.listNamespacedCustomObject.mockResolvedValue({ items: [] });
      mockK8s.core.readNamespacedResourceQuota.mockRejectedValue(new Error('not found'));

      const db = {} as Parameters<typeof collectClientMetrics>[0];
      const result = await collectClientMetrics(
        db,
        mockK8s as unknown as Parameters<typeof collectClientMetrics>[1],
        'client-1',
        'client-ns-1',
        planLimits,
      );

      expect(result.clientId).toBe('client-1');
      expect(result.cpu).toEqual({ inUse: 0, reserved: 0, available: 4 });
      expect(result.memory).toEqual({ inUse: 0, reserved: 0, available: 8 });
      expect(result.storage).toEqual({ inUse: 0, reserved: 0, available: 100 });
      expect(result.lastUpdatedAt).toBeDefined();
    });

    it('should aggregate CPU and memory from multiple pods', async () => {
      mockK8s.custom.listNamespacedCustomObject.mockResolvedValue({
        items: [
          {
            containers: [
              { usage: { cpu: '500m', memory: '256Mi' } },
              { usage: { cpu: '250m', memory: '512Mi' } },
            ],
          },
          {
            containers: [
              { usage: { cpu: '1', memory: '1Gi' } },
            ],
          },
        ],
      });
      mockK8s.core.readNamespacedResourceQuota.mockRejectedValue(new Error('not found'));

      const db = {} as Parameters<typeof collectClientMetrics>[0];
      const result = await collectClientMetrics(
        db,
        mockK8s as unknown as Parameters<typeof collectClientMetrics>[1],
        'client-2',
        'client-ns-2',
        planLimits,
      );

      // 500m + 250m + 1 = 1.75 cores
      expect(result.cpu.inUse).toBe(1.75);
      // 256Mi + 512Mi + 1Gi = 0.25 + 0.5 + 1 = 1.75 Gi
      expect(result.memory.inUse).toBe(1.75);
    });

    it('should read reserved values from ResourceQuota', async () => {
      mockK8s.custom.listNamespacedCustomObject.mockResolvedValue({ items: [] });
      mockK8s.core.readNamespacedResourceQuota.mockResolvedValue({
        status: {
          used: {
            'limits.cpu': '2',
            'limits.memory': '4Gi',
            'requests.storage': '20Gi',
          },
        },
      });

      const db = {} as Parameters<typeof collectClientMetrics>[0];
      const result = await collectClientMetrics(
        db,
        mockK8s as unknown as Parameters<typeof collectClientMetrics>[1],
        'client-3',
        'client-ns-3',
        planLimits,
      );

      expect(result.cpu.reserved).toBe(2);
      expect(result.memory.reserved).toBe(4);
      expect(result.storage.reserved).toBe(20);
    });

    it('should cache the result in Redis with 2h TTL', async () => {
      mockK8s.custom.listNamespacedCustomObject.mockResolvedValue({ items: [] });
      mockK8s.core.readNamespacedResourceQuota.mockRejectedValue(new Error('not found'));

      const db = {} as Parameters<typeof collectClientMetrics>[0];
      await collectClientMetrics(
        db,
        mockK8s as unknown as Parameters<typeof collectClientMetrics>[1],
        'client-4',
        'client-ns-4',
        planLimits,
      );

      expect(mockRedis.setex).toHaveBeenCalledTimes(1);
      const [key, ttl, value] = mockRedis.setex.mock.calls[0];
      expect(key).toBe('metrics:client-4');
      expect(ttl).toBe(7200);
      const parsed = JSON.parse(value);
      expect(parsed.clientId).toBe('client-4');
    });

    it('should handle K8s metrics API failure gracefully', async () => {
      mockK8s.custom.listNamespacedCustomObject.mockRejectedValue(new Error('API unavailable'));
      mockK8s.core.readNamespacedResourceQuota.mockRejectedValue(new Error('not found'));

      const db = {} as Parameters<typeof collectClientMetrics>[0];
      const result = await collectClientMetrics(
        db,
        mockK8s as unknown as Parameters<typeof collectClientMetrics>[1],
        'client-5',
        'client-ns-5',
        planLimits,
      );

      // Should still return valid metrics with zeroed usage
      expect(result.cpu.inUse).toBe(0);
      expect(result.memory.inUse).toBe(0);
      expect(result.cpu.available).toBe(4);
    });

    it('should set plan limits as available values', async () => {
      mockK8s.custom.listNamespacedCustomObject.mockResolvedValue({ items: [] });
      mockK8s.core.readNamespacedResourceQuota.mockRejectedValue(new Error('not found'));

      const customLimits = { cpuLimit: 16, memoryLimitGi: 32, storageLimitGi: 500 };
      const db = {} as Parameters<typeof collectClientMetrics>[0];
      const result = await collectClientMetrics(
        db,
        mockK8s as unknown as Parameters<typeof collectClientMetrics>[1],
        'client-6',
        'client-ns-6',
        customLimits,
      );

      expect(result.cpu.available).toBe(16);
      expect(result.memory.available).toBe(32);
      expect(result.storage.available).toBe(500);
    });
  });
});
