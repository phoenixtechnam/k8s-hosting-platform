import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @kubernetes/client-node — system-pvc.ts lazy-imports it inside
// loadK8sClients(). Mirrors the mail-pvc.test.ts harness.
const mockReadPvc = vi.fn();
const mockReadSc = vi.fn();
const mockListPods = vi.fn();
const mockPatchPvc = vi.fn();

vi.mock('@kubernetes/client-node', async () => ({
  KubeConfig: class {
    loadFromCluster() {}
    loadFromFile() {}
    makeApiClient(api: unknown) {
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

vi.mock('../../shared/k8s-patch.js', () => ({
  MERGE_PATCH: { headers: { 'Content-Type': 'application/merge-patch+json' } },
}));

describe('system-pvc.parseQuantity', () => {
  let parseQuantity: typeof import('./system-pvc.js').parseQuantity;

  beforeEach(async () => {
    ({ parseQuantity } = await import('./system-pvc.js'));
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

describe('system-pvc.parseDfOutput', () => {
  let parseDfOutput: typeof import('./system-pvc.js').parseDfOutput;

  beforeEach(async () => {
    ({ parseDfOutput } = await import('./system-pvc.js'));
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

describe('system-pvc.resizeSystemPvc — reject paths', () => {
  let resizeSystemPvc: typeof import('./system-pvc.js').resizeSystemPvc;

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
    ({ resizeSystemPvc } = await import('./system-pvc.js'));
  });

  it('rejects shrink with SYSTEM_PVC_SHRINK_NOT_SUPPORTED', async () => {
    await expect(resizeSystemPvc(3, { kubeconfigPath: undefined })).rejects.toMatchObject({
      code: 'SYSTEM_PVC_SHRINK_NOT_SUPPORTED',
      status: 400,
    });
    expect(mockPatchPvc).not.toHaveBeenCalled();
  });

  it('rejects same-size with SYSTEM_PVC_SAME_SIZE', async () => {
    await expect(resizeSystemPvc(5, { kubeconfigPath: undefined })).rejects.toMatchObject({
      code: 'SYSTEM_PVC_SAME_SIZE',
      status: 400,
    });
    expect(mockPatchPvc).not.toHaveBeenCalled();
  });

  it('rejects when SC has allowVolumeExpansion=false', async () => {
    mockReadSc.mockResolvedValue({ allowVolumeExpansion: false });
    await expect(resizeSystemPvc(10, { kubeconfigPath: undefined })).rejects.toMatchObject({
      code: 'STORAGE_CLASS_NO_EXPANSION',
      status: 400,
    });
    expect(mockPatchPvc).not.toHaveBeenCalled();
  });

  it('rejects newGiB <= 0 with SYSTEM_PVC_INVALID_SIZE', async () => {
    await expect(resizeSystemPvc(0, { kubeconfigPath: undefined })).rejects.toMatchObject({
      code: 'SYSTEM_PVC_INVALID_SIZE',
      status: 400,
    });
    expect(mockPatchPvc).not.toHaveBeenCalled();
  });

  it('rejects non-integer newGiB', async () => {
    await expect(resizeSystemPvc(5.5, { kubeconfigPath: undefined })).rejects.toMatchObject({
      code: 'SYSTEM_PVC_INVALID_SIZE',
    });
  });
});

describe('system-pvc.resizeSystemPvc — happy path', () => {
  let resizeSystemPvc: typeof import('./system-pvc.js').resizeSystemPvc;

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
    ({ resizeSystemPvc } = await import('./system-pvc.js'));
  });

  it('grows from 5Gi to 10Gi via two MERGE_PATCH calls', async () => {
    const result = await resizeSystemPvc(10, { kubeconfigPath: undefined });

    expect(mockPatchPvc).toHaveBeenCalledTimes(2);
    expect(mockPatchPvc.mock.calls[0][0]).toMatchObject({
      name: 'system-db-1',
      namespace: 'platform',
      body: { spec: { resources: { requests: { storage: '10Gi' } } } },
    });
    expect(mockPatchPvc.mock.calls[1][0]).toMatchObject({
      name: 'system-db-1',
      namespace: 'platform',
      body: { metadata: { annotations: { 'platform.phoenix-host.net/last-resized-at': expect.any(String) } } },
    });

    expect(result.pvcName).toBe('system-db-1');
    expect(result.requestedBytes).toBe(10 * 1024 ** 3);
    expect(result.lastResizedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('annotation patch failure does NOT roll back the resize', async () => {
    mockPatchPvc
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('annotation conflict'));

    const result = await resizeSystemPvc(10, { kubeconfigPath: undefined });
    expect(result.requestedBytes).toBe(10 * 1024 ** 3);
  });

  it('surfaces 422 from kubelet as SYSTEM_PVC_GROW_REJECTED', async () => {
    mockPatchPvc.mockRejectedValueOnce(Object.assign(new Error('rejected'), { statusCode: 422 }));
    await expect(resizeSystemPvc(10, { kubeconfigPath: undefined })).rejects.toMatchObject({
      code: 'SYSTEM_PVC_GROW_REJECTED',
      status: 400,
    });
  });
});

describe('system-pvc.getSystemPvcStorage', () => {
  let getSystemPvcStorage: typeof import('./system-pvc.js').getSystemPvcStorage;

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
    ({ getSystemPvcStorage } = await import('./system-pvc.js'));
  });

  it('returns shape including expansionAllowed + lastResizedAt', async () => {
    const r = await getSystemPvcStorage({ kubeconfigPath: undefined });
    expect(r).toMatchObject({
      pvcName: 'system-db-1',
      namespace: 'platform',
      requestedBytes: 5 * 1024 ** 3,
      capacityBytes: 5 * 1024 ** 3,
      storageClass: 'longhorn-system-local',
      expansionAllowed: true,
      lastResizedAt: '2026-05-01T12:00:00.000Z',
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
    const r = await getSystemPvcStorage({ kubeconfigPath: undefined });
    expect(r.lastResizedAt).toBeNull();
  });

  it('returns expansionAllowed=false when SC missing the flag', async () => {
    mockReadSc.mockResolvedValueOnce({});
    const r = await getSystemPvcStorage({ kubeconfigPath: undefined });
    expect(r.expansionAllowed).toBe(false);
  });
});
