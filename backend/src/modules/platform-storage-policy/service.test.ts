// Unit test for readClusterState — guards the M14+ contract that the
// `volumes` array includes both StatefulSet PVCs (e.g. stalwart-mail)
// and CNPG-managed PVCs (e.g. postgres-1, postgres-2). The CNPG path
// is enumerated separately via the `cnpg.io/cluster=<name>` label
// selector, so the test asserts that label is what the service asks
// for and that the resulting rows carry kind: 'cnpg' + the same
// desiredReplicas as a StatefulSet row.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { readClusterState } from './service.js';

// Minimal db that returns the M13 singleton policy row from the very
// first .select().from(...).where(...).limit(...) chain. readClusterState
// only ever reads `policy.systemTier`, so a partial row is fine.
function makeDbReturningPolicy(systemTier: 'local' | 'ha'): Database {
  const row = {
    id: 'singleton',
    systemTier,
    pinnedByAdmin: false,
    lastAppliedAt: null,
    lastAppliedBy: null,
    haRecommendationNotifiedAt: null,
    updatedAt: new Date(),
  };
  const limit = vi.fn().mockResolvedValue([row]);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { select } as unknown as Database;
}

interface PvcLite {
  metadata?: { name?: string };
  spec?: { volumeName?: string };
}

interface ListNsPvcArgs {
  namespace: string;
  labelSelector?: string;
}

function makeK8sMock(opts: {
  nodes?: Array<{ name: string; role: 'server' | 'worker'; ready: boolean }>;
  // namespace → PVC list (no label filter)
  pvcsByNs?: Record<string, PvcLite[]>;
  // namespace + labelSelector → PVC list (CNPG path uses this)
  pvcsByLabel?: Record<string, PvcLite[]>;
  // longhorn volumes by name
  lhVolumes?: Record<string, { numberOfReplicas: number; robustness?: string; state?: string } | null>;
  // running replicas list (for the up-front list of running replicas)
  lhReplicas?: Array<{ volumeName: string; nodeID: string }>;
}): K8sClients {
  const nodes = (opts.nodes ?? []).map((n) => ({
    metadata: {
      name: n.name,
      labels: { 'platform.phoenix-host.net/node-role': n.role },
    },
    status: {
      conditions: [{ type: 'Ready', status: n.ready ? 'True' : 'False' }],
    },
    spec: {},
  }));

  const listNamespacedPersistentVolumeClaim = vi.fn(async (args: ListNsPvcArgs) => {
    if (args.labelSelector) {
      const key = `${args.namespace}|${args.labelSelector}`;
      return { items: opts.pvcsByLabel?.[key] ?? [] };
    }
    return { items: opts.pvcsByNs?.[args.namespace] ?? [] };
  });

  const listNamespacedCustomObject = vi.fn(async (args: { plural: string }) => {
    if (args.plural === 'replicas') {
      return {
        items: (opts.lhReplicas ?? []).map((r) => ({
          spec: { volumeName: r.volumeName, nodeID: r.nodeID },
          status: { currentState: 'running' },
        })),
      };
    }
    return { items: [] };
  });

  const getNamespacedCustomObject = vi.fn(async (args: { plural: string; name: string }) => {
    if (args.plural !== 'volumes') return null;
    const v = opts.lhVolumes?.[args.name];
    if (v === undefined) {
      const err = new Error('not found');
      (err as { code?: number }).code = 404;
      throw err;
    }
    if (v === null) return null;
    return {
      metadata: { name: args.name },
      spec: { numberOfReplicas: v.numberOfReplicas },
      status: { robustness: v.robustness, state: v.state },
    };
  });

  return {
    core: { listNode: vi.fn().mockResolvedValue({ items: nodes }), listNamespacedPersistentVolumeClaim },
    custom: { listNamespacedCustomObject, getNamespacedCustomObject },
    apps: {},
    networking: {},
    batch: {},
    rbac: {},
    storage: {},
  } as unknown as K8sClients;
}

