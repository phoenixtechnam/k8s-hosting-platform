import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockGetSettings = vi.fn();
vi.mock('../system-settings/service.js', () => ({
  getSettings: mockGetSettings,
}));

const mockGetInUseImages = vi.fn<[], Promise<Set<string>>>();
const mockClassifyImageByNames = vi.fn();
vi.mock('./service.js', () => ({
  getInUseImages: mockGetInUseImages,
  classifyImageByNames: mockClassifyImageByNames,
  // Real isAnyNameInUse impl — simple set lookup with docker.io/library/ normalisation
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

const mockReapImageNow = vi.fn();
vi.mock('./image-reaper.js', () => ({
  reapImageNow: mockReapImageNow,
}));

const mockDbInsert = vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue([]) });
const mockDbSelect = vi.fn().mockReturnValue({
  from: vi.fn().mockReturnValue({
    where: vi.fn().mockResolvedValue([{ id: 'admin-user-1' }]),
  }),
});
const mockDb = {
  insert: mockDbInsert,
  select: mockDbSelect,
} as unknown as import('../../db/index.js').Database;

vi.mock('../../db/schema.js', () => ({
  users: {},
  notifications: {},
}));

const mockLog = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

const { startImagePressureWatcher, _resetWatcherStateForTests } = await import('./image-pressure-watcher.js');

// ── Helpers ───────────────────────────────────────────────────────────────────

const LARGE_CAPACITY = '100Gi'; // 100 * 1024^3

function makeNode(opts: {
  name: string;
  diskPressure?: boolean;
  capacity?: string;
  images?: { names: string[]; sizeBytes: number }[];
}) {
  return {
    metadata: { name: opts.name },
    status: {
      conditions: opts.diskPressure
        ? [{ type: 'DiskPressure', status: 'True' }]
        : [{ type: 'DiskPressure', status: 'False' }],
      capacity: { 'ephemeral-storage': opts.capacity ?? LARGE_CAPACITY },
      images: (opts.images ?? []).map(img => ({ names: img.names, sizeBytes: img.sizeBytes })),
    },
  };
}

function makeK8s(nodes: ReturnType<typeof makeNode>[]) {
  return {
    core: {
      listNode: vi.fn().mockResolvedValue({ items: nodes }),
    },
  } as unknown as import('../k8s-provisioner/k8s-client.js').K8sClients;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('image-pressure-watcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    _resetWatcherStateForTests();
    mockGetSettings.mockResolvedValue({
      imageGcHighThreshold: 70,
      imageGcLowThreshold: 60,
    });
    // Default: classifyImageByNames returns not-protected
    mockClassifyImageByNames.mockReturnValue({ protected: false });
    // Default: reap succeeds with some freed bytes
    mockReapImageNow.mockResolvedValue({ skipped: false, reclaimedBytes: 50_000_000, nodes: ['node-1'] });
    // Reset DB mock chain
    const valuesMock = vi.fn().mockResolvedValue([]);
    mockDbInsert.mockReturnValue({ values: valuesMock });
    const whereMock = vi.fn().mockResolvedValue([{ id: 'admin-1' }]);
    const fromMock = vi.fn().mockReturnValue({ where: whereMock });
    mockDbSelect.mockReturnValue({ from: fromMock });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not call reapImageNow when no nodes are under pressure', async () => {
    const k8s = makeK8s([
      makeNode({ name: 'node-1', diskPressure: false, images: [] }),
    ]);
    mockGetInUseImages.mockResolvedValue(new Set());

    const handle = startImagePressureWatcher(mockDb, k8s, mockLog as never);
    await vi.advanceTimersByTimeAsync(60_000 + 100);
    handle.stop();

    expect(mockReapImageNow).not.toHaveBeenCalled();
  });

  it('calls reapImageNow for purgeable images when DiskPressure is True', async () => {
    // Use a 1Gi capacity and two images totalling 800MB (74.8% > 60%) so
    // the low-threshold termination check fires AFTER the first reap.
    const img1 = { names: ['ghcr.io/tenant/app:v1.0'], sizeBytes: 500_000_000 };
    const img2 = { names: ['ghcr.io/tenant/app:v0.9'], sizeBytes: 300_000_000 };
    const k8s = makeK8s([
      makeNode({
        name: 'node-1',
        diskPressure: true,
        capacity: '1Gi', // 1Gi ≈ 1.07GB; 800MB / 1.07GB ≈ 74.8% > 60%
        images: [img1, img2],
      }),
    ]);
    mockGetInUseImages.mockResolvedValue(new Set());
    // First reap frees 500MB; projected = 300MB / 1.07GB = 28% < 60% → stop
    mockReapImageNow.mockResolvedValue({ skipped: false, reclaimedBytes: 500_000_000, nodes: ['node-1'] });

    const handle = startImagePressureWatcher(mockDb, k8s, mockLog as never);
    await vi.advanceTimersByTimeAsync(60_000 + 100);
    handle.stop();

    expect(mockReapImageNow).toHaveBeenCalled();
    // Largest image (img1) must be first candidate
    const firstCall = mockReapImageNow.mock.calls[0][2];
    expect(firstCall.image).toBe('ghcr.io/tenant/app:v1.0');
    expect(firstCall.triggeredBy).toBe('pressure_watcher');
    expect(firstCall.triggerRef).toBe('node-1');
  });

  it('skips in-use images', async () => {
    const img = { names: ['ghcr.io/tenant/app:v1.0'], sizeBytes: 500_000_000 };
    const k8s = makeK8s([
      makeNode({ name: 'node-1', diskPressure: true, capacity: '1Gi', images: [img] }),
    ]);
    // Mark the image as in-use
    mockGetInUseImages.mockResolvedValue(new Set(['ghcr.io/tenant/app:v1.0']));

    const handle = startImagePressureWatcher(mockDb, k8s, mockLog as never);
    await vi.advanceTimersByTimeAsync(60_000 + 100);
    handle.stop();

    expect(mockReapImageNow).not.toHaveBeenCalled();
  });

  it('skips protected images (system images in use)', async () => {
    const img = { names: ['docker.io/longhornio/longhorn-manager:v1.5.0'], sizeBytes: 300_000_000 };
    const k8s = makeK8s([
      makeNode({ name: 'node-1', diskPressure: true, capacity: '1Gi', images: [img] }),
    ]);
    mockGetInUseImages.mockResolvedValue(new Set(['docker.io/longhornio/longhorn-manager:v1.5.0']));
    mockClassifyImageByNames.mockReturnValue({ protected: true });

    const handle = startImagePressureWatcher(mockDb, k8s, mockLog as never);
    await vi.advanceTimersByTimeAsync(60_000 + 100);
    handle.stop();

    expect(mockReapImageNow).not.toHaveBeenCalled();
  });

  it('emits an admin notification after successful purge', async () => {
    // 200MB on a 256Mi node = 200/268 = 74.6% > 60% so the loop runs
    const img = { names: ['ghcr.io/tenant/app:v1.0'], sizeBytes: 200_000_000 };
    const k8s = makeK8s([
      makeNode({ name: 'node-1', diskPressure: true, capacity: '256Mi', images: [img] }),
    ]);
    mockGetInUseImages.mockResolvedValue(new Set());
    mockReapImageNow.mockResolvedValue({ skipped: false, reclaimedBytes: 200_000_000, nodes: ['node-1'] });

    const handle = startImagePressureWatcher(mockDb, k8s, mockLog as never);
    await vi.advanceTimersByTimeAsync(60_000 + 100);
    handle.stop();

    // Notification insert should have been called
    expect(mockDbInsert).toHaveBeenCalled();
    const valuesArg = mockDbInsert.mock.results.at(-1)?.value.values.mock.calls[0][0];
    expect(valuesArg?.type).toBe('info');
    expect(valuesArg?.title).toMatch(/Auto-purged/);
    expect(valuesArg?.message).toMatch(/Reclaimed/);
  });

  it('handles listNode failure gracefully', async () => {
    const k8s = {
      core: { listNode: vi.fn().mockRejectedValue(new Error('k8s down')) },
    } as unknown as import('../k8s-provisioner/k8s-client.js').K8sClients;
    mockGetInUseImages.mockResolvedValue(new Set());

    const handle = startImagePressureWatcher(mockDb, k8s, mockLog as never);
    await vi.advanceTimersByTimeAsync(60_000 + 100);
    handle.stop();

    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('listNode failed'));
    expect(mockReapImageNow).not.toHaveBeenCalled();
  });
});
