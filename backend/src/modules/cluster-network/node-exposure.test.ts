import { describe, it, expect, vi } from 'vitest';
import { setNodeExposure } from './node-exposure.js';
import type { ClusterNetworkClients } from './k8s-client.js';

function fakeClients(core: Record<string, unknown>): ClusterNetworkClients {
  return {
    core: core as ClusterNetworkClients['core'],
    custom: {} as ClusterNetworkClients['custom'],
  };
}

describe('setNodeExposure', () => {
  it('writes the exposure label + audit annotation via merge-patch', async () => {
    const patchNode = vi.fn().mockResolvedValue({});
    await setNodeExposure(
      'worker-1',
      { exposure: 'private' },
      'admin@x',
      {},
      fakeClients({ patchNode }),
    );
    expect(patchNode).toHaveBeenCalledTimes(1);
    const callArg = (patchNode.mock.calls[0]?.[0] ?? {}) as { name?: string; body?: { metadata?: { labels?: Record<string, string | null>; annotations?: Record<string, string> } } };
    expect(callArg.name).toBe('worker-1');
    expect(callArg.body?.metadata?.labels).toEqual({
      'platform.phoenix-host.net/exposure': 'private',
    });
    expect(callArg.body?.metadata?.annotations).toBeDefined();
    expect(callArg.body?.metadata?.annotations?.['platform.phoenix-host.net/exposure-audit']).toMatch(
      /^admin@x\|.*\|private$/,
    );
  });

  it('clears the label when exposure=public (label value null in patch)', async () => {
    const patchNode = vi.fn().mockResolvedValue({});
    await setNodeExposure(
      'worker-1',
      { exposure: 'public' },
      'admin@x',
      {},
      fakeClients({ patchNode }),
    );
    const callArg = (patchNode.mock.calls[0]?.[0] ?? {}) as { body?: { metadata?: { labels?: Record<string, string | null> } } };
    // null on the label key removes it via merge-patch semantics
    expect(callArg.body?.metadata?.labels?.['platform.phoenix-host.net/exposure']).toBeNull();
  });

  it('translates 404 into NODE_NOT_FOUND', async () => {
    const patchNode = vi.fn().mockRejectedValue({ statusCode: 404 });
    await expect(
      setNodeExposure(
        'gone',
        { exposure: 'private' },
        'admin',
        {},
        fakeClients({ patchNode }),
      ),
    ).rejects.toMatchObject({ code: 'NODE_NOT_FOUND', status: 404 });
  });

  it('translates 403 into CLUSTER_NETWORK_FORBIDDEN', async () => {
    const patchNode = vi.fn().mockRejectedValue({ statusCode: 403 });
    await expect(
      setNodeExposure(
        'n',
        { exposure: 'private' },
        'admin',
        {},
        fakeClients({ patchNode }),
      ),
    ).rejects.toMatchObject({ code: 'CLUSTER_NETWORK_FORBIDDEN', status: 503 });
  });
});
