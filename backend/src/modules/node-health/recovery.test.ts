import { describe, expect, it, vi } from 'vitest';
import {
  cleanStalePodsOnNode,
  recyclePod,
  restartCsiPluginOnNode,
} from './recovery.js';
import { ApiError } from '../../shared/errors.js';

interface MockK8sOpts {
  readonly readPodResult?: unknown;
  readonly readPodStatus?: number;
  readonly listPodsItems?: ReadonlyArray<unknown>;
  readonly listNamespacedPodItems?: ReadonlyArray<unknown>;
}

function makeFakeDb() {
  const inserted: Array<Record<string, unknown>> = [];
  return {
    inserted,
    db: {
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          inserted.push(v);
          return { catch: (_fn: unknown) => undefined };
        },
      }),
    } as unknown as Parameters<typeof recyclePod>[0]['db'],
  };
}

function makeFakeK8s(opts: MockK8sOpts = {}) {
  const deletes: Array<{ namespace: string; name: string }> = [];
  const k8s = {
    core: {
      readNamespacedPod: vi.fn(async (args: { namespace: string; name: string }) => {
        if (opts.readPodStatus) {
          const e = new Error('mock') as Error & { statusCode?: number };
          e.statusCode = opts.readPodStatus;
          throw e;
        }
        return opts.readPodResult ?? {
          metadata: { name: args.name, namespace: args.namespace },
          spec: { nodeName: 'worker' },
        };
      }),
      deleteNamespacedPod: vi.fn(async (args: { namespace: string; name: string }) => {
        deletes.push({ namespace: args.namespace, name: args.name });
      }),
      listPodForAllNamespaces: vi.fn(async () => ({ items: opts.listPodsItems ?? [] })),
      listNamespacedPod: vi.fn(async () => ({ items: opts.listNamespacedPodItems ?? [] })),
    },
  } as unknown as Parameters<typeof recyclePod>[0]['k8s'];
  return { k8s, deletes };
}

describe('recyclePod', () => {
  it('refuses tenant namespaces', async () => {
    const { k8s } = makeFakeK8s();
    const { db } = makeFakeDb();
    await expect(recyclePod({
      k8s, db, actorUserId: 'u1',
      node: 'worker', namespace: 'client-acme-12345678', podName: 'web',
      reason: 'test',
    })).rejects.toBeInstanceOf(ApiError);
  });

  it('refuses non-allow-listed namespaces', async () => {
    const { k8s } = makeFakeK8s();
    const { db } = makeFakeDb();
    await expect(recyclePod({
      k8s, db, actorUserId: 'u1',
      node: 'worker', namespace: 'random-ns', podName: 'pod',
      reason: 'test',
    })).rejects.toBeInstanceOf(ApiError);
  });

  it('refuses CNPG instance pods (label cnpg.io/instance)', async () => {
    const { k8s } = makeFakeK8s({
      readPodResult: {
        metadata: { name: 'system-db-1', namespace: 'platform', labels: { 'cnpg.io/instance': 'system-db-1' } },
        spec: { nodeName: 'staging1' },
      },
    });
    const { db } = makeFakeDb();
    // platform isn't on the allow-list anyway; force a system ns to
    // exercise the cnpg-instance guard specifically.
    const { k8s: k8s2 } = makeFakeK8s({
      readPodResult: {
        metadata: { name: 'system-db-1', namespace: 'cnpg-system', labels: { 'cnpg.io/instance': 'system-db-1' } },
        spec: { nodeName: 'staging1' },
      },
    });
    await expect(recyclePod({
      k8s: k8s2, db, actorUserId: 'u1',
      node: 'staging1', namespace: 'cnpg-system', podName: 'system-db-1',
      reason: 'test',
    })).rejects.toMatchObject({ code: 'RECOVERY_REFUSED_CNPG_INSTANCE' });
  });

  it('refuses when pod is on a different node (typo guard)', async () => {
    const { k8s } = makeFakeK8s({
      readPodResult: {
        metadata: { name: 'calico-node-abc', namespace: 'calico-system' },
        spec: { nodeName: 'staging1' },
      },
    });
    const { db } = makeFakeDb();
    await expect(recyclePod({
      k8s, db, actorUserId: 'u1',
      node: 'worker', namespace: 'calico-system', podName: 'calico-node-abc',
      reason: 'test',
    })).rejects.toMatchObject({ code: 'RECOVERY_NODE_MISMATCH' });
  });

  it('happy path: deletes pod + records audit', async () => {
    const { k8s, deletes } = makeFakeK8s({
      readPodResult: {
        metadata: { name: 'calico-node-abc', namespace: 'calico-system' },
        spec: { nodeName: 'worker' },
      },
    });
    const { db, inserted } = makeFakeDb();
    const result = await recyclePod({
      k8s, db, actorUserId: 'admin1',
      node: 'worker', namespace: 'calico-system', podName: 'calico-node-abc',
      reason: 'DiskPressure recovery',
    });
    expect(result.recovered).toBe(1);
    expect(deletes).toEqual([{ namespace: 'calico-system', name: 'calico-node-abc' }]);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      actionType: 'node_health.recycle_pod',
      resourceType: 'node_health_recovery',
      resourceId: 'worker',
      actorId: 'admin1',
    });
    expect(inserted[0].changes).toMatchObject({
      reason: 'DiskPressure recovery',
      namespace: 'calico-system',
      podName: 'calico-node-abc',
    });
  });

  it('idempotent: 404 from readPod → recovered=0 (no error)', async () => {
    const { k8s, deletes } = makeFakeK8s({ readPodStatus: 404 });
    const { db, inserted } = makeFakeDb();
    const result = await recyclePod({
      k8s, db, actorUserId: 'admin1',
      node: 'worker', namespace: 'calico-system', podName: 'gone-already',
      reason: 'test',
    });
    expect(result.recovered).toBe(0);
    expect(deletes).toEqual([]);
    expect(inserted[0].actionType).toBe('node_health.recycle_pod.noop');
  });
});

