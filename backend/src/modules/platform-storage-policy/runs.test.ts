import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock the tasks service so finishRun's task-center mirror call is
// observable without spinning up a DB. The platformStorageApplyRuns
// update path is mocked via the db fake below.
vi.mock('../tasks/service.js', () => ({
  finishByRef: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../db/schema.js', () => ({
  platformStorageApplyRuns: {
    id: 'platform_storage_apply_runs.id',
    status: 'platform_storage_apply_runs.status',
    finishedAt: 'platform_storage_apply_runs.finished_at',
    convergenceJson: 'platform_storage_apply_runs.convergence_json',
  },
}));

import { finishRun, type ConvergenceSnapshot } from './runs.js';
import * as tasks from '../tasks/service.js';
import type { Database } from '../../db/index.js';

function makeDb() {
  const updateChain = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(undefined),
  };
  const db = {
    update: vi.fn().mockReturnValue(updateChain),
  } as unknown as Database;
  return { db, updateChain };
}

function makeConv(overrides: Partial<ConvergenceSnapshot> = {}): ConvergenceSnapshot {
  return {
    volumesConverged: 0,
    volumesTotal: 0,
    volumesOffSystem: 0,
    cnpgConverged: 0,
    cnpgTotal: 0,
    deploymentsConverged: 0,
    deploymentsTotal: 0,
    lastObservedAt: new Date().toISOString(),
    elapsedMs: 0,
    stuckResources: [],
    ...overrides,
  };
}

describe('finishRun — task-center mirror', () => {
  beforeEach(() => {
    vi.mocked(tasks.finishByRef).mockClear();
  });

  it('flips the task chip to succeeded when the run succeeded', async () => {
    const { db } = makeDb();
    await finishRun(db, 'run-1', 'succeeded', makeConv());

    expect(tasks.finishByRef).toHaveBeenCalledTimes(1);
    expect(tasks.finishByRef).toHaveBeenCalledWith(
      db,
      'storage.tier-flip',
      'run-1',
      expect.objectContaining({ status: 'succeeded' }),
    );
  });

  it('treats partial as task=succeeded with a "still rebuilding" note', async () => {
    // Partial = patches succeeded but Longhorn/CNPG didn't fully
    // converge within 10 min. Operator can re-open the modal to see
    // what's still mid-rebuild — but the apply itself isn't a failure,
    // so the chip shouldn't fire the red-X.
    const { db } = makeDb();
    await finishRun(db, 'run-2', 'partial', makeConv({ stuckResources: [{ kind: 'volume', name: 'pf/x', observed: 1, desired: 3 }] }));

    expect(tasks.finishByRef).toHaveBeenCalledWith(
      db,
      'storage.tier-flip',
      'run-2',
      expect.objectContaining({
        status: 'succeeded',
        text: expect.stringContaining('still rebuilding'),
      }),
    );
  });

  it('flips the task chip to failed with a capacity message when capacity_blocked', async () => {
    const { db } = makeDb();
    await finishRun(db, 'run-3', 'capacity_blocked', null);

    expect(tasks.finishByRef).toHaveBeenCalledWith(
      db,
      'storage.tier-flip',
      'run-3',
      expect.objectContaining({
        status: 'failed',
        error: expect.stringContaining('Insufficient storage capacity'),
      }),
    );
  });

  it('flips the task chip to failed with a generic message on failed', async () => {
    const { db } = makeDb();
    await finishRun(db, 'run-4', 'failed', null);

    expect(tasks.finishByRef).toHaveBeenCalledWith(
      db,
      'storage.tier-flip',
      'run-4',
      expect.objectContaining({
        status: 'failed',
        error: expect.stringContaining('per-resource errors'),
      }),
    );
  });

  it('does not throw when the task-center finishByRef call rejects', async () => {
    // The run row is the source of truth; the task chip is a UX
    // convenience. A failure to mirror onto the chip must not roll
    // back the finishRun caller (watchConvergence).
    const { db } = makeDb();
    vi.mocked(tasks.finishByRef).mockRejectedValueOnce(new Error('db unreachable'));

    await expect(finishRun(db, 'run-5', 'succeeded', makeConv())).resolves.toBeUndefined();
  });
});
