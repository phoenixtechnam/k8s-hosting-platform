import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @kubernetes/client-node module — `mail-pvc.ts` lazy-imports it
// inside loadK8sClients(). vi.hoisted+vi.mock at file top ensures any
// dynamic import the module performs returns the test double.
const mockReadPvc = vi.fn();
const mockReadSc = vi.fn();
const mockListPods = vi.fn();
const mockPatchPvc = vi.fn();

vi.mock('@kubernetes/client-node', async () => ({
  KubeConfig: class {
    loadFromCluster() {}
    loadFromFile() {}
    makeApiClient(api: unknown) {
      // The class identity differs between mocks — use the class
      // name to pick the right surface.
      const name = (api as { name?: string })?.name ?? '';
      if (name === 'CoreV1Api') {
        return {
          readNamespacedPersistentVolumeClaim: mockReadPvc,
          patchNamespacedPersistentVolumeClaim: mockPatchPvc,
          listNamespacedPod: mockListPods,
        };
      }
      if (name === 'StorageV1Api') {
        return { readStorageClass: mockReadSc };
      }
      return {};
    }
  },
  CoreV1Api: { name: 'CoreV1Api' },
  StorageV1Api: { name: 'StorageV1Api' },
  Exec: class {
    exec() { return Promise.resolve(); }
  },
}));

// Mock the MERGE_PATCH shim — we just need the patch call to resolve.
vi.mock('../../shared/k8s-patch.js', () => ({
  MERGE_PATCH: { headers: { 'Content-Type': 'application/merge-patch+json' } },
}));

describe('mail-pvc.parseQuantity', () => {
  let parseQuantity: typeof import('./mail-pvc.js').parseQuantity;

  beforeEach(async () => {
    ({ parseQuantity } = await import('./mail-pvc.js'));
  });

  it.each([
    ['5Gi', 5 * 1024 ** 3],
    ['1024Mi', 1024 * 1024 ** 2],
    ['2Ti', 2 * 1024 ** 4],
    ['100Ki', 100 * 1024],
    ['5G', 5 * 1000 ** 3],
    ['10000', 10000],
    ['  5Gi  ', 5 * 1024 ** 3],
  ])('parses %s as %d bytes', (input, expected) => {
    expect(parseQuantity(input)).toBe(expected);
  });

  it('throws on unparseable input', () => {
    expect(() => parseQuantity('5Foo')).toThrow(/unparseable/);
    expect(() => parseQuantity('abc')).toThrow(/unparseable/);
  });
});

describe('mail-pvc.parseDfOutput', () => {
  let parseDfOutput: typeof import('./mail-pvc.js').parseDfOutput;

  beforeEach(async () => {
    ({ parseDfOutput } = await import('./mail-pvc.js'));
  });

  it('extracts used + available from typical df -B1 output', () => {
    const out = [
      'Filesystem    1B-blocks      Used Available Use% Mounted on',
      '/dev/longhorn/pvc-x 5368709120 1073741824 4294967296  20% /var/lib/postgresql/data',
    ].join('\n');
    expect(parseDfOutput(out)).toEqual({
      usedBytes: 1073741824,
      freeBytes: 4294967296,
    });
  });

  it('returns nulls on too-few lines', () => {
    expect(parseDfOutput('header only\n')).toEqual({ usedBytes: null, freeBytes: null });
  });

  it('returns nulls on too-few columns', () => {
    expect(parseDfOutput('h1 h2\nfoo bar\n')).toEqual({ usedBytes: null, freeBytes: null });
  });
});

describe('mail-pvc.resizeMailPvc — reject paths', () => {
  let resizeMailPvc: typeof import('./mail-pvc.js').resizeMailPvc;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Default: PVC is 5Gi requested, 5Gi capacity, SC allows expansion.
    mockReadPvc.mockResolvedValue({
      spec: {
        storageClassName: 'longhorn-system-local',
        resources: { requests: { storage: '5Gi' } },
      },
      status: { capacity: { storage: '5Gi' } },
      metadata: { annotations: {} },
    });
    mockReadSc.mockResolvedValue({ allowVolumeExpansion: true });
    mockListPods.mockResolvedValue({ items: [] }); // df probe falls back to nulls
    ({ resizeMailPvc } = await import('./mail-pvc.js'));
  });

  it('rejects shrink with MAIL_PVC_SHRINK_NOT_SUPPORTED', async () => {
    await expect(resizeMailPvc(3, { kubeconfigPath: undefined })).rejects.toMatchObject({
      code: 'MAIL_PVC_SHRINK_NOT_SUPPORTED',
      status: 400,
    });
    expect(mockPatchPvc).not.toHaveBeenCalled();
  });

  it('rejects same-size with MAIL_PVC_SAME_SIZE', async () => {
    await expect(resizeMailPvc(5, { kubeconfigPath: undefined })).rejects.toMatchObject({
      code: 'MAIL_PVC_SAME_SIZE',
      status: 400,
    });
    expect(mockPatchPvc).not.toHaveBeenCalled();
  });

  it('rejects when SC has allowVolumeExpansion=false with STORAGE_CLASS_NO_EXPANSION', async () => {
    mockReadSc.mockResolvedValue({ allowVolumeExpansion: false });
    await expect(resizeMailPvc(10, { kubeconfigPath: undefined })).rejects.toMatchObject({
      code: 'STORAGE_CLASS_NO_EXPANSION',
      status: 400,
    });
    expect(mockPatchPvc).not.toHaveBeenCalled();
  });

  it('rejects newGiB <= 0 with MAIL_PVC_INVALID_SIZE', async () => {
    await expect(resizeMailPvc(0, { kubeconfigPath: undefined })).rejects.toMatchObject({
      code: 'MAIL_PVC_INVALID_SIZE',
      status: 400,
    });
    expect(mockPatchPvc).not.toHaveBeenCalled();
  });

  it('rejects non-integer newGiB with MAIL_PVC_INVALID_SIZE', async () => {
    await expect(resizeMailPvc(5.5, { kubeconfigPath: undefined })).rejects.toMatchObject({
      code: 'MAIL_PVC_INVALID_SIZE',
    });
  });
});

