import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── DB Mock ────────────────────────────────────────────────────────────────
const settingsStore = new Map<string, string>();

function buildSelectChain(key: string) {
  const row = settingsStore.has(key) ? { key, value: settingsStore.get(key)! } : undefined;
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(row ? [row] : []),
    }),
  };
}

const mockDb = {
  select: vi.fn().mockImplementation(() => ({
    from: vi.fn().mockImplementation(() => ({
      where: vi.fn().mockImplementation((_condition: unknown) => {
        // The condition encodes the key — we inspect the last setSetting/getSetting key via call tracking
        return Promise.resolve([]);
      }),
    })),
  })),
  insert: vi.fn().mockImplementation(() => ({
    values: vi.fn().mockImplementation(() => ({
      onDuplicateKeyUpdate: vi.fn().mockResolvedValue(undefined),
    })),
  })),
  update: vi.fn().mockImplementation(() => ({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  })),
};

// More precise DB mock: intercept eq() calls to track keys
vi.mock('drizzle-orm', () => ({
  eq: vi.fn((_col: unknown, value: unknown) => ({ _type: 'eq', value })),
}));

vi.mock('../../db/schema.js', () => ({
  platformSettings: {
    key: 'platformSettings.key',
    value: 'platformSettings.value',
  },
}));

// ─── Rebuild mock DB with key tracking ──────────────────────────────────────
function createTrackedDb() {
  const db = {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockImplementation((condition: { _type: string; value: string }) => {
          const key = condition?.value as string;
          const stored = settingsStore.get(key);
          return Promise.resolve(stored !== undefined ? [{ key, value: stored }] : []);
        }),
      })),
    })),
    insert: vi.fn().mockImplementation(() => ({
      values: vi.fn().mockImplementation((vals: { key: string; value: string }) => ({
        onDuplicateKeyUpdate: vi.fn().mockImplementation(() => {
          settingsStore.set(vals.key, vals.value);
          return Promise.resolve(undefined);
        }),
      })),
    })),
  };
  return db as unknown as import('../../db/index.js').Database;
}

// ─── Module Under Test ──────────────────────────────────────────────────────
let getVersionInfo: typeof import('./service.js').getVersionInfo;
let updateSettings: typeof import('./service.js').updateSettings;
let getCapacityCheck: typeof import('./service.js').getCapacityCheck;
let triggerUpdate: typeof import('./service.js').triggerUpdate;

let originalFetch: typeof globalThis.fetch;

