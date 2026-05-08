import { describe, it, expect, vi } from 'vitest';
import { generateBootstrapCommand } from './bootstrap-command.js';
import type { ClusterNetworkClients } from './k8s-client.js';

function fakeClients(opts: {
  cpp?: unknown;
  cppErr?: unknown;
  nodes?: unknown;
}): ClusterNetworkClients {
  return {
    core: {
      listNode: vi.fn().mockResolvedValue(opts.nodes ?? { items: [] }),
    } as unknown as ClusterNetworkClients['core'],
    custom: {
      getClusterCustomObject: opts.cppErr
        ? vi.fn().mockRejectedValue(opts.cppErr)
        : vi.fn().mockResolvedValue(opts.cpp ?? {}),
    } as unknown as ClusterNetworkClients['custom'],
  };
}

describe('generateBootstrapCommand', () => {
  it('happy path: builds bootstrap.sh + preAuth + picks v4 ready peer', async () => {
    const c = fakeClients({
      cpp: {
        metadata: { name: 'new-worker', creationTimestamp: '2026-05-08T12:00:00Z' },
        spec: { ip: '10.0.0.50', role: 'worker', ttlSeconds: 1800 },
      },
      nodes: {
        items: [
          {
            status: {
              addresses: [{ type: 'InternalIP', address: '10.0.0.1' }],
              conditions: [{ type: 'Ready', status: 'True' }],
            },
          },
          {
            status: {
              addresses: [{ type: 'InternalIP', address: '10.0.0.2' }],
              conditions: [{ type: 'Ready', status: 'True' }],
            },
          },
        ],
      },
    });
    const cmd = await generateBootstrapCommand('new-worker', { domain: 'phoenix-host.net' }, c);
    expect(cmd.serverIp).toBe('10.0.0.1');
    expect(cmd.role).toBe('worker');
    expect(cmd.nodeIp).toBe('10.0.0.50');
    expect(cmd.bootstrapCommand).toContain("--remote '10.0.0.50'");
    expect(cmd.bootstrapCommand).toContain("--server '10.0.0.1'");
    expect(cmd.bootstrapCommand).toContain("--join-as worker");
    expect(cmd.bootstrapCommand).toContain("--domain 'phoenix-host.net'");
    expect(cmd.preAuthCommand).toContain("ssh '10.0.0.1' '/usr/local/bin/peer-firewall-add '10.0.0.50''");
  });

  it('skips not-ready peers when picking server IP', async () => {
    const c = fakeClients({
      cpp: {
        metadata: { name: 'p', creationTimestamp: '2026-05-08T12:00:00Z' },
        spec: { ip: '10.0.0.50', role: 'worker', ttlSeconds: 1800 },
      },
      nodes: {
        items: [
          {
            status: {
              addresses: [{ type: 'InternalIP', address: '10.0.0.1' }],
              conditions: [{ type: 'Ready', status: 'False' }],
            },
          },
          {
            status: {
              addresses: [{ type: 'InternalIP', address: '10.0.0.2' }],
              conditions: [{ type: 'Ready', status: 'True' }],
            },
          },
        ],
      },
    });
    const cmd = await generateBootstrapCommand('p', {}, c);
    expect(cmd.serverIp).toBe('10.0.0.2');
  });

  it('throws NO_READY_PEERS when no Ready Node has an InternalIP', async () => {
    const c = fakeClients({
      cpp: {
        metadata: { name: 'p', creationTimestamp: '2026-05-08T12:00:00Z' },
        spec: { ip: '10.0.0.50', role: 'worker', ttlSeconds: 1800 },
      },
      nodes: {
        items: [
          {
            status: {
              addresses: [{ type: 'ExternalIP', address: '1.2.3.4' }],
              conditions: [{ type: 'Ready', status: 'True' }],
            },
          },
        ],
      },
    });
    await expect(generateBootstrapCommand('p', {}, c)).rejects.toMatchObject({
      code: 'NO_READY_PEERS',
      status: 503,
    });
  });

  it('prefers same-family peer (v6 cpp picks v6 server)', async () => {
    const c = fakeClients({
      cpp: {
        metadata: { name: 'v6peer', creationTimestamp: '2026-05-08T12:00:00Z' },
        spec: { ip: 'fd00::5', role: 'server', ttlSeconds: 1800 },
        status: { family: 'v6' },
      },
      nodes: {
        items: [
          {
            status: {
              addresses: [{ type: 'InternalIP', address: '10.0.0.1' }],
              conditions: [{ type: 'Ready', status: 'True' }],
            },
          },
          {
            status: {
              addresses: [{ type: 'InternalIP', address: 'fd00::1' }],
              conditions: [{ type: 'Ready', status: 'True' }],
            },
          },
        ],
      },
    });
    const cmd = await generateBootstrapCommand('v6peer', {}, c);
    expect(cmd.serverIp).toBe('fd00::1');
  });

  it('CPP not found surfaces PENDING_PEER_NOT_FOUND', async () => {
    const c = fakeClients({ cppErr: { statusCode: 404 } });
    await expect(generateBootstrapCommand('gone', {}, c)).rejects.toMatchObject({
      code: 'PENDING_PEER_NOT_FOUND',
      status: 404,
    });
  });
});