describe('readClusterState — CNPG-managed PVC inclusion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns CNPG postgres PVCs alongside the stalwart StatefulSet PVC, with kind=cnpg', async () => {
    const db = makeDbReturningPolicy('ha');
    const k8s = makeK8sMock({
      nodes: [
        { name: 's1', role: 'server', ready: true },
        { name: 's2', role: 'server', ready: true },
        { name: 's3', role: 'server', ready: true },
      ],
      pvcsByNs: {
        mail: [
          { metadata: { name: 'data-stalwart-mail-0' }, spec: { volumeName: 'pvc-stalwart-1' } },
        ],
      },
      pvcsByLabel: {
        'platform|cnpg.io/cluster=system-db': [
          { metadata: { name: 'system-db-1' }, spec: { volumeName: 'pvc-pg-1' } },
          { metadata: { name: 'system-db-2' }, spec: { volumeName: 'pvc-pg-2' } },
        ],
      },
      lhVolumes: {
        'pvc-stalwart-1': { numberOfReplicas: 3, robustness: 'healthy', state: 'attached' },
        'pvc-pg-1': { numberOfReplicas: 1, robustness: 'healthy', state: 'attached' },
        'pvc-pg-2': { numberOfReplicas: 1, robustness: 'degraded', state: 'attached' },
      },
      lhReplicas: [
        { volumeName: 'pvc-pg-1', nodeID: 's1' },
        { volumeName: 'pvc-pg-2', nodeID: 's2' },
      ],
    });

    const state = await readClusterState(k8s, db);

    // Stalwart row still present
    const stalwart = state.volumes.find((v) => v.pvcName === 'data-stalwart-mail-0');
    expect(stalwart).toBeDefined();
    expect(stalwart?.kind).toBe('statefulset');

    // Both CNPG PVCs surfaced as cnpg rows
    const pg1 = state.volumes.find((v) => v.pvcName === 'system-db-1');
    const pg2 = state.volumes.find((v) => v.pvcName === 'system-db-2');
    expect(pg1).toBeDefined();
    expect(pg2).toBeDefined();
    expect(pg1?.kind).toBe('cnpg');
    expect(pg2?.kind).toBe('cnpg');
    expect(pg1?.namespace).toBe('platform');
    expect(pg1?.volumeName).toBe('pvc-pg-1');

    // CNPG-managed PVCs always desiredReplicas=1 INDEPENDENTLY of
    // the system tier — CNPG streaming replication is the HA layer
    // (4 servers = 4 postgres instances, not 4 Longhorn replicas of
    // each instance's PVC). StatefulSet PVCs (Stalwart) still scale
    // with readyServerCount because Stalwart is a single pod whose
    // HA comes from Longhorn replicas.
    expect(pg1?.desiredReplicas).toBe(1); // CNPG: always 1 regardless of tier
    expect(stalwart?.desiredReplicas).toBe(3); // StatefulSet HA: 3 in this test (3 servers, ha tier)

    // Longhorn-observed numbers carried through verbatim.
    expect(pg1?.currentReplicas).toBe(1);
    expect(pg1?.healthy).toBe(true);
    expect(pg2?.healthy).toBe(false); // degraded robustness
    expect(pg1?.replicaNodes).toEqual(['s1']);

    // Service queried with the CNPG label selector.
    const calls = (k8s.core.listNamespacedPersistentVolumeClaim as ReturnType<typeof vi.fn>).mock.calls;
    const labelCall = calls.find((c) => c[0]?.labelSelector === 'cnpg.io/cluster=system-db');
    expect(labelCall).toBeDefined();
    expect(labelCall?.[0].namespace).toBe('platform');
  });

  it('emits CNPG rows even when no StatefulSet PVCs exist', async () => {
    const db = makeDbReturningPolicy('local');
    const k8s = makeK8sMock({
      nodes: [{ name: 's1', role: 'server', ready: true }],
      pvcsByNs: { mail: [] },
      pvcsByLabel: {
        'platform|cnpg.io/cluster=system-db': [
          { metadata: { name: 'system-db-1' }, spec: { volumeName: 'pvc-pg-1' } },
        ],
      },
      lhVolumes: {
        'pvc-pg-1': { numberOfReplicas: 1, robustness: 'healthy', state: 'attached' },
      },
    });

    const state = await readClusterState(k8s, db);
    expect(state.volumes).toHaveLength(1);
    expect(state.volumes[0].pvcName).toBe('system-db-1');
    expect(state.volumes[0].kind).toBe('cnpg');
    expect(state.volumes[0].desiredReplicas).toBe(1); // local tier
  });

  it('totalNodeCount counts only server-tagged nodes — workers are excluded', async () => {
    // 3 servers (2 ready, 1 not ready) + 2 workers (both ready). The "X of Y
    // server nodes" denominator should be 3, NOT 5; workers don't host the
    // platform-storage replicas so they shouldn't dilute the ratio.
    const db = makeDbReturningPolicy('local');
    const k8s = makeK8sMock({
      nodes: [
        { name: 's1', role: 'server', ready: true },
        { name: 's2', role: 'server', ready: true },
        { name: 's3', role: 'server', ready: false },
        { name: 'w1', role: 'worker', ready: true },
        { name: 'w2', role: 'worker', ready: true },
      ],
      pvcsByNs: { mail: [] },
    });

    const state = await readClusterState(k8s, db);
    expect(state.readyServerCount).toBe(2);
    expect(state.totalNodeCount).toBe(3);
  });

  it('handles CNPG PVC list failure without throwing (degrades gracefully)', async () => {
    const db = makeDbReturningPolicy('local');
    const k8s = makeK8sMock({
      nodes: [{ name: 's1', role: 'server', ready: true }],
      pvcsByNs: { mail: [] },
      // pvcsByLabel intentionally empty so the lookup returns []
    });
    // Force the CNPG-namespace pvc call to throw
    (k8s.core.listNamespacedPersistentVolumeClaim as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      // first call is for the StatefulSet (mail ns) — let it return empty
      return { items: [] };
    }).mockImplementationOnce(async () => {
      throw new Error('boom');
    });

    const state = await readClusterState(k8s, db);
    expect(state.volumes).toEqual([]);
  });
});

