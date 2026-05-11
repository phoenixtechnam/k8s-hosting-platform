/**
 * Unit tests for the pure compute side of failover headroom.
 * The K8s I/O wrapper is intentionally untested here — its only job
 * is fan-out + delegation to computeFailoverHeadroom.
 */
import { describe, it, expect } from 'vitest';
import { computeFailoverHeadroom } from './failover-headroom.js';

function node(opts: {
  name: string;
  role?: 'server' | 'worker';
  controlPlaneTaint?: boolean;
  cpu?: string;
  memory?: string;
  ready?: boolean;
}) {
  return {
    metadata: {
      name: opts.name,
      labels: opts.role
        ? { 'platform.phoenix-host.net/node-role': opts.role }
        : {},
    },
    status: {
      allocatable: {
        cpu: opts.cpu ?? '4',
        memory: opts.memory ?? '8Gi',
      },
      conditions: [{ type: 'Ready', status: opts.ready === false ? 'False' : 'True' }],
    },
    spec: opts.controlPlaneTaint
      ? { taints: [{ key: 'node-role.kubernetes.io/control-plane' }] }
      : {},
  };
}

function pod(opts: {
  namespace: string;
  cpu?: string;
  memory?: string;
  phase?: string;
}) {
  return {
    metadata: { namespace: opts.namespace },
    spec: {
      containers: [
        {
          resources: {
            requests: {
              ...(opts.cpu ? { cpu: opts.cpu } : {}),
              ...(opts.memory ? { memory: opts.memory } : {}),
            },
          },
        },
      ],
    },
    status: { phase: opts.phase ?? 'Running' },
  };
}

describe('computeFailoverHeadroom — homogeneous 3-server HA cluster', () => {
  it('reserves 1 server\'s worth + system baseline; reports correct tenant availability', () => {
    // 3 identical servers: 4 cores, 8 GiB each. Total: 12 cores, 24 GiB.
    const nodes = [
      node({ name: 'server1', role: 'server', cpu: '4', memory: '8Gi' }),
      node({ name: 'server2', role: 'server', cpu: '4', memory: '8Gi' }),
      node({ name: 'server3', role: 'server', cpu: '4', memory: '8Gi' }),
    ];

    // 1 core + 2 GiB of system pods.
    const pods = [
      pod({ namespace: 'kube-system', cpu: '500m', memory: '1Gi' }),
      pod({ namespace: 'platform', cpu: '500m', memory: '1Gi' }),
    ];

    const h = computeFailoverHeadroom(nodes, pods);

    expect(h.servers.map((s) => s.name)).toEqual(['server1', 'server2', 'server3']);
    expect(h.totalCpu).toBe(12);
    expect(h.totalMemoryGi).toBe(24);
    expect(h.systemReservedCpu).toBe(1);
    expect(h.systemReservedMemoryGi).toBe(2);
    expect(h.failoverReservedCpu).toBe(4);
    expect(h.failoverReservedMemoryGi).toBe(8);
    // 12 - 1 - 4 = 7 cores; 24 - 2 - 8 = 14 GiB
    expect(h.tenantAvailableCpu).toBe(7);
    expect(h.tenantAvailableMemoryGi).toBe(14);
    expect(h.tenantUsedCpu).toBe(0);
    expect(h.tenantUsedMemoryGi).toBe(0);
    expect(h.singleFailureSurvivable).toBe(true);
    expect(h.headroomClamped).toBe(false);
  });
});

describe('computeFailoverHeadroom — heterogeneous cluster reserves the LARGEST server', () => {
  it('picks the beefy server as the failover reserve (conservative)', () => {
    const nodes = [
      node({ name: 'small1', role: 'server', cpu: '2', memory: '4Gi' }),
      node({ name: 'small2', role: 'server', cpu: '2', memory: '4Gi' }),
      node({ name: 'beefy',  role: 'server', cpu: '8', memory: '16Gi' }),
    ];
    const h = computeFailoverHeadroom(nodes, []);
    expect(h.totalCpu).toBe(12);
    expect(h.totalMemoryGi).toBe(24);
    // The largest server is reserved (8 cores / 16 GiB) — that's the
    // worst-case single-server loss this homogeneous-survivors cluster
    // would have to absorb.
    expect(h.failoverReservedCpu).toBe(8);
    expect(h.failoverReservedMemoryGi).toBe(16);
    expect(h.tenantAvailableCpu).toBe(4);
    expect(h.tenantAvailableMemoryGi).toBe(8);
  });
});

