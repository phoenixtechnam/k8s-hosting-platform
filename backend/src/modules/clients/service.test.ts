import { describe, it, expect, vi } from 'vitest';
import { createClient, getClientById, updateClient, deleteClient } from './service.js';
import { ApiError } from '../../shared/errors.js';

// Helper to build a chainable mock db
function createMockDb(overrides: {
  selectResult?: unknown[];
  insertResult?: unknown;
  updateResult?: unknown;
  deleteResult?: unknown;
} = {}) {
  const { selectResult = [], insertResult = undefined, updateResult = undefined, deleteResult = undefined } = overrides;

  const whereFn = vi.fn().mockResolvedValue(selectResult);
  const fromFn = vi.fn().mockReturnValue({ where: whereFn, orderBy: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(selectResult) }) });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });

  const insertValues = vi.fn().mockResolvedValue(insertResult);
  const insertFn = vi.fn().mockReturnValue({ values: insertValues });

  const updateWhere = vi.fn().mockResolvedValue(updateResult);
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
  const updateFn = vi.fn().mockReturnValue({ set: updateSet });

  const deleteWhere = vi.fn().mockResolvedValue(deleteResult);
  const deleteFn = vi.fn().mockReturnValue({ where: deleteWhere });

  return {
    select: selectFn,
    insert: insertFn,
    update: updateFn,
    delete: deleteFn,
    _whereFn: whereFn,
  } as unknown as Parameters<typeof createClient>[0] & { _whereFn: ReturnType<typeof vi.fn> };
}

describe('getClientById', () => {
  it('should return client when found', async () => {
    const client = { id: 'c1', companyName: 'Acme' };
    const db = createMockDb({ selectResult: [client] });

    const result = await getClientById(db, 'c1');
    expect(result).toEqual(client);
  });

  it('should throw CLIENT_NOT_FOUND when not found', async () => {
    const db = createMockDb({ selectResult: [] });

    await expect(getClientById(db, 'missing')).rejects.toThrow(ApiError);
    await expect(getClientById(db, 'missing')).rejects.toMatchObject({
      code: 'CLIENT_NOT_FOUND',
      status: 404,
    });
  });
});

describe('createClient', () => {
  it('should insert and return created client', async () => {
    const createdClient = {
      id: 'new-uuid',
      companyName: 'New Corp',
      companyEmail: 'admin@newcorp.com',
      status: 'pending',
    };

    // For createClient: insert, then select (to return created record)
    const insertValues = vi.fn().mockResolvedValue(undefined);
    const insertFn = vi.fn().mockReturnValue({ values: insertValues });

    const whereFn = vi.fn().mockResolvedValue([createdClient]);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });

    const db = {
      select: selectFn,
      insert: insertFn,
    } as unknown as Parameters<typeof createClient>[0];

    const input = {
      company_name: 'New Corp',
      company_email: 'admin@newcorp.com',
      plan_id: '550e8400-e29b-41d4-a716-446655440000',
      region_id: '550e8400-e29b-41d4-a716-446655440001',
    };

    const result = await createClient(db, input, 'creator-1');
    expect(result).toEqual(createdClient);
    expect(insertFn).toHaveBeenCalled();
  });
});

describe('updateClient', () => {
  it('should update and return the client', async () => {
    const existingClient = {
      id: 'c1',
      companyName: 'Acme',
      status: 'active',
      createdAt: new Date(),
    };

    // getClientById (first call) returns existing, then updateClient reads again
    let callCount = 0;
    const whereFn = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve([existingClient]);
    });
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });

    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
    const updateFn = vi.fn().mockReturnValue({ set: updateSet });

    const db = {
      select: selectFn,
      update: updateFn,
    } as unknown as Parameters<typeof updateClient>[0];

    const result = await updateClient(db, 'c1', { company_name: 'Acme Updated' });
    expect(result).toEqual(existingClient);
    expect(updateFn).toHaveBeenCalled();
  });

  it('should skip db update when no fields provided', async () => {
    const existingClient = { id: 'c1', companyName: 'Acme' };

    const whereFn = vi.fn().mockResolvedValue([existingClient]);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    const updateFn = vi.fn();

    const db = {
      select: selectFn,
      update: updateFn,
    } as unknown as Parameters<typeof updateClient>[0];

    const result = await updateClient(db, 'c1', {});
    expect(result).toEqual(existingClient);
    expect(updateFn).not.toHaveBeenCalled();
  });
});

describe('deleteClient', () => {
  it('should throw OPERATION_NOT_ALLOWED when client is not cancelled', async () => {
    const client = { id: 'c1', status: 'active' };
    const db = createMockDb({ selectResult: [client] });

    await expect(deleteClient(db, 'c1')).rejects.toMatchObject({
      code: 'OPERATION_NOT_ALLOWED',
      status: 403,
    });
  });

  it('should delete when client is cancelled', async () => {
    const client = { id: 'c1', status: 'cancelled' };
    const deleteWhere = vi.fn().mockResolvedValue(undefined);
    const deleteFn = vi.fn().mockReturnValue({ where: deleteWhere });

    const whereFn = vi.fn().mockResolvedValue([client]);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });

    const db = {
      select: selectFn,
      delete: deleteFn,
    } as unknown as Parameters<typeof deleteClient>[0];

    await deleteClient(db, 'c1');
    expect(deleteFn).toHaveBeenCalled();
  });

  it('should throw CLIENT_NOT_FOUND when client does not exist', async () => {
    const db = createMockDb({ selectResult: [] });

    await expect(deleteClient(db, 'missing')).rejects.toMatchObject({
      code: 'CLIENT_NOT_FOUND',
    });
  });
});
