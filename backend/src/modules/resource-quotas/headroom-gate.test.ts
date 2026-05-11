/**
 * Unit tests for the tenant-quota cluster-headroom gate.
 * Mocks getClusterFailoverHeadroom and the db.select chain.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vitest hoists vi.mock to the top — must reference functions defined
// later via dynamic import to avoid circular eval.
vi.mock('../platform-storage-policy/failover-headroom.js', () => ({
  getClusterFailoverHeadroom: vi.fn(),
}));

import { getClusterFailoverHeadroom } from '../platform-storage-policy/failover-headroom.js';
import { validateQuotaFitsHeadroom } from './headroom-gate.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

const k8sStub = {} as K8sClients;

function mockHeadroom(opts: {
  cpu: number;
  memoryGi: number;
  clamped?: boolean;
}) {
  vi.mocked(getClusterFailoverHeadroom).mockResolvedValueOnce({
    servers: [],
    totalCpu: 0,
    totalMemoryGi: 0,
    systemReservedCpu: 0,
    systemReservedMemoryGi: 0,
    failoverReservedCpu: 0,
    failoverReservedMemoryGi: 0,
    tenantAvailableCpu: opts.cpu,
    tenantAvailableMemoryGi: opts.memoryGi,
    tenantUsedCpu: 0,
    tenantUsedMemoryGi: 0,
    singleFailureSurvivable: !opts.clamped,
    headroomClamped: opts.clamped ?? false,
  });
}

function makeDb(rows: Array<{ clientId: string; cpuCoresLimit: string | null; memoryGbLimit: number | null }>): Database {
  // Drizzle .select({...}).from(table) returns a thenable in real usage;
  // the gate awaits the result directly. Mock the chain accordingly.
  const from = vi.fn().mockResolvedValue(rows);
  const select = vi.fn().mockReturnValue({ from });
  return { select } as unknown as Database;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('validateQuotaFitsHeadroom — basic accept/reject decisions', () => {
  it('accepts a quota that fits in the headroom (no other tenants)', async () => {
    mockHeadroom({ cpu: 8, memoryGi: 16 });
    const db = makeDb([]);
    const r = await validateQuotaFitsHeadroom(db, k8sStub, {
      clientId: 'c1',
      newCpuLimit: 4,
      newMemoryLimitGi: 8,
    });
    expect(r.allowed).toBe(true);
    expect(r.reason).toBeNull();
    expect(r.details.projectedSumCpu).toBe(4);
    expect(r.details.headroomCpu).toBe(8);
  });

  it('rejects a quota that overshoots CPU headroom', async () => {
    mockHeadroom({ cpu: 8, memoryGi: 16 });
    // One existing tenant at 6 CPU; this client adds 4 → sum 10 > 8.
    const db = makeDb([
      { clientId: 'other', cpuCoresLimit: '6', memoryGbLimit: 4 },
    ]);
    const r = await validateQuotaFitsHeadroom(db, k8sStub, {
      clientId: 'c1',
      newCpuLimit: 4,
      newMemoryLimitGi: 4,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('CPU over by 2');
    expect(r.details.overByCpu).toBe(2);
  });

  it('rejects a quota that overshoots memory headroom even if CPU fits', async () => {
    mockHeadroom({ cpu: 100, memoryGi: 8 });
    const db = makeDb([]);
    const r = await validateQuotaFitsHeadroom(db, k8sStub, {
      clientId: 'c1',
      newCpuLimit: 4,
      newMemoryLimitGi: 16,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('memory over by 8');
    expect(r.details.overByMemoryGi).toBe(8);
  });

  it('rejects when cluster headroom is clamped (structural over-commit), regardless of patch values', async () => {
    mockHeadroom({ cpu: 0, memoryGi: 0, clamped: true });
    const db = makeDb([]);
    const r = await validateQuotaFitsHeadroom(db, k8sStub, {
      clientId: 'c1',
      newCpuLimit: 0.1,
      newMemoryLimitGi: 0.1,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('no failover headroom');
    expect(r.details.headroomClamped).toBe(true);
  });

  it('reason string lists BOTH clamp and overage when both conditions hold (review fix)', async () => {
    // Clamped headroom AND request that would also overshoot — the
    // original implementation only mentioned the clamp; the fix lists
    // every reason so operators see the full picture.
    mockHeadroom({ cpu: 0, memoryGi: 0, clamped: true });
    const db = makeDb([]);
    const r = await validateQuotaFitsHeadroom(db, k8sStub, {
      clientId: 'c1',
      newCpuLimit: 5,
      newMemoryLimitGi: 8,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('no failover headroom');
    expect(r.reason).toContain('CPU over by 5');
    expect(r.reason).toContain('memory over by 8');
  });
});

describe('validateQuotaFitsHeadroom — sum across tenants', () => {
  it('uses the application default (2 CPU, 4 GiB) for any tenant whose limit is NULL', async () => {
    mockHeadroom({ cpu: 8, memoryGi: 16 });
    // Two existing tenants with NULL limits — should each count as 2 CPU + 4 GiB.
    // Plus the patch client adding 5 CPU → projected sum 9 > 8.
    const db = makeDb([
      { clientId: 'a', cpuCoresLimit: null, memoryGbLimit: null },
      { clientId: 'b', cpuCoresLimit: null, memoryGbLimit: null },
    ]);
    const r = await validateQuotaFitsHeadroom(db, k8sStub, {
      clientId: 'c1',
      newCpuLimit: 5,
      newMemoryLimitGi: 4,
    });
    expect(r.details.currentSumCpu).toBe(4); // 2 + 2 from NULL defaults
    expect(r.details.projectedSumCpu).toBe(9); // 4 + 5
    expect(r.allowed).toBe(false);
  });

  it('excludes the patch-target client from the current sum (avoids double counting their old quota)', async () => {
    mockHeadroom({ cpu: 10, memoryGi: 16 });
    // The patch target already has a 6 CPU quota in the DB; the patch
    // raises it to 8. Current sum (excluding self) should be 0; projected
    // sum should be 8 (new), not 6 + 8 = 14.
    const db = makeDb([
      { clientId: 'c1', cpuCoresLimit: '6', memoryGbLimit: 8 },
    ]);
    const r = await validateQuotaFitsHeadroom(db, k8sStub, {
      clientId: 'c1',
      newCpuLimit: 8,
      newMemoryLimitGi: 8,
    });
    expect(r.details.currentSumCpu).toBe(0); // self excluded
    expect(r.details.projectedSumCpu).toBe(8);
    expect(r.allowed).toBe(true);
  });

  it('falls back to existing DB value when the patch leaves a field unset (null)', async () => {
    mockHeadroom({ cpu: 10, memoryGi: 16 });
    // Existing client has 4 CPU / 8 GiB; the patch only raises memory.
    // The gate must keep using 4 for CPU (existing) and combine with 12 GiB (new).
    const db = makeDb([
      { clientId: 'c1', cpuCoresLimit: '4', memoryGbLimit: 8 },
    ]);
    const r = await validateQuotaFitsHeadroom(db, k8sStub, {
      clientId: 'c1',
      newCpuLimit: null,
      newMemoryLimitGi: 12,
    });
    expect(r.details.projectedSumCpu).toBe(4); // existing kept
    expect(r.details.projectedSumMemoryGi).toBe(12); // new memory limit
    expect(r.allowed).toBe(true);
  });
});

describe('validateQuotaFitsHeadroom — boundary cases', () => {
  it('accepts a quota that lands exactly on the headroom limit', async () => {
    mockHeadroom({ cpu: 8, memoryGi: 16 });
    const db = makeDb([]);
    const r = await validateQuotaFitsHeadroom(db, k8sStub, {
      clientId: 'c1',
      newCpuLimit: 8,
      newMemoryLimitGi: 16,
    });
    expect(r.allowed).toBe(true);
    expect(r.details.overByCpu).toBe(0);
    expect(r.details.overByMemoryGi).toBe(0);
  });

  it('rejects a quota that lands one unit past the headroom', async () => {
    mockHeadroom({ cpu: 8, memoryGi: 16 });
    const db = makeDb([]);
    const r = await validateQuotaFitsHeadroom(db, k8sStub, {
      clientId: 'c1',
      newCpuLimit: 8.01,
      newMemoryLimitGi: 16,
    });
    expect(r.allowed).toBe(false);
    expect(r.details.overByCpu).toBeCloseTo(0.01, 6);
  });
});