describe('computeFailoverHeadroom — server-node selection', () => {
  it('includes control-plane-tainted nodes even without the role label (legacy fallback)', () => {
    const nodes = [
      // No label, but has control-plane taint — counts as server.
      node({ name: 'legacy-master', controlPlaneTaint: true, cpu: '4', memory: '8Gi' }),
      node({ name: 'server2', role: 'server', cpu: '4', memory: '8Gi' }),
    ];
    const h = computeFailoverHeadroom(nodes, []);
    expect(h.servers.map((s) => s.name).sort()).toEqual(['legacy-master', 'server2']);
  });

  it('excludes worker nodes from server count + totals', () => {
    const nodes = [
      node({ name: 'server1', role: 'server', cpu: '4', memory: '8Gi' }),
      node({ name: 'worker1', role: 'worker', cpu: '8', memory: '16Gi' }), // ignored
    ];
    const h = computeFailoverHeadroom(nodes, []);
    expect(h.servers).toHaveLength(1);
    expect(h.totalCpu).toBe(4);
    expect(h.totalMemoryGi).toBe(8);
  });

  it('excludes NotReady server nodes', () => {
    const nodes = [
      node({ name: 'server1', role: 'server', cpu: '4', memory: '8Gi' }),
      node({ name: 'server2', role: 'server', cpu: '4', memory: '8Gi', ready: false }),
    ];
    const h = computeFailoverHeadroom(nodes, []);
    expect(h.servers).toHaveLength(1);
    expect(h.servers[0].name).toBe('server1');
  });
});

describe('computeFailoverHeadroom — tenant accounting + survivability flag', () => {
  it('sums tenant requests across client-* namespaces only', () => {
    const nodes = [
      node({ name: 'server1', role: 'server', cpu: '4', memory: '8Gi' }),
      node({ name: 'server2', role: 'server', cpu: '4', memory: '8Gi' }),
      node({ name: 'server3', role: 'server', cpu: '4', memory: '8Gi' }),
    ];
    const pods = [
      pod({ namespace: 'client-acme-co-1234', cpu: '500m', memory: '512Mi' }),
      pod({ namespace: 'client-other-5678', cpu: '500m', memory: '512Mi' }),
      pod({ namespace: 'kube-system', cpu: '100m', memory: '128Mi' }),
      pod({ namespace: 'unrelated-ns', cpu: '999', memory: '999Gi' }), // ignored
    ];
    const h = computeFailoverHeadroom(nodes, pods);
    expect(h.tenantUsedCpu).toBe(1); // two 500m
    expect(h.tenantUsedMemoryGi).toBeCloseTo(1, 6); // two 512Mi = 1Gi
  });

  it('flags singleFailureSurvivable=false when tenant usage exceeds the headroom', () => {
    const nodes = [
      node({ name: 'server1', role: 'server', cpu: '4', memory: '8Gi' }),
      node({ name: 'server2', role: 'server', cpu: '4', memory: '8Gi' }),
      node({ name: 'server3', role: 'server', cpu: '4', memory: '8Gi' }),
    ];
    // tenantAvailable = 12 - 0 - 4 = 8 cores. Pack tenants to 10.
    const pods = [
      pod({ namespace: 'client-greedy', cpu: '10', memory: '1Gi' }),
    ];
    const h = computeFailoverHeadroom(nodes, pods);
    expect(h.tenantUsedCpu).toBe(10);
    expect(h.tenantAvailableCpu).toBe(8);
    expect(h.singleFailureSurvivable).toBe(false);
  });

  it('flags singleFailureSurvivable=true when tenant usage fits in the headroom', () => {
    const nodes = [
      node({ name: 'server1', role: 'server', cpu: '4', memory: '8Gi' }),
      node({ name: 'server2', role: 'server', cpu: '4', memory: '8Gi' }),
      node({ name: 'server3', role: 'server', cpu: '4', memory: '8Gi' }),
    ];
    const pods = [
      pod({ namespace: 'client-modest', cpu: '2', memory: '4Gi' }),
    ];
    const h = computeFailoverHeadroom(nodes, pods);
    expect(h.singleFailureSurvivable).toBe(true);
    expect(h.headroomClamped).toBe(false);
  });

  it('flags singleFailureSurvivable=false when only one dimension overflows (AND-logic correctness)', () => {
    const nodes = [
      node({ name: 'server1', role: 'server', cpu: '4', memory: '8Gi' }),
      node({ name: 'server2', role: 'server', cpu: '4', memory: '8Gi' }),
      node({ name: 'server3', role: 'server', cpu: '4', memory: '8Gi' }),
    ];
    // 12 total cores - 0 system - 4 failover = 8 cores headroom.
    // 24 total GiB - 0 system - 8 failover = 16 GiB headroom.
    // 6 cores (fits) + 100 GiB (does NOT fit) → survivable must be false.
    const pods = [
      pod({ namespace: 'client-cpu-light', cpu: '6', memory: '100Gi' }),
    ];
    const h = computeFailoverHeadroom(nodes, pods);
    expect(h.tenantAvailableCpu).toBe(8);
    expect(h.tenantUsedCpu).toBe(6);
    expect(h.tenantUsedMemoryGi).toBe(100);
    expect(h.tenantAvailableMemoryGi).toBe(16);
    expect(h.singleFailureSurvivable).toBe(false);
  });

  it('ignores Succeeded/Failed pods (their requests don\'t pin capacity)', () => {
    const nodes = [
      node({ name: 'server1', role: 'server', cpu: '4', memory: '8Gi' }),
    ];
    const pods = [
      pod({ namespace: 'kube-system', cpu: '500m', memory: '1Gi', phase: 'Succeeded' }),
      pod({ namespace: 'platform', cpu: '500m', memory: '1Gi', phase: 'Failed' }),
      pod({ namespace: 'platform', cpu: '500m', memory: '1Gi', phase: 'Running' }),
    ];
    const h = computeFailoverHeadroom(nodes, pods);
    // Only the Running pod counts toward systemReserved.
    expect(h.systemReservedCpu).toBe(0.5);
    expect(h.systemReservedMemoryGi).toBeCloseTo(1, 6);
  });
});

