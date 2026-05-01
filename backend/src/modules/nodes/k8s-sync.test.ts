import { describe, it, expect, vi } from 'vitest';
import { projectNode, parseCpuMillicores, parseMemoryBytes, applyNewServerDefault } from './k8s-sync.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

describe('projectNode', () => {
  it('defaults unlabeled node to worker with canHostClientWorkloads=true', () => {
    const observed = projectNode({
      metadata: { name: 'node-1', labels: {} },
    });
    expect(observed.role).toBe('worker');
    expect(observed.canHostClientWorkloads).toBe(true);
  });

  it('respects platform.phoenix-host.net/node-role=server label', () => {
    const observed = projectNode({
      metadata: {
        name: 'node-1',
        labels: { 'platform.phoenix-host.net/node-role': 'server' },
      },
    });
    expect(observed.role).toBe('server');
    // Server with no host-client label defaults to false.
    expect(observed.canHostClientWorkloads).toBe(false);
  });

  it('respects host-client-workloads=true override on server', () => {
    const observed = projectNode({
      metadata: {
        name: 'node-1',
        labels: {
          'platform.phoenix-host.net/node-role': 'server',
          'platform.phoenix-host.net/host-client-workloads': 'true',
        },
      },
    });
    expect(observed.role).toBe('server');
    expect(observed.canHostClientWorkloads).toBe(true);
  });

  it('prefers ExternalIP over InternalIP for publicIp', () => {
    const observed = projectNode({
      metadata: { name: 'node-1', labels: {} },
      status: {
        addresses: [
          { type: 'InternalIP', address: '10.0.0.5' },
          { type: 'ExternalIP', address: '89.167.3.56' },
        ],
      },
    });
    expect(observed.publicIp).toBe('89.167.3.56');
  });

  it('extracts k3s version from osImage', () => {
    const observed = projectNode({
      metadata: { name: 'node-1', labels: {} },
      status: {
        nodeInfo: {
          kubeletVersion: 'v1.31.4+k3s1',
          osImage: 'K3s v1.31.4+k3s1',
        },
      },
    });
    expect(observed.kubeletVersion).toBe('v1.31.4+k3s1');
    expect(observed.k3sVersion).toBe('v1.31.4+k3s1');
  });

  it('parses taints and preserves key+value+effect', () => {
    const observed = projectNode({
      metadata: { name: 'node-1', labels: {} },
      spec: {
        taints: [
          { key: 'platform.phoenix-host.net/server-only', value: 'true', effect: 'NoSchedule' },
        ],
      },
    });
    expect(observed.taints).toEqual([
      { key: 'platform.phoenix-host.net/server-only', value: 'true', effect: 'NoSchedule' },
    ]);
  });
});

describe('parseCpuMillicores', () => {
  it('parses millicore-suffixed strings', () => {
    expect(parseCpuMillicores('3500m')).toBe(3500);
  });
  it('parses plain core counts as millicores', () => {
    expect(parseCpuMillicores('4')).toBe(4000);
  });
  it('returns null for undefined input', () => {
    expect(parseCpuMillicores(undefined)).toBeNull();
  });
  it('returns null for unparseable input', () => {
    expect(parseCpuMillicores('abc')).toBeNull();
  });
});

