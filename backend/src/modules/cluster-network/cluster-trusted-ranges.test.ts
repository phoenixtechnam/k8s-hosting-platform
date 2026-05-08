import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  listTrustedRanges,
  createTrustedRange,
  updateTrustedRangeDescription,
  deleteTrustedRange,
} from './cluster-trusted-ranges.js';
import type { ClusterNetworkClients } from './k8s-client.js';

function fakeClients(custom: Record<string, unknown>): ClusterNetworkClients {
  return {
    core: {} as ClusterNetworkClients['core'],
    custom: custom as ClusterNetworkClients['custom'],
  };
}

describe('listTrustedRanges', () => {
  it('maps CRs to TrustedRange shape', async () => {
    const list = vi.fn().mockResolvedValue({
      items: [
        {
          metadata: { name: 'office', creationTimestamp: '2026-05-08T12:00:00Z' },
          spec: { cidr: '198.51.100.0/24', description: 'NYC office', addedBy: 'admin@x' },
          status: {
            normalizedCidr: '198.51.100.0/24',
            family: 'v4',
            lastSyncedAt: '2026-05-08T12:01:00Z',
            conditions: [{ type: 'Ready', status: 'True', reason: 'Synced', message: 'in nft set' }],
          },
        },
      ],
    });
    const out = await listTrustedRanges({}, fakeClients({ listClusterCustomObject: list }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      name: 'office',
      cidr: '198.51.100.0/24',
      family: 'v4',
      ready: 'True',
      readyReason: 'Synced',
    });
  });

  it('handles empty items', async () => {
    const list = vi.fn().mockResolvedValue({});
    const out = await listTrustedRanges({}, fakeClients({ listClusterCustomObject: list }));
    expect(out).toEqual([]);
  });

  it('maps RBAC failure to CLUSTER_NETWORK_FORBIDDEN', async () => {
    const list = vi.fn().mockRejectedValue({ statusCode: 403, message: 'forbidden' });
    await expect(
      listTrustedRanges({}, fakeClients({ listClusterCustomObject: list })),
    ).rejects.toMatchObject({ code: 'CLUSTER_NETWORK_FORBIDDEN', status: 503 });
  });
});

describe('createTrustedRange', () => {
  it('writes addedBy from caller, never client-supplied', async () => {
    const create = vi.fn().mockResolvedValue({
      metadata: { name: 'office', creationTimestamp: '2026-05-08T12:00:00Z' },
      spec: { cidr: '10.0.0.0/16', description: '', addedBy: 'admin@x' },
      status: { conditions: [{ type: 'Ready', status: 'Unknown' }] },
    });
    await createTrustedRange(
      { name: 'office', cidr: '10.0.0.0/16', description: '' },
      'admin@x',
      {},
      fakeClients({ createClusterCustomObject: create }),
    );
    expect(create).toHaveBeenCalledTimes(1);
    const callArg = (create.mock.calls[0]?.[0] ?? {}) as { body?: { spec?: { addedBy?: string } } };
    expect(callArg.body?.spec?.addedBy).toBe('admin@x');
  });

  it('translates 409 into TRUSTED_RANGE_EXISTS', async () => {
    const create = vi.fn().mockRejectedValue({ statusCode: 409, message: 'already exists' });
    await expect(
      createTrustedRange(
        { name: 'dup', cidr: '10.0.0.0/16', description: '' },
        'admin',
        {},
        fakeClients({ createClusterCustomObject: create }),
      ),
    ).rejects.toMatchObject({ code: 'TRUSTED_RANGE_EXISTS', status: 409 });
  });

  it('translates 422 into TRUSTED_RANGE_INVALID', async () => {
    const create = vi.fn().mockRejectedValue({
      statusCode: 422,
      message: 'spec.cidr in body should match pattern',
    });
    await expect(
      createTrustedRange(
        { name: 'bad', cidr: '999.999.999.999', description: '' },
        'admin',
        {},
        fakeClients({ createClusterCustomObject: create }),
      ),
    ).rejects.toMatchObject({ code: 'TRUSTED_RANGE_INVALID', status: 400 });
  });
});

describe('updateTrustedRangeDescription', () => {
  it('only patches spec.description (not cidr)', async () => {
    const patch = vi.fn().mockResolvedValue({
      metadata: { name: 'office', creationTimestamp: '2026-05-08T12:00:00Z' },
      spec: { cidr: '10.0.0.0/16', description: 'updated', addedBy: 'admin' },
      status: { conditions: [{ type: 'Ready', status: 'True' }] },
    });
    await updateTrustedRangeDescription(
      'office',
      { description: 'updated' },
      {},
      fakeClients({ patchClusterCustomObject: patch }),
    );
    const callArg = (patch.mock.calls[0]?.[0] ?? {}) as { body?: unknown };
    expect(callArg.body).toEqual({ spec: { description: 'updated' } });
  });

  it('translates 404 into TRUSTED_RANGE_NOT_FOUND', async () => {
    const patch = vi.fn().mockRejectedValue({ statusCode: 404 });
    await expect(
      updateTrustedRangeDescription(
        'gone',
        { description: 'x' },
        {},
        fakeClients({ patchClusterCustomObject: patch }),
      ),
    ).rejects.toMatchObject({ code: 'TRUSTED_RANGE_NOT_FOUND', status: 404 });
  });
});

describe('deleteTrustedRange', () => {
  it('translates 404 into TRUSTED_RANGE_NOT_FOUND', async () => {
    const del = vi.fn().mockRejectedValue({ statusCode: 404 });
    await expect(
      deleteTrustedRange('gone', {}, fakeClients({ deleteClusterCustomObject: del })),
    ).rejects.toMatchObject({ code: 'TRUSTED_RANGE_NOT_FOUND', status: 404 });
  });

  it('returns void on success', async () => {
    const del = vi.fn().mockResolvedValue({});
    const result = await deleteTrustedRange('office', {}, fakeClients({ deleteClusterCustomObject: del }));
    expect(result).toBeUndefined();
    expect(del).toHaveBeenCalledTimes(1);
  });
});
