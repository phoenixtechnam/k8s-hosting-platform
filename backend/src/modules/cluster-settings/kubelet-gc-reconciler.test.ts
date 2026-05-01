import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockGetSettings = vi.fn();
vi.mock('../system-settings/service.js', () => ({
  getSettings: mockGetSettings,
}));

const mockLog = {
  warn: vi.fn(),
  info: vi.fn(),
};

const mockDb = {} as unknown as import('../../db/index.js').Database;

// ── Import after mocks ────────────────────────────────────────────────────────
// parseNodeGcArgs is internal — we test it indirectly via startKubeletGcReconciler
const { startKubeletGcReconciler } = await import('./kubelet-gc-reconciler.js');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeK8s(nodes: { name: string; annotations?: Record<string, string> }[]) {
  return {
    core: {
      listNode: vi.fn().mockResolvedValue({
        items: nodes.map(n => ({
          metadata: { name: n.name, annotations: n.annotations ?? {} },
        })),
      }),
    },
  } as unknown as import('../k8s-provisioner/k8s-client.js').K8sClients;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('kubelet-gc-reconciler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits no warning when node args match desired settings', async () => {
    mockGetSettings.mockResolvedValue({
      imageGcHighThreshold: 70,
      imageGcLowThreshold: 60,
      imageGcMinTtlMinutes: 60,
    });
    const k8s = makeK8s([{
      name: 'node-1',
      annotations: {
        'k3s.io/node-args': JSON.stringify([
          'server',
          '--kubelet-arg=image-gc-high-threshold=70',
          '--kubelet-arg=image-gc-low-threshold=60',
          '--kubelet-arg=minimum-image-ttl-duration=60m',
        ]),
      },
    }]);

    const handle = startKubeletGcReconciler(mockDb, k8s, mockLog as never);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100);
    handle.stop();

    expect(mockLog.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ drift: expect.any(Array) }),
      expect.any(String),
    );
  });

  it('logs drift warning when node GC thresholds differ from desired', async () => {
    mockGetSettings.mockResolvedValue({
      imageGcHighThreshold: 70,
      imageGcLowThreshold: 60,
      imageGcMinTtlMinutes: 60,
    });
    const k8s = makeK8s([{
      name: 'node-1',
      annotations: {
        'k3s.io/node-args': JSON.stringify([
          'server',
          '--kubelet-arg=image-gc-high-threshold=85',  // old default
          '--kubelet-arg=image-gc-low-threshold=80',   // old default
          '--kubelet-arg=minimum-image-ttl-duration=60m',
        ]),
      },
    }]);

    const handle = startKubeletGcReconciler(mockDb, k8s, mockLog as never);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100);
    handle.stop();

    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        node: 'node-1',
        drift: expect.arrayContaining([
          expect.stringContaining('image-gc-high-threshold'),
          expect.stringContaining('image-gc-low-threshold'),
        ]),
      }),
      expect.stringContaining('drift detected'),
    );
  });

  it('skips nodes without k3s annotation', async () => {
    mockGetSettings.mockResolvedValue({
      imageGcHighThreshold: 70,
      imageGcLowThreshold: 60,
      imageGcMinTtlMinutes: 60,
    });
    const k8s = makeK8s([{ name: 'node-1' }]); // no annotations

    const handle = startKubeletGcReconciler(mockDb, k8s, mockLog as never);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100);
    handle.stop();

    expect(mockLog.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ drift: expect.any(Array) }),
      expect.any(String),
    );
  });

  it('handles listNode failure gracefully', async () => {
    mockGetSettings.mockResolvedValue({
      imageGcHighThreshold: 70,
      imageGcLowThreshold: 60,
      imageGcMinTtlMinutes: 60,
    });
    const k8s = {
      core: { listNode: vi.fn().mockRejectedValue(new Error('k8s down')) },
    } as unknown as import('../k8s-provisioner/k8s-client.js').K8sClients;

    const handle = startKubeletGcReconciler(mockDb, k8s, mockLog as never);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100);
    handle.stop();

    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.stringContaining('listNode failed'),
    );
  });

  it('stop() prevents further ticks', async () => {
    mockGetSettings.mockResolvedValue({
      imageGcHighThreshold: 70,
      imageGcLowThreshold: 60,
      imageGcMinTtlMinutes: 60,
    });
    const k8s = makeK8s([]);
    const handle = startKubeletGcReconciler(mockDb, k8s, mockLog as never);

    handle.stop();
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);

    // After stop, listNode should never be called
    expect((k8s.core.listNode as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });
});
