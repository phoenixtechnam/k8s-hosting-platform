import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @kubernetes/client-node module — `mail-pvc.ts` lazy-imports it
// inside loadK8sClients(). vi.hoisted+vi.mock at file top ensures any
// dynamic import the module performs returns the test double.
//
// 2026-05-14 streamline: resize was removed (mail is local-path only,
// local-path does not quota requests.storage so resize was a no-op).
// The module is now read-only; tests cover parseQuantity, parseDuOutput,
// and getMailPvcStorage only.
const mockReadPvc = vi.fn();
const mockListPods = vi.fn();

vi.mock('@kubernetes/client-node', async () => ({
  KubeConfig: class {
    loadFromCluster() {}
    loadFromFile() {}
    makeApiClient(api: unknown) {
      const name = (api as { name?: string })?.name ?? '';
      if (name === 'CoreV1Api') {
        return {
          readNamespacedPersistentVolumeClaim: mockReadPvc,
          listNamespacedPod: mockListPods,
        };
      }
      if (name === 'StorageV1Api') {
        return {};
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

describe('mail-pvc.parseDuOutput', () => {
  let parseDuOutput: typeof import('./mail-pvc.js').parseDuOutput;

  beforeEach(async () => {
    ({ parseDuOutput } = await import('./mail-pvc.js'));
  });

  it('extracts byte count from typical du -sb output', () => {
    expect(parseDuOutput('6020626\t/var/lib/stalwart/data\n')).toBe(6020626);
  });

  it('handles space-separated output (some du variants)', () => {
    expect(parseDuOutput('12345678 /var/lib/stalwart/data')).toBe(12345678);
  });

  it('returns null on empty input', () => {
    expect(parseDuOutput('')).toBeNull();
    expect(parseDuOutput('   \n')).toBeNull();
  });

  it('returns null on unparseable first field', () => {
    expect(parseDuOutput('NaN\t/path')).toBeNull();
    expect(parseDuOutput('-100\t/path')).toBeNull();
  });

  it('accepts zero (empty data dir)', () => {
    expect(parseDuOutput('0\t/var/lib/stalwart/data')).toBe(0);
  });
});

describe('mail-pvc.getMailPvcStorage', () => {
  let getMailPvcStorage: typeof import('./mail-pvc.js').getMailPvcStorage;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockReadPvc.mockResolvedValue({
      spec: {
        storageClassName: 'local-path',
        resources: { requests: { storage: '20Gi' } },
      },
      status: { capacity: { storage: '20Gi' } },
      metadata: { annotations: {} },
    });
    mockListPods.mockResolvedValue({ items: [] });
    ({ getMailPvcStorage } = await import('./mail-pvc.js'));
  });

  it('returns read-only shape with expansionAllowed=false, lastResizedAt=null', async () => {
    const r = await getMailPvcStorage({ kubeconfigPath: undefined });
    expect(r).toMatchObject({
      pvcName: 'stalwart-rocksdb-data',
      namespace: 'mail',
      requestedBytes: 20 * 1024 ** 3,
      capacityBytes: 20 * 1024 ** 3,
      storageClass: 'local-path',
      // Streamline (2026-05-14): mail is local-path only, resize was
      // removed because local-path does not enforce requests.storage.
      // The response always emits false / null for these fields now.
      expansionAllowed: false,
      lastResizedAt: null,
      // du probe falls back to nulls when no Running stalwart-mail pod found.
      usedBytes: null,
      freeBytes: null,
    });
  });
});