describe('computeFailoverHeadroom — degenerate clamps + headroomClamped flag', () => {
  it('clamps tenantAvailable to >=0 when baseline+failover exceeds total (boot transient)', () => {
    const nodes = [
      node({ name: 'tiny', role: 'server', cpu: '1', memory: '1Gi' }),
    ];
    const pods = [
      pod({ namespace: 'kube-system', cpu: '999', memory: '999Gi' }),
    ];
    const h = computeFailoverHeadroom(nodes, pods);
    expect(h.tenantAvailableCpu).toBe(0);
    expect(h.tenantAvailableMemoryGi).toBe(0);
    // 2026-05-11 review fix: when headroom was clamped, we must NOT
    // claim survivability — silently green-flagging an over-committed
    // cluster was the original bug.
    expect(h.headroomClamped).toBe(true);
    expect(h.singleFailureSurvivable).toBe(false);
  });

  it('single-server (non-HA) cluster correctly reports clamped + not survivable', () => {
    // The normal steady state on dev/local: 1 server, so failoverReserved
    // == totalCpu == one_server. tenantAvailable clamps to exactly 0.
    // Even with zero tenant load the answer is "no single-failure
    // survivability possible" — losing the only server kills everything.
    const nodes = [
      node({ name: 'solo', role: 'server', cpu: '4', memory: '8Gi' }),
    ];
    const h = computeFailoverHeadroom(nodes, []);
    expect(h.servers).toHaveLength(1);
    expect(h.failoverReservedCpu).toBe(4); // == totalCpu
    expect(h.tenantAvailableCpu).toBe(0);
    expect(h.tenantAvailableMemoryGi).toBe(0);
    expect(h.headroomClamped).toBe(true);
    expect(h.singleFailureSurvivable).toBe(false);
  });

  it('handles empty cluster (no nodes) without throwing', () => {
    const h = computeFailoverHeadroom([], []);
    expect(h.servers).toEqual([]);
    expect(h.totalCpu).toBe(0);
    expect(h.totalMemoryGi).toBe(0);
    expect(h.failoverReservedCpu).toBe(0);
    // raw = 0 - 0 - 0 = 0; the predicate uses <= 0 so a zero-node
    // cluster is also `clamped` and not survivable. Consistent with
    // "you have no servers, you have no failover capacity".
    expect(h.headroomClamped).toBe(true);
    expect(h.singleFailureSurvivable).toBe(false);
  });
});