describe('replicasForSystemTier — HA scales to readyServerCount, capped at MAX_HA_REPLICAS', () => {
  it('local tier always returns 1 regardless of server count', async () => {
    const { replicasForSystemTier } = await import('./service.js');
    expect(replicasForSystemTier('local', 1)).toBe(1);
    expect(replicasForSystemTier('local', 3)).toBe(1);
    expect(replicasForSystemTier('local', 7)).toBe(1);
  });

  it('HA tier scales to readyServerCount when between min(2) and max(5)', async () => {
    const { replicasForSystemTier } = await import('./service.js');
    expect(replicasForSystemTier('ha', 2)).toBe(2);
    expect(replicasForSystemTier('ha', 3)).toBe(3);
    expect(replicasForSystemTier('ha', 4)).toBe(4); // ← THIS IS THE NEW BEHAVIOR
    expect(replicasForSystemTier('ha', 5)).toBe(5);
  });

  it('HA tier caps at MAX_HA_REPLICAS=5 to bound write amplification', async () => {
    const { replicasForSystemTier } = await import('./service.js');
    expect(replicasForSystemTier('ha', 6)).toBe(5);
    expect(replicasForSystemTier('ha', 10)).toBe(5);
  });

  it('HA tier never goes below 2 (1 = local; HA implies multi-replica)', async () => {
    const { replicasForSystemTier } = await import('./service.js');
    expect(replicasForSystemTier('ha', 0)).toBe(2);
    expect(replicasForSystemTier('ha', 1)).toBe(2);
  });

  it('cnpgInstancesForSystemTier + deploymentReplicasForSystemTier follow same shape', async () => {
    const { cnpgInstancesForSystemTier, deploymentReplicasForSystemTier } = await import('./service.js');
    expect(cnpgInstancesForSystemTier('local', 4)).toBe(1);
    expect(cnpgInstancesForSystemTier('ha', 4)).toBe(4);
    expect(cnpgInstancesForSystemTier('ha', 7)).toBe(5);
    expect(deploymentReplicasForSystemTier('local', 4)).toBe(1);
    expect(deploymentReplicasForSystemTier('ha', 4)).toBe(4);
    expect(deploymentReplicasForSystemTier('ha', 7)).toBe(5);
  });
});