describe('applyNewServerDefault', () => {
  // The reconciler stamps the missing host-client-workloads label on a
  // freshly-joined server. These tests verify both the label and taint
  // shape match bootstrap.sh's behaviour for the same flag value.

  function makeK8sStub(): { k8s: K8sClients; patchSpy: ReturnType<typeof vi.fn> } {
    const patchSpy = vi.fn().mockResolvedValue({});
    const k8s = {
      core: { patchNode: patchSpy },
    } as unknown as K8sClients;
    return { k8s, patchSpy };
  }

  it('stamps host-client-workloads=true and removes server-only taint when default=true', async () => {
    const { k8s, patchSpy } = makeK8sStub();
    await applyNewServerDefault(k8s, 'server-1', true, [
      { key: 'platform.phoenix-host.net/server-only', value: 'true', effect: 'NoSchedule' },
    ]);

    expect(patchSpy).toHaveBeenCalledOnce();
    const arg = patchSpy.mock.calls[0][0] as { name: string; body: unknown };
    expect(arg.name).toBe('server-1');
    const body = arg.body as {
      metadata: { labels: Record<string, string> };
      spec: { taints: Array<{ key: string }> };
    };
    expect(body.metadata.labels['platform.phoenix-host.net/host-client-workloads']).toBe('true');
    expect(body.spec.taints.find((t) => t.key === 'platform.phoenix-host.net/server-only')).toBeUndefined();
  });

  it('stamps host-client-workloads=false and applies server-only NoSchedule taint when default=false', async () => {
    const { k8s, patchSpy } = makeK8sStub();
    await applyNewServerDefault(k8s, 'server-1', false, []);

    expect(patchSpy).toHaveBeenCalledOnce();
    const arg = patchSpy.mock.calls[0][0] as { body: unknown };
    const body = arg.body as {
      metadata: { labels: Record<string, string> };
      spec: { taints: Array<{ key: string; value?: string; effect: string }> };
    };
    expect(body.metadata.labels['platform.phoenix-host.net/host-client-workloads']).toBe('false');
    const ours = body.spec.taints.find((t) => t.key === 'platform.phoenix-host.net/server-only');
    expect(ours).toEqual({ key: 'platform.phoenix-host.net/server-only', value: 'true', effect: 'NoSchedule' });
  });

  it('preserves operator-set taints with other keys when default=false', async () => {
    const { k8s, patchSpy } = makeK8sStub();
    await applyNewServerDefault(k8s, 'server-1', false, [
      { key: 'team-isolation', value: 'platform', effect: 'NoSchedule' },
    ]);

    const arg = patchSpy.mock.calls[0][0] as { body: unknown };
    const body = arg.body as { spec: { taints: Array<{ key: string }> } };
    expect(body.spec.taints.map((t) => t.key)).toContain('team-isolation');
    expect(body.spec.taints.map((t) => t.key)).toContain('platform.phoenix-host.net/server-only');
  });
});

describe('projectNode + applyNewServerDefault contract', () => {
  // The reconciler relies on projectNode setting `canHostClientWorkloads`
  // to false for unlabelled servers — that "missing label" state is what
  // triggers the default to be applied. This test pins that contract so
  // a future projectNode change can't silently disable the reconciler.
  it('an unlabeled server projects to canHostClientWorkloads=false (the trigger)', () => {
    const observed = projectNode({
      metadata: {
        name: 'fresh-server',
        labels: { 'platform.phoenix-host.net/node-role': 'server' },
      },
    });
    expect(observed.role).toBe('server');
    expect(observed.canHostClientWorkloads).toBe(false);
    // The labels object should NOT contain host-client-workloads — that
    // absence is what the syncNodesOnce branch checks.
    const labels = observed.labels;
    expect(labels['platform.phoenix-host.net/host-client-workloads']).toBeUndefined();
  });
});

describe('parseMemoryBytes', () => {
  it('parses binary suffixes', () => {
    expect(parseMemoryBytes('16Gi')).toBe(16 * 1024 ** 3);
    expect(parseMemoryBytes('512Mi')).toBe(512 * 1024 ** 2);
  });
  it('parses decimal suffixes', () => {
    expect(parseMemoryBytes('16G')).toBe(16 * 1000 ** 3);
  });
  it('parses plain bytes', () => {
    expect(parseMemoryBytes('1024')).toBe(1024);
  });
  it('returns null for unknown suffix', () => {
    expect(parseMemoryBytes('16Xi')).toBeNull();
  });
  it('returns null for undefined', () => {
    expect(parseMemoryBytes(undefined)).toBeNull();
  });
});
