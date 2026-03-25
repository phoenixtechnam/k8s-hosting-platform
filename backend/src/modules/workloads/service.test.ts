import { describe, it, expect, vi } from 'vitest';
import {
  createWorkload,
  getWorkloadById,
  updateWorkload,
  deleteWorkload,
  workloadNotFound,
  imageNotFound,
} from './service.js';
import { ApiError } from '../../shared/errors.js';

vi.mock('../clients/service.js', () => ({
  getClientById: vi.fn().mockResolvedValue({ id: 'c1', companyName: 'Acme' }),
}));

function createMockDb(overrides: {
  selectResults?: unknown[][];
} = {}) {
  const { selectResults = [[]] } = overrides;
  let selectCallIndex = 0;

  const whereFn = vi.fn().mockImplementation(() => {
    const result = selectResults[selectCallIndex] ?? [];
    selectCallIndex++;
    return Promise.resolve(result);
  });
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });

  const insertValues = vi.fn().mockResolvedValue(undefined);
  const insertFn = vi.fn().mockReturnValue({ values: insertValues });

  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
  const updateFn = vi.fn().mockReturnValue({ set: updateSet });

  const deleteWhere = vi.fn().mockResolvedValue(undefined);
  const deleteFn = vi.fn().mockReturnValue({ where: deleteWhere });

  return {
    select: selectFn,
    insert: insertFn,
    update: updateFn,
    delete: deleteFn,
  } as unknown as Parameters<typeof createWorkload>[0];
}

const validInput = {
  name: 'my-workload',
  image_id: '550e8400-e29b-41d4-a716-446655440000',
  replica_count: 2,
  cpu_request: '0.5',
  memory_request: '512Mi',
};

describe('workloadNotFound', () => {
  it('should return ApiError with WORKLOAD_NOT_FOUND code', () => {
    const error = workloadNotFound('w1');
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe('WORKLOAD_NOT_FOUND');
    expect(error.status).toBe(404);
  });
});

describe('imageNotFound', () => {
  it('should return ApiError with IMAGE_NOT_FOUND code', () => {
    const error = imageNotFound('img1');
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe('IMAGE_NOT_FOUND');
    expect(error.status).toBe(404);
  });
});

describe('getWorkloadById', () => {
  it('should return workload when found', async () => {
    const workload = { id: 'w1', clientId: 'c1', name: 'test' };
    const db = createMockDb({ selectResults: [[workload]] });

    const result = await getWorkloadById(db, 'c1', 'w1');
    expect(result).toEqual(workload);
  });

  it('should throw WORKLOAD_NOT_FOUND when not found', async () => {
    const db = createMockDb({ selectResults: [[]] });

    await expect(getWorkloadById(db, 'c1', 'missing')).rejects.toThrow(ApiError);
    await expect(getWorkloadById(db, 'c1', 'missing')).rejects.toMatchObject({
      code: 'WORKLOAD_NOT_FOUND',
      status: 404,
    });
  });
});

describe('createWorkload', () => {
  it('should create workload when image exists', async () => {
    const image = { id: validInput.image_id, name: 'nginx' };
    const created = { id: 'w1', clientId: 'c1', name: validInput.name, status: 'pending' };

    // First select: image lookup returns image, second select: get created workload
    const db = createMockDb({ selectResults: [[image], [created]] });

    const result = await createWorkload(db, 'c1', validInput, 'actor1');
    expect(result).toEqual(created);
  });

  it('should throw IMAGE_NOT_FOUND when image does not exist', async () => {
    // Image lookup returns empty
    const db = createMockDb({ selectResults: [[]] });

    await expect(createWorkload(db, 'c1', validInput, 'actor1')).rejects.toThrow(ApiError);
    await expect(createWorkload(db, 'c1', validInput, 'actor1')).rejects.toMatchObject({
      code: 'IMAGE_NOT_FOUND',
      status: 404,
    });
  });
});

describe('updateWorkload', () => {
  it('should update workload name', async () => {
    const existing = { id: 'w1', clientId: 'c1', name: 'old-name' };
    const updated = { ...existing, name: 'new-name' };

    // First select: getWorkloadById returns existing, second select: returns updated
    const db = createMockDb({ selectResults: [[existing], [updated]] });

    const result = await updateWorkload(db, 'c1', 'w1', { name: 'new-name' });
    expect(result).toEqual(updated);
  });

  it('should throw WORKLOAD_NOT_FOUND for non-existent workload', async () => {
    const db = createMockDb({ selectResults: [[]] });

    await expect(updateWorkload(db, 'c1', 'missing', { name: 'test' })).rejects.toMatchObject({
      code: 'WORKLOAD_NOT_FOUND',
      status: 404,
    });
  });

  it('should verify image exists when updating image_id', async () => {
    const existing = { id: 'w1', clientId: 'c1', name: 'test' };
    // First: getWorkloadById, second: image lookup returns empty
    const db = createMockDb({ selectResults: [[existing], []] });

    await expect(
      updateWorkload(db, 'c1', 'w1', { image_id: '550e8400-e29b-41d4-a716-446655440000' }),
    ).rejects.toMatchObject({
      code: 'IMAGE_NOT_FOUND',
      status: 404,
    });
  });
});

describe('deleteWorkload', () => {
  it('should delete an existing workload', async () => {
    const workload = { id: 'w1', clientId: 'c1', name: 'test' };
    const db = createMockDb({ selectResults: [[workload]] });

    await expect(deleteWorkload(db, 'c1', 'w1')).resolves.toBeUndefined();
  });

  it('should throw WORKLOAD_NOT_FOUND when workload does not exist', async () => {
    const db = createMockDb({ selectResults: [[]] });

    await expect(deleteWorkload(db, 'c1', 'missing')).rejects.toMatchObject({
      code: 'WORKLOAD_NOT_FOUND',
      status: 404,
    });
  });
});
