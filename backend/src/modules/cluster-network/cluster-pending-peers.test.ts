import { describe, it, expect, vi } from 'vitest';
import {
  listPendingPeers,
  createPendingPeer,
  deletePendingPeer,
  getPendingPeer,
} from './cluster-pending-peers.js';
import type { ClusterNetworkClients } from './k8s-client.js';

function fakeClients(custom: Record<string, unknown>): ClusterNetworkClients {
  return {
    core: {} as ClusterNetworkClients['core'],
    custom: custom as ClusterNetworkClients['custom'],
  };
}

describe('listPendingPeers', () => {
  it('prefers Claimed condition over Ready when both present', async () => {
    const list = vi.fn().mockResolvedValue({
      items: [{
        metadata: { name: 'new-worker', creationTimestamp: '2026-05-08T12:00:00Z' },
        spec: { ip: '10.0.0.5', role: 'worker', ttlSeconds: 1800 },
        status: {
          claimedAt: '2026-05-08T12:01:00Z',
          conditions: [
            { type: 'Ready', status: 'True', reason: 'Pending', message: 'awaiting' },
            { type: 'Claimed', status: 'True', reason: 'NodeRegistered', message: 'observed' },
          ],
        },
      }],
    });
    const out = await listPendingPeers({}, fakeClients({ listClusterCustomObject: list }));
    expect(out[0]).toMatchObject({
      name: 'new-worker',
      claimedAt: '2026-05-08T12:01:00Z',
      ready: 'True',
      readyReason: 'NodeRegistered',
    });
  });

  it('defaults ttlSeconds to 1800 when missing in spec', async () => {
    const list = vi.fn().mockResolvedValue({
      items: [{
        metadata: { name: 'p', creationTimestamp: '2026-05-08T12:00:00Z' },
        spec: { ip: '10.0.0.5', role: 'worker' },
      }],
    });
    const out = await listPendingPeers({}, fakeClients({ listClusterCustomObject: list }));
    expect(out[0]?.ttlSeconds).toBe(1800);
  });
});

describe('createPendingPeer', () => {
  it('writes addedBy from caller', async () => {
    const create = vi.fn().mockResolvedValue({
      metadata: { name: 'p', creationTimestamp: '2026-05-08T12:00:00Z' },
      spec: { ip: '10.0.0.5', role: 'worker', ttlSeconds: 1800, addedBy: 'admin@x' },
    });
    await createPendingPeer(
      { name: 'p', ip: '10.0.0.5', role: 'worker', ttlSeconds: 1800, hostname: '' },
      'admin@x',
      {},
      fakeClients({ createClusterCustomObject: create }),
    );
    const callArg = (create.mock.calls[0]?.[0] ?? {}) as { body?: { spec?: { addedBy?: string } } };
    expect(callArg.body?.spec?.addedBy).toBe('admin@x');
  });

  it('translates 409 into PENDING_PEER_EXISTS', async () => {
    const create = vi.fn().mockRejectedValue({ statusCode: 409 });
    await expect(
      createPendingPeer(
        { name: 'dup', ip: '10.0.0.5', role: 'worker', ttlSeconds: 1800, hostname: '' },
        'admin',
        {},
        fakeClients({ createClusterCustomObject: create }),
      ),
    ).rejects.toMatchObject({ code: 'PENDING_PEER_EXISTS', status: 409 });
  });
});

describe('getPendingPeer', () => {
  it('translates 404 into PENDING_PEER_NOT_FOUND', async () => {
    const get = vi.fn().mockRejectedValue({ statusCode: 404 });
    await expect(
      getPendingPeer('gone', {}, fakeClients({ getClusterCustomObject: get })),
    ).rejects.toMatchObject({ code: 'PENDING_PEER_NOT_FOUND', status: 404 });
  });
});

describe('deletePendingPeer', () => {
  it('translates 404 into PENDING_PEER_NOT_FOUND', async () => {
    const del = vi.fn().mockRejectedValue({ statusCode: 404 });
    await expect(
      deletePendingPeer('gone', {}, fakeClients({ deleteClusterCustomObject: del })),
    ).rejects.toMatchObject({ code: 'PENDING_PEER_NOT_FOUND', status: 404 });
  });

  it('succeeds quietly on 200', async () => {
    const del = vi.fn().mockResolvedValue({});
    await deletePendingPeer('p', {}, fakeClients({ deleteClusterCustomObject: del }));
    expect(del).toHaveBeenCalledTimes(1);
  });
});
