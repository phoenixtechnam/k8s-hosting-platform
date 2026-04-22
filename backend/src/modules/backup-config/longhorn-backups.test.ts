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

  it('creates one Backup CR per labeled volume', async () => {
    clients.custom.listNamespacedCustomObject.mockResolvedValue({
      items: [
        { metadata: { name: 'pvc-a' } },
        { metadata: { name: 'pvc-b' } },
      ],
    });
    clients.custom.createNamespacedCustomObject.mockResolvedValue({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await triggerBackupNow(clients as any);
    expect(out.triggered).toEqual(['pvc-a', 'pvc-b']);
    expect(clients.custom.createNamespacedCustomObject).toHaveBeenCalledTimes(2);
    const [firstCall] = clients.custom.createNamespacedCustomObject.mock.calls;
    expect(firstCall[0].body.kind).toBe('Backup');
    expect(firstCall[0].body.metadata.labels['longhornvolume']).toBe('pvc-a');
    expect(firstCall[0].body.spec.snapshotName).toBe('');
  });

  it('returns a helpful message when no volumes are labeled', async () => {
    clients.custom.listNamespacedCustomObject.mockResolvedValue({ items: [] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await triggerBackupNow(clients as any);
    expect(out.triggered).toEqual([]);
    expect(out.message).toMatch(/no volumes carry/i);
    expect(clients.custom.createNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it('treats a 409 Already-Exists as success (idempotent trigger)', async () => {
    clients.custom.listNamespacedCustomObject.mockResolvedValue({
      items: [{ metadata: { name: 'pvc-a' } }],
    });
    clients.custom.createNamespacedCustomObject.mockRejectedValue({ statusCode: 409 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await triggerBackupNow(clients as any);
    expect(out.triggered).toEqual(['pvc-a']);
  });

  it('throws on non-409 errors', async () => {
    clients.custom.listNamespacedCustomObject.mockResolvedValue({
      items: [{ metadata: { name: 'pvc-a' } }],
    });
    clients.custom.createNamespacedCustomObject.mockRejectedValue({
      statusCode: 500,
      message: 'boom',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(triggerBackupNow(clients as any)).rejects.toThrow(/pvc-a/);
  });
});
