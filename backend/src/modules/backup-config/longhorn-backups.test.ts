import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listBackups, triggerBackupNow } from './longhorn-backups.js';

function createMockClients() {
  const custom = {
    listNamespacedCustomObject: vi.fn(),
    createNamespacedCustomObject: vi.fn(),
    getNamespacedCustomObject: vi.fn(),
  };
  return { custom } as unknown as {
    custom: {
      listNamespacedCustomObject: ReturnType<typeof vi.fn>;
      createNamespacedCustomObject: ReturnType<typeof vi.fn>;
      getNamespacedCustomObject: ReturnType<typeof vi.fn>;
    };
  };
}

describe('listBackups', () => {
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    clients = createMockClients();
  });

  it('maps Longhorn Backup CRs to the platform record shape', async () => {
    clients.custom.listNamespacedCustomObject.mockResolvedValue({
      items: [
        {
          metadata: { name: 'backup-123', creationTimestamp: '2026-04-22T12:00:00Z' },
          status: {
            volumeName: 'pvc-abc',
            size: '1073741824',
            state: 'Completed',
            url: 's3://bucket/backup-123',
            backupCreatedAt: '2026-04-22T12:05:00Z',
          },
        },
      ],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await listBackups(clients as any);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      name: 'backup-123',
      volumeName: 'pvc-abc',
      size: '1073741824',
      state: 'Completed',
      url: 's3://bucket/backup-123',
      createdAt: '2026-04-22T12:05:00Z',
    });
  });

  it('sorts by createdAt descending (newest first)', async () => {
    clients.custom.listNamespacedCustomObject.mockResolvedValue({
      items: [
        { metadata: { name: 'old' }, status: { backupCreatedAt: '2026-04-20T00:00:00Z' } },
        { metadata: { name: 'new' }, status: { backupCreatedAt: '2026-04-22T00:00:00Z' } },
        { metadata: { name: 'mid' }, status: { backupCreatedAt: '2026-04-21T00:00:00Z' } },
      ],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await listBackups(clients as any);
    expect(out.map((b) => b.name)).toEqual(['new', 'mid', 'old']);
  });

  it('returns an empty list when Longhorn has no backups', async () => {
    clients.custom.listNamespacedCustomObject.mockResolvedValue({ items: [] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await listBackups(clients as any);
    expect(out).toEqual([]);
  });

  it('tolerates partial Backup CRs (missing status fields)', async () => {
    clients.custom.listNamespacedCustomObject.mockResolvedValue({
      items: [{ metadata: { name: 'partial' } }],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await listBackups(clients as any);
    expect(out[0]).toMatchObject({
      name: 'partial',
      volumeName: '',
      state: 'unknown',
      createdAt: null,
    });
  });
});

describe('triggerBackupNow', () => {
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    clients = createMockClients();
  });

  it('calls snapshotCreate, polls Snapshot CR for readyToUse, then snapshotBackup', async () => {
    clients.custom.listNamespacedCustomObject.mockResolvedValue({
      items: [
        { metadata: { name: 'pvc-a' } },
      ],
    });
    // First CR-get tick: not ready. Second: ready.
    clients.custom.getNamespacedCustomObject
      .mockResolvedValueOnce({ status: { readyToUse: false } })
      .mockResolvedValueOnce({ status: { readyToUse: true } });
    const fetchMock = vi.fn()
      // snapshotCreate
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '' })
      // snapshotBackup
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await triggerBackupNow(clients as any, { apiBase: 'http://longhorn-test:9500', fetch: fetchMock });
    expect(out.triggered).toEqual(['pvc-a']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(clients.custom.getNamespacedCustomObject).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map(([u]) => u);
    expect(urls[0]).toContain('action=snapshotCreate');
    expect(urls[1]).toContain('action=snapshotBackup');
  }, 35_000);

  it('treats 404 on Snapshot CR get as "not yet ready" (keeps polling)', async () => {
    clients.custom.listNamespacedCustomObject.mockResolvedValue({
      items: [{ metadata: { name: 'pvc-a' } }],
    });
    clients.custom.getNamespacedCustomObject
      .mockRejectedValueOnce({ statusCode: 404 })
      .mockResolvedValueOnce({ status: { readyToUse: true } });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '' })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await triggerBackupNow(clients as any, { fetch: fetchMock });
    expect(out.triggered).toEqual(['pvc-a']);
  }, 35_000);

  it('does NOT call snapshotBackup when snapshotCreate fails', async () => {
    clients.custom.listNamespacedCustomObject.mockResolvedValue({
      items: [{ metadata: { name: 'pvc-a' } }],
    });
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: false, status: 500, text: async () => 'snap failed',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(triggerBackupNow(clients as any, { fetch: fetchMock })).rejects.toThrow(/snapshotCreate/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns a helpful message when no volumes are labeled', async () => {
    clients.custom.listNamespacedCustomObject.mockResolvedValue({ items: [] });
    const fetchMock = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await triggerBackupNow(clients as any, { fetch: fetchMock });
    expect(out.triggered).toEqual([]);
    expect(out.message).toMatch(/no volumes carry/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('collects per-volume errors and surfaces them when all fail', async () => {
    clients.custom.listNamespacedCustomObject.mockResolvedValue({
      items: [{ metadata: { name: 'pvc-a' } }],
    });
    // snapshotCreate fails immediately — we never reach polling/backup
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'internal' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(triggerBackupNow(clients as any, { fetch: fetchMock })).rejects.toThrow(/pvc-a/);
  });

  it('partial success: some volumes triggered + error list surfaced', async () => {
    clients.custom.listNamespacedCustomObject.mockResolvedValue({
      items: [
        { metadata: { name: 'pvc-a' } },
        { metadata: { name: 'pvc-b' } },
      ],
    });
    // Both volumes' Snapshot CRs are ready on first poll.
    clients.custom.getNamespacedCustomObject
      .mockResolvedValueOnce({ status: { readyToUse: true } })
      .mockResolvedValueOnce({ status: { readyToUse: true } });
    const fetchMock = vi.fn()
      // pvc-a: snapshotCreate ok, snapshotBackup ok
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '' })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '' })
      // pvc-b: snapshotCreate ok, snapshotBackup fails
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '' })
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await triggerBackupNow(clients as any, { fetch: fetchMock });
    expect(out.triggered).toEqual(['pvc-a']);
    expect(out.message).toMatch(/1 failed/);
  }, 35_000);
});
