import { describe, it, expect, vi, beforeEach } from 'vitest';
import { assertHaTierFeasible, HA_MIN_TENANT_NODES } from './capacity-preflight.js';

function makeDb(rows: Array<{ name: string; canHostClientWorkloads: boolean }>) {
  const eligible = rows.filter((r) => r.canHostClientWorkloads).map((r) => ({ name: r.name }));
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => eligible),
      })),
    })),
  };
}

describe('assertHaTierFeasible', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it(`passes when ${HA_MIN_TENANT_NODES} or more tenant-capable nodes exist`, async () => {
    const rows = Array.from({ length: HA_MIN_TENANT_NODES }, (_, i) => ({
      name: `node-${i}`, canHostClientWorkloads: true,
    }));
    await expect(assertHaTierFeasible(makeDb(rows) as never)).resolves.toBeUndefined();
  });

  it('throws HA_REQUIRES_MULTI_NODE on a single-node cluster', async () => {
    const rows = [{ name: 'only-node', canHostClientWorkloads: true }];
    await expect(assertHaTierFeasible(makeDb(rows) as never))
      .rejects.toMatchObject({ code: 'HA_REQUIRES_MULTI_NODE', status: 409 });
  });

  it('throws when nodes exist but none are tenant-capable (server-only cluster)', async () => {
    const rows = [
      { name: 'srv-1', canHostClientWorkloads: false },
      { name: 'srv-2', canHostClientWorkloads: false },
      { name: 'srv-3', canHostClientWorkloads: false },
    ];
    await expect(assertHaTierFeasible(makeDb(rows) as never))
      .rejects.toMatchObject({ code: 'HA_REQUIRES_MULTI_NODE' });
  });

  it('error envelope includes diagnostics for the operator UI', async () => {
    const rows = [
      { name: 'a', canHostClientWorkloads: true },
      { name: 'b', canHostClientWorkloads: true },
    ];
    try {
      await assertHaTierFeasible(makeDb(rows) as never);
      expect.fail('expected throw');
    } catch (err) {
      const e = err as { details?: { operatorError?: { diagnostics?: Record<string, number> } } };
      expect(e.details?.operatorError?.diagnostics).toMatchObject({
        tenantCapableNodes: 2,
        requiredNodes: HA_MIN_TENANT_NODES,
      });
    }
  });
});
