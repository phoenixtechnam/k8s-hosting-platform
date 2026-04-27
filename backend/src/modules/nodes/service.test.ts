import { describe, it, expect, vi } from 'vitest';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { buildDrainImpact } from './service.js';

// Schema mock so the dynamic import inside service.ts doesn't blow up.
vi.mock('../../db/schema.js', () => ({
  clients: { id: 'clients.id', companyName: 'clients.companyName', kubernetesNamespace: 'clients.kubernetesNamespace' },
}));

function makeMockDb(clientRows: Array<{ id: string; name: string; ns: string | null }>): Database {
  return {
    select: () => ({
      from: () => Promise.resolve(clientRows),
    }),
  } as unknown as Database;
}

function makeK8s(opts: {
  unschedulable?: boolean;
  pods?: unknown[];
  deployments?: unknown[];
  statefulsets?: unknown[];
  longhornVolumes?: unknown[];
  longhornReplicas?: unknown[];
}): K8sClients {
  return {
    core: {
      readNode: vi.fn().mockResolvedValue({ spec: { unschedulable: opts.unschedulable ?? false } }),
      listPodForAllNamespaces: vi.fn().mockResolvedValue({ items: opts.pods ?? [] }),
    },
    apps: {
      listDeploymentForAllNamespaces: vi.fn().mockResolvedValue({ items: opts.deployments ?? [] }),
      listStatefulSetForAllNamespaces: vi.fn().mockResolvedValue({ items: opts.statefulsets ?? [] }),
    },
    custom: {
      listNamespacedCustomObject: vi.fn().mockImplementation(async (req: { plural: string }) => {
        if (req.plural === 'replicas') return { items: opts.longhornReplicas ?? [] };
        if (req.plural === 'volumes') return { items: opts.longhornVolumes ?? [] };
        return { items: [] };
      }),
    },
  } as unknown as K8sClients;
}

describe('buildDrainImpact', () => {
  it('surfaces a Deployment pinned via nodeSelector even when replicas=0', async () => {
    // Real-world repro: client deployment scaled to 0 (e.g. as a workaround
    // for FM PVC contention) but its template still pins to the worker.
    // The previous version listed pods on the node and missed the Deployment
    // entirely — the operator would see "0 non-system pods" and drain
    // without realising a pinned workload had to be re-targeted.
    const k8s = makeK8s({
      pods: [],
      deployments: [{
        metadata: { name: 'nginx-php', namespace: 'client-foo' },
        spec: {
          replicas: 0,
          template: { spec: { nodeSelector: { 'kubernetes.io/hostname': 'worker' } } },
        },
      }],
    });
    const db = makeMockDb([
      { id: 'client-foo-id', name: 'Foo Co', ns: 'client-foo' },
    ]);

    const impact = await buildDrainImpact(k8s, db, 'worker');

    expect(impact.pinnedWorkloads).toHaveLength(1);
    expect(impact.pinnedWorkloads[0]).toMatchObject({
      namespace: 'client-foo',
      kind: 'Deployment',
      name: 'nginx-php',
      pinKind: 'nodeSelector',
      replicas: 0,
      clientId: 'client-foo-id',
      clientName: 'Foo Co',
    });
  });

  it('attributes pods to clients via namespace lookup when label is missing', async () => {
    const k8s = makeK8s({
      pods: [{
        metadata: {
          namespace: 'client-bar',
          name: 'web-1-abcde',
          ownerReferences: [{ kind: 'ReplicaSet', name: 'web-1' }],
        },
        spec: { nodeName: 'worker' },
        status: { phase: 'Running' },
      }],
    });
    const db = makeMockDb([
      { id: 'client-bar-id', name: 'Bar Co', ns: 'client-bar' },
    ]);

    const impact = await buildDrainImpact(k8s, db, 'worker');

    expect(impact.nonSystemPods).toHaveLength(1);
    expect(impact.nonSystemPods[0]).toMatchObject({
      namespace: 'client-bar',
      name: 'web-1-abcde',
      clientId: 'client-bar-id',
      clientName: 'Bar Co',
      workloadKind: 'ReplicaSet',
      workloadName: 'web-1',
    });
  });

  it('detects nodeAffinity-based pin (not just nodeSelector)', async () => {
    const k8s = makeK8s({
      pods: [],
      statefulsets: [{
        metadata: { name: 'db', namespace: 'client-baz' },
        spec: {
          replicas: 1,
          template: {
            spec: {
              affinity: {
                nodeAffinity: {
                  requiredDuringSchedulingIgnoredDuringExecution: {
                    nodeSelectorTerms: [{
                      matchExpressions: [{
                        key: 'kubernetes.io/hostname',
                        operator: 'In',
                        values: ['worker'],
                      }],
                    }],
                  },
                },
              },
            },
          },
        },
      }],
    });
    const db = makeMockDb([{ id: 'client-baz-id', name: 'Baz Co', ns: 'client-baz' }]);

    const impact = await buildDrainImpact(k8s, db, 'worker');
    expect(impact.pinnedWorkloads).toHaveLength(1);
    expect(impact.pinnedWorkloads[0].pinKind).toBe('nodeAffinity');
    expect(impact.pinnedWorkloads[0].kind).toBe('StatefulSet');
  });

  it('flags tenant PVCs with a replica on the draining node', async () => {
    const k8s = makeK8s({
      pods: [],
      longhornVolumes: [{
        metadata: { name: 'pvc-foo' },
        spec: { size: String(10 * 1024 ** 3), numberOfReplicas: 1, nodeSelector: [] },
        status: { kubernetesStatus: { pvcName: 'data', namespace: 'client-foo' } },
      }],
      longhornReplicas: [{
        spec: { volumeName: 'pvc-foo', nodeID: 'worker' },
        status: { currentState: 'running' },
      }],
    });
    const db = makeMockDb([{ id: 'client-foo-id', name: 'Foo Co', ns: 'client-foo' }]);

    const impact = await buildDrainImpact(k8s, db, 'worker');
    expect(impact.tenantPvcs).toHaveLength(1);
    expect(impact.tenantPvcs[0]).toMatchObject({
      namespace: 'client-foo',
      pvcName: 'data',
      volumeName: 'pvc-foo',
      clientId: 'client-foo-id',
      clientName: 'Foo Co',
      replicaCount: 1,
      isLastReplica: true,
    });
  });

  it('skips system namespaces from pinnedWorkloads enumeration', async () => {
    const k8s = makeK8s({
      deployments: [{
        metadata: { name: 'platform-api', namespace: 'platform' },
        spec: {
          replicas: 1,
          template: { spec: { nodeSelector: { 'kubernetes.io/hostname': 'worker' } } },
        },
      }],
    });
    const db = makeMockDb([]);

    const impact = await buildDrainImpact(k8s, db, 'worker');
    expect(impact.pinnedWorkloads).toHaveLength(0);
  });
});