beforeEach(async () => {
  settingsStore.clear();
  originalFetch = globalThis.fetch;
  vi.resetModules();
  const mod = await import('./service.js');
  getVersionInfo = mod.getVersionInfo;
  updateSettings = mod.updateSettings;
  getCapacityCheck = mod.getCapacityCheck;
  triggerUpdate = mod.triggerUpdate;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('platform-updates service', () => {
  describe('getVersionInfo', () => {
    it('should return correct structure with mocked fetch', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ tags: ['1.2.0', '1.1.0', '0.1.0'] }),
      });

      const db = createTrackedDb();
      const result = await getVersionInfo(db);

      expect(result).toHaveProperty('currentVersion');
      expect(result).toHaveProperty('latestVersion');
      expect(result).toHaveProperty('updateAvailable');
      expect(result).toHaveProperty('environment');
      expect(result).toHaveProperty('autoUpdate');
      expect(result).toHaveProperty('lastCheckedAt');
      expect(result.latestVersion).toBe('1.2.0');
    });

    it('should detect update available when latest > current', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ tags: ['2.0.0', '1.0.0'] }),
      });

      const db = createTrackedDb();
      const result = await getVersionInfo(db);

      expect(result.updateAvailable).toBe(true);
      expect(result.latestVersion).toBe('2.0.0');
    });

    it('should not mark update available when latest equals current', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ tags: ['0.1.0'] }),
      });

      const db = createTrackedDb();
      const result = await getVersionInfo(db);

      expect(result.updateAvailable).toBe(false);
    });

    it('should use cached version when fetch fails', async () => {
      settingsStore.set('latest_version', '1.5.0');
      settingsStore.set('last_update_check', new Date(Date.now() - 10 * 60 * 1000).toISOString());

      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      const db = createTrackedDb();
      const result = await getVersionInfo(db);

      expect(result.latestVersion).toBe('1.5.0');
    });
  });

  describe('updateSettings', () => {
    it('should store auto_update setting and return it', async () => {
      const db = createTrackedDb();
      const result = await updateSettings(db, true);

      expect(result).toEqual({ autoUpdate: true });
      expect(settingsStore.get('auto_update')).toBe('true');
    });

    it('should store false value', async () => {
      const db = createTrackedDb();
      const result = await updateSettings(db, false);

      expect(result).toEqual({ autoUpdate: false });
      expect(settingsStore.get('auto_update')).toBe('false');
    });
  });

  describe('getCapacityCheck', () => {
    it('should return fits=true when resources are sufficient', async () => {
      const db = createTrackedDb();
      settingsStore.set('node_cpu_total', '4');
      settingsStore.set('node_memory_total', '8Gi');
      settingsStore.set('node_storage_total', '80Gi');

      const result = await getCapacityCheck(db, '500m', '1Gi', '10Gi');

      expect(result.fits).toBe(true);
      expect(result.requestedCpu).toBe(0.5);
      expect(result.requestedMemory).toBe(1);
      expect(result.requestedStorage).toBe(10);
      expect(result.totalCpu).toBe(4);
      expect(result.totalMemory).toBe(8);
      expect(result.totalStorage).toBe(80);
      expect(result.warnings).toEqual([]);
    });

    it('should return fits=false when CPU exceeds capacity', async () => {
      const db = createTrackedDb();
      settingsStore.set('node_cpu_total', '2');
      settingsStore.set('node_memory_total', '8Gi');
      settingsStore.set('node_storage_total', '80Gi');

      const result = await getCapacityCheck(db, '4', '1Gi', '10Gi');

      expect(result.fits).toBe(false);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain('CPU');
    });

    it('should return fits=false when memory exceeds capacity', async () => {
      const db = createTrackedDb();
      settingsStore.set('node_cpu_total', '4');
      settingsStore.set('node_memory_total', '4Gi');
      settingsStore.set('node_storage_total', '80Gi');

      const result = await getCapacityCheck(db, '500m', '8Gi', '10Gi');

      expect(result.fits).toBe(false);
      expect(result.warnings.some((w: string) => w.includes('memory'))).toBe(true);
    });

    it('should return fits=false when storage exceeds capacity', async () => {
      const db = createTrackedDb();
      settingsStore.set('node_cpu_total', '4');
      settingsStore.set('node_memory_total', '8Gi');
      settingsStore.set('node_storage_total', '20Gi');

      const result = await getCapacityCheck(db, '500m', '1Gi', '30Gi');

      expect(result.fits).toBe(false);
      expect(result.warnings.some((w: string) => w.includes('storage'))).toBe(true);
    });

    it('should use defaults when settings not in DB', async () => {
      const db = createTrackedDb();

      const result = await getCapacityCheck(db, '1', '2Gi', '10Gi');

      // defaults: 4 CPU, 8Gi memory, 80Gi storage
      expect(result.totalCpu).toBe(4);
      expect(result.totalMemory).toBe(8);
      expect(result.totalStorage).toBe(80);
      expect(result.fits).toBe(true);
    });

    it('should parse millicores CPU values', async () => {
      const db = createTrackedDb();

      const result = await getCapacityCheck(db, '2000m', '1Gi', '1Gi');

      expect(result.requestedCpu).toBe(2);
    });

    it('should parse Mi memory values', async () => {
      const db = createTrackedDb();

      const result = await getCapacityCheck(db, '500m', '512Mi', '1Gi');

      expect(result.requestedMemory).toBe(0.5);
    });
  });

  describe('triggerUpdate', () => {
    it('should return "Already up to date" when no update available', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ tags: ['0.1.0'] }),
      });

      const db = createTrackedDb();
      const result = await triggerUpdate(db);

      expect(result.message).toBe('Already up to date');
    });

    it('should set pending_update_version when update is available', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ tags: ['3.0.0', '2.0.0', '0.1.0'] }),
      });

      const db = createTrackedDb();
      const result = await triggerUpdate(db);

      expect(result.message).toBe('Update initiated');
      expect(result.targetVersion).toBe('3.0.0');
      expect(settingsStore.get('pending_update_version')).toBe('3.0.0');
    });
  });
});