describe('mail-pvc.resizeMailPvc — happy path', () => {
  let resizeMailPvc: typeof import('./mail-pvc.js').resizeMailPvc;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockReadPvc.mockResolvedValue({
      spec: {
        storageClassName: 'longhorn-system-local',
        resources: { requests: { storage: '5Gi' } },
      },
      status: { capacity: { storage: '5Gi' } },
      metadata: { annotations: {} },
    });
    mockReadSc.mockResolvedValue({ allowVolumeExpansion: true });
    mockListPods.mockResolvedValue({ items: [] });
    mockPatchPvc.mockResolvedValue({});
    ({ resizeMailPvc } = await import('./mail-pvc.js'));
  });

  it('grows from 5Gi to 10Gi via two MERGE_PATCH calls', async () => {
    const result = await resizeMailPvc(10, { kubeconfigPath: undefined });

    // Two patch calls: spec.resources.requests.storage + annotation
    expect(mockPatchPvc).toHaveBeenCalledTimes(2);
    expect(mockPatchPvc.mock.calls[0][0]).toMatchObject({
      name: 'mail-pg-1',
      namespace: 'mail',
      body: { spec: { resources: { requests: { storage: '10Gi' } } } },
    });
    expect(mockPatchPvc.mock.calls[1][0]).toMatchObject({
      name: 'mail-pg-1',
      namespace: 'mail',
      body: { metadata: { annotations: { 'platform.phoenix-host.net/last-resized-at': expect.any(String) } } },
    });

    expect(result.pvcName).toBe('mail-pg-1');
    expect(result.requestedBytes).toBe(10 * 1024 ** 3);
    expect(result.lastResizedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('annotation patch failure does NOT roll back the resize', async () => {
    mockPatchPvc
      .mockResolvedValueOnce({}) // first call (resize) succeeds
      .mockRejectedValueOnce(new Error('annotation conflict')); // second fails

    const result = await resizeMailPvc(10, { kubeconfigPath: undefined });
    // Resize result is still returned — operator's request was honored.
    expect(result.requestedBytes).toBe(10 * 1024 ** 3);
  });

  it('surfaces 422 from kubelet as MAIL_PVC_GROW_REJECTED', async () => {
    mockPatchPvc.mockRejectedValueOnce(Object.assign(new Error('rejected'), { statusCode: 422 }));
    await expect(resizeMailPvc(10, { kubeconfigPath: undefined })).rejects.toMatchObject({
      code: 'MAIL_PVC_GROW_REJECTED',
      status: 400,
    });
  });
});

describe('mail-pvc.getMailPvcStorage', () => {
  let getMailPvcStorage: typeof import('./mail-pvc.js').getMailPvcStorage;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockReadPvc.mockResolvedValue({
      spec: {
        storageClassName: 'longhorn-system-local',
        resources: { requests: { storage: '5Gi' } },
      },
      status: { capacity: { storage: '5Gi' } },
      metadata: {
        annotations: {
          'platform.phoenix-host.net/last-resized-at': '2026-05-01T12:00:00.000Z',
        },
      },
    });
    mockReadSc.mockResolvedValue({ allowVolumeExpansion: true });
    mockListPods.mockResolvedValue({ items: [] });
    ({ getMailPvcStorage } = await import('./mail-pvc.js'));
  });

  it('returns shape including expansionAllowed + lastResizedAt', async () => {
    const r = await getMailPvcStorage({ kubeconfigPath: undefined });
    expect(r).toMatchObject({
      pvcName: 'mail-pg-1',
      namespace: 'mail',
      requestedBytes: 5 * 1024 ** 3,
      capacityBytes: 5 * 1024 ** 3,
      storageClass: 'longhorn-system-local',
      expansionAllowed: true,
      lastResizedAt: '2026-05-01T12:00:00.000Z',
      // df probe falls back to null when no primary pod is found
      usedBytes: null,
      freeBytes: null,
    });
  });

  it('returns null lastResizedAt when annotation absent', async () => {
    mockReadPvc.mockResolvedValueOnce({
      spec: {
        storageClassName: 'longhorn-system-local',
        resources: { requests: { storage: '5Gi' } },
      },
      status: { capacity: { storage: '5Gi' } },
      metadata: { annotations: {} },
    });
    const r = await getMailPvcStorage({ kubeconfigPath: undefined });
    expect(r.lastResizedAt).toBeNull();
  });

  it('returns expansionAllowed=false when SC missing the flag', async () => {
    mockReadSc.mockResolvedValueOnce({}); // allowVolumeExpansion absent
    const r = await getMailPvcStorage({ kubeconfigPath: undefined });
    expect(r.expansionAllowed).toBe(false);
  });
});
