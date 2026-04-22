import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listBackups, triggerBackupNow } from './longhorn-backups.js';

function createMockClients() {
  const custom = {
    listNamespacedCustomObject: vi.fn(),
    createNamespacedCustomObject: vi.fn(),
  };
  return { custom } as unknown as {
    custom: {
      listNamespacedCustomObject: ReturnType<typeof vi.fn>;
      createNamespacedCustomObject: ReturnType<typeof vi.fn>;
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

  it('calls Longhorn REST snapshotBackup action per labeled volume', async () => {
    clients.custom.listNamespacedCustomObject.mockResolvedValue({
      items: [
        { metadata: { name: 'pvc-a' } },
        { metadata: { name: 'pvc-b' } },
      ],
    });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await triggerBackupNow(clients as any, { apiBase: 'http://longhorn-test:9500', fetch: fetchMock });
    expect(out.triggered).toEqual(['pvc-a', 'pvc-b']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [firstUrl, firstInit] = fetchMock.mock.calls[0];
    expect(firstUrl).toBe('http://longhorn-test:9500/v1/volumes/pvc-a?action=snapshotBackup');
    expect(firstInit.method).toBe('POST');
    const body = JSON.parse(firstInit.body);
    expect(body.labels['platform.phoenix-host.net/trigger']).toBe('manual');
    expect(body.name).toMatch(/^manual-/);
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
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '' })
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await triggerBackupNow(clients as any, { fetch: fetchMock });
    expect(out.triggered).toEqual(['pvc-a']);
    expect(out.message).toMatch(/1 failed/);
  });
});
