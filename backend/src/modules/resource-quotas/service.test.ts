import { describe, it, expect, vi } from 'vitest';
import { getResourceQuota, updateResourceQuota } from './service.js';

const QUOTA = {
  id: 'q1', clientId: 'c1', cpuCoresLimit: '4.00', memoryGbLimit: 8,
  storageGbLimit: 100, bandwidthGbLimit: 500, cpuCoresCurrent: '1.50',
  memoryGbCurrent: 3, storageGbCurrent: 25, cpuWarningThreshold: '80.00',
  memoryWarningThreshold: 80, storageWarningThreshold: 80, updatedAt: new Date(),
};

function createMockDb(selectResults: unknown[][] = []) {
  let callIdx = 0;
  const whereFn = vi.fn().mockImplementation(() => {
    const result = selectResults[callIdx] ?? [];
    callIdx++;
    return Promise.resolve(result);
  });
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });
  const insertValues = vi.fn().mockResolvedValue(undefined);
  const insertFn = vi.fn().mockReturnValue({ values: insertValues });
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
  const updateFn = vi.fn().mockReturnValue({ set: updateSet });

  return { select: selectFn, insert: insertFn, update: updateFn } as unknown as Parameters<typeof getResourceQuota>[0];
}

describe('getResourceQuota', () => {
  it('should return existing quota', async () => {
    const db = createMockDb([[QUOTA]]);
    const result = await getResourceQuota(db, 'c1');
    expect(result).toEqual(QUOTA);
  });

  it('should auto-create quota when none exists', async () => {
    const db = createMockDb([[], [QUOTA]]); // first empty, then created
    const result = await getResourceQuota(db, 'c1');
    expect(result).toEqual(QUOTA);
    expect((db as any).insert).toHaveBeenCalled();
  });
});

describe('updateResourceQuota', () => {
  it('should update quota fields', async () => {
    const db = createMockDb([[QUOTA], [QUOTA]]); // get then get after update
    const result = await updateResourceQuota(db, 'c1', { cpu_cores_limit: 8, memory_gb_limit: 16 });
    expect((db as any).update).toHaveBeenCalled();
  });
});