describe('cleanStalePodsOnNode', () => {
  it('deletes Failed/Evicted/Unknown-state pods on the target node, refuses CNPG instances', async () => {
    const { k8s, deletes } = makeFakeK8s({
      listPodsItems: [
        // candidate: Evicted in calico-system
        { metadata: { name: 'evicted-1', namespace: 'calico-system' }, spec: { nodeName: 'worker' }, status: { phase: 'Failed', reason: 'Evicted' } },
        // candidate: ContainerStatusUnknown in longhorn-system
        { metadata: { name: 'unk-1', namespace: 'longhorn-system' }, spec: { nodeName: 'worker' }, status: { containerStatuses: [{ state: { unknown: {} } }] } },
        // refuse: CNPG instance even though Failed
        { metadata: { name: 'pg-1', namespace: 'cnpg-system', labels: { 'cnpg.io/instance': 'system-db-1' } }, spec: { nodeName: 'worker' }, status: { phase: 'Failed' } },
        // refuse: tenant namespace
        { metadata: { name: 'wp-evicted', namespace: 'client-acme-aabbccdd' }, spec: { nodeName: 'worker' }, status: { phase: 'Failed', reason: 'Evicted' } },
        // skip: healthy pod (Running)
        { metadata: { name: 'running-1', namespace: 'kube-system' }, spec: { nodeName: 'worker' }, status: { phase: 'Running' } },
      ],
    });
    const { db, inserted } = makeFakeDb();
    const result = await cleanStalePodsOnNode({
      k8s, db, actorUserId: 'u1', node: 'worker', reason: 'cleanup',
    });
    expect(result.recovered).toBe(2);
    expect(deletes.map((d) => d.name).sort()).toEqual(['evicted-1', 'unk-1']);
    expect(inserted[0].actionType).toBe('node_health.clean_stale_pods');
  });

  it('returns recovered=0 + empty deleted when no stale pods', async () => {
    const { k8s, deletes } = makeFakeK8s({ listPodsItems: [] });
    const { db } = makeFakeDb();
    const result = await cleanStalePodsOnNode({
      k8s, db, actorUserId: 'u1', node: 'worker', reason: 'idle',
    });
    expect(result.recovered).toBe(0);
    expect(deletes).toEqual([]);
  });
});

describe('restartCsiPluginOnNode', () => {
  it('deletes the longhorn-csi-plugin pod on the target node', async () => {
    const { k8s, deletes } = makeFakeK8s({
      listNamespacedPodItems: [
        { metadata: { name: 'longhorn-csi-plugin-staging1', namespace: 'longhorn-system' }, spec: { nodeName: 'staging1' } },
        { metadata: { name: 'longhorn-csi-plugin-worker',   namespace: 'longhorn-system' }, spec: { nodeName: 'worker' } },
      ],
    });
    const { db, inserted } = makeFakeDb();
    const result = await restartCsiPluginOnNode({
      k8s, db, actorUserId: 'u1', node: 'worker', reason: 'CSI re-register',
    });
    expect(result.recovered).toBe(1);
    expect(result.podName).toBe('longhorn-csi-plugin-worker');
    expect(deletes).toEqual([{ namespace: 'longhorn-system', name: 'longhorn-csi-plugin-worker' }]);
    expect(inserted[0].actionType).toBe('node_health.restart_csi');
  });

  it('idempotent: no plugin on node → recovered=0', async () => {
    const { k8s, deletes } = makeFakeK8s({ listNamespacedPodItems: [] });
    const { db, inserted } = makeFakeDb();
    const result = await restartCsiPluginOnNode({
      k8s, db, actorUserId: 'u1', node: 'worker', reason: 'idle',
    });
    expect(result.recovered).toBe(0);
    expect(result.podName).toBeNull();
    expect(deletes).toEqual([]);
    expect(inserted[0].actionType).toBe('node_health.restart_csi.noop');
  });
});
