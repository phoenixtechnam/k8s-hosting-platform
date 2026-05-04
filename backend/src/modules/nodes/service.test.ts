import { describe, it, expect, vi } from 'vitest';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { buildDrainImpact } from './service.js';

// Schema mock so the dynamic import inside service.ts doesn't blow up.
vi.mock('../../db/schema.js', () => ({
  clients: {
    id: 'clients.id',
    companyName: 'clients.companyName',
    kubernetesNamespace: 'clients.kubernetesNamespace',
    storageTier: 'clients.storageTier',
    workerNodeName: 'clients.workerNodeName',
  },
}));

interface MockClientRow {
  id: string;
  name: string;
  ns: string | null;
  tier?: 'local' | 'ha';
  pin?: string | null;
}
function makeMockDb(clientRows: MockClientRow[]): Database {
  return {
    select: () => ({
      from: () => Promise.resolve(
        clientRows.map((r) => ({
          id: r.id,
          name: r.name,
          ns: r.ns,
          tier: r.tier ?? 'local',
          pin: r.pin ?? null,
        })),
      ),
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

    // Pinning is exposed as a per-client aggregate now — the modal
    // shows clients (not workloads) and re-pins one client at a time.
    expect(impact.pinnedClients).toHaveLength(1);
    expect(impact.pinnedClients[0]).toMatchObject({
      clientId: 'client-foo-id',
      clientName: 'Foo Co',
      namespace: 'client-foo',
    });
    expect(impact.pinnedClients[0].workloads).toHaveLength(1);
    expect(impact.pinnedClients[0].workloads[0]).toMatchObject({
      kind: 'Deployment',
      name: 'nginx-php',
      pinKind: 'nodeSelector',
      replicas: 0,
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
    expect(impact.pinnedClients).toHaveLength(1);
    expect(impact.pinnedClients[0].workloads).toHaveLength(1);
    expect(impact.pinnedClients[0].workloads[0].pinKind).toBe('nodeAffinity');
    expect(impact.pinnedClients[0].workloads[0].kind).toBe('StatefulSet');
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
    expect(impact.pinnedClients).toHaveLength(1);
    expect(impact.pinnedClients[0]).toMatchObject({
      clientId: 'client-foo-id',
      clientName: 'Foo Co',
      namespace: 'client-foo',
    });
    expect(impact.pinnedClients[0].pvcs).toHaveLength(1);
    expect(impact.pinnedClients[0].pvcs[0]).toMatchObject({
      pvcName: 'data',
      volumeName: 'pvc-foo',
      replicaCount: 1,
      isLastReplica: true,
    });
  });

  it('classifies pods in cluster-infra namespaces (calico, kube-system) as system', async () => {
    // Repro: Calico's calico-kube-controllers (Deployment-backed pod in
    // calico-system) was previously surfaced as a tenant pod because
    // the namespace wasn't in SYSTEM_NAMESPACES. Same hazard for kube-system,
    // tigera-operator, cnpg-system, monitoring.
    const k8s = makeK8s({
      pods: [
        {
          metadata: { namespace: 'calico-system', name: 'calico-kube-controllers-abcde', ownerReferences: [{ kind: 'ReplicaSet', name: 'calico-kube-controllers' }] },
          spec: { nodeName: 'worker' },
          status: { phase: 'Running' },
        },
        {
          metadata: { namespace: 'tigera-operator', name: 'tigera-operator-xyz', ownerReferences: [{ kind: 'ReplicaSet', name: 'tigera-operator' }] },
          spec: { nodeName: 'worker' },
          status: { phase: 'Running' },
        },
        {
          metadata: { namespace: 'kube-system', name: 'coredns-1', ownerReferences: [{ kind: 'ReplicaSet', name: 'coredns' }] },
          spec: { nodeName: 'worker' },
          status: { phase: 'Running' },
        },
        {
          metadata: { namespace: 'cnpg-system', name: 'cnpg-controller-1', ownerReferences: [{ kind: 'ReplicaSet', name: 'cnpg-controller-manager' }] },
          spec: { nodeName: 'worker' },
          status: { phase: 'Running' },
        },
      ],
    });
    const db = makeMockDb([]);

    const impact = await buildDrainImpact(k8s, db, 'worker');

    expect(impact.nonSystemPods).toHaveLength(0);
    const sysNs = impact.systemPods.map((p) => p.namespace).sort();
    expect(sysNs).toEqual(['calico-system', 'cnpg-system', 'kube-system', 'tigera-operator']);
  });

  it('enriches longhornReplicas with PVC + owner attribution (client + platform-system)', async () => {
    // Two replicas live on `worker`: one tenant volume (Acme/data) and one
    // platform volume (postgres-1 in cnpg-system). Both should land in
    // longhornReplicas with ownerLabel populated; the tenant replica also
    // resolves clientId/clientName.
    const k8s = makeK8s({
      longhornVolumes: [
        {
          metadata: { name: 'pvc-acme-data' },
          status: { kubernetesStatus: { pvcName: 'data', namespace: 'client-acme' } },
        },
        {
          metadata: { name: 'pvc-postgres-1' },
          status: { kubernetesStatus: { pvcName: 'postgres-1', namespace: 'platform' } },
        },
      ],
      longhornReplicas: [
        { metadata: { name: 'r-acme-data-1' }, spec: { volumeName: 'pvc-acme-data', nodeID: 'worker' }, status: { currentState: 'running' } },
        { metadata: { name: 'r-postgres-1-w' }, spec: { volumeName: 'pvc-postgres-1', nodeID: 'worker' }, status: { currentState: 'running' } },
      ],
    });
    const db = makeMockDb([{ id: 'acme-id', name: 'Acme Co', ns: 'client-acme' }]);

    const impact = await buildDrainImpact(k8s, db, 'worker');

    expect(impact.longhornReplicas).toHaveLength(2);
    const acme = impact.longhornReplicas.find((r) => r.volumeName === 'pvc-acme-data');
    expect(acme).toMatchObject({
      pvcName: 'data',
      namespace: 'client-acme',
      clientId: 'acme-id',
      clientName: 'Acme Co',
      ownerLabel: 'Acme Co',
      isLastReplica: true,
    });
    const pg = impact.longhornReplicas.find((r) => r.volumeName === 'pvc-postgres-1');
    expect(pg).toMatchObject({
      pvcName: 'postgres-1',
      namespace: 'platform',
      clientId: null,
      clientName: null,
      ownerLabel: 'Platform System (platform)',
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
    // No pinned tenant clients on the node — system-namespace
    // workloads are filtered out before aggregation.
    expect(impact.pinnedClients).toHaveLength(0);
  });
});
