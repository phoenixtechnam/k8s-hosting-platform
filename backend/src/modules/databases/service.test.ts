import { describe, it, expect, vi } from 'vitest';
import { createDatabase, getDatabaseById, listDatabases, deleteDatabase, rotateCredentials } from './service.js';
import { ApiError } from '../../shared/errors.js';

vi.mock('../clients/service.js', () => ({
  getClientById: vi.fn().mockResolvedValue({ id: 'c1', companyName: 'Acme' }),
}));

vi.mock('../auth/service.js', () => ({
  hashNewPassword: vi.fn().mockResolvedValue('hashed-password'),
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
  const orderByFn = vi.fn().mockReturnValue({
    limit: vi.fn().mockImplementation(() => {
      const result = selectResults[selectCallIndex] ?? [];
      selectCallIndex++;
      return Promise.resolve(result);
    }),
  });
  const fromFn = vi.fn().mockReturnValue({
    where: whereFn,
    orderBy: orderByFn,
  });
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
    _whereFn: whereFn,
  } as unknown as Parameters<typeof createDatabase>[0] & { _whereFn: ReturnType<typeof vi.fn> };
}

describe('getDatabaseById', () => {
  it('should return database when found', async () => {
    const database = { id: 'db1', clientId: 'c1', name: 'mydb' };
    const db = createMockDb({ selectResults: [[database]] });

    const result = await getDatabaseById(db, 'c1', 'db1');
    expect(result).toEqual(database);
  });

  it('should throw DATABASE_NOT_FOUND when not found', async () => {
    const db = createMockDb({ selectResults: [[]] });

    await expect(getDatabaseById(db, 'c1', 'missing')).rejects.toThrow(ApiError);
    await expect(getDatabaseById(db, 'c1', 'missing')).rejects.toMatchObject({
      code: 'DATABASE_NOT_FOUND',
      status: 404,
    });
  });
});

describe('createDatabase', () => {
  it('should insert and return created database with password', async () => {
    const created = {
      id: 'db1',
      clientId: 'c1',
      name: 'testdb',
      databaseType: 'mysql',
      username: 'db_testdb_abcd1234',
      port: 3306,
      status: 'active',
    };

    // First select returns [] (no duplicate), second select returns [created]
    const db = createMockDb({ selectResults: [[], [created]] });

    const result = await createDatabase(db, 'c1', { name: 'testdb', db_type: 'mysql' }, 'actor1');
    expect(result.record).toEqual(created);
    expect(result.password).toBeDefined();
    expect(typeof result.password).toBe('string');
    expect(result.password.length).toBeGreaterThan(0);
  });

  it('should set port to 5432 for postgresql', async () => {
    const created = {
      id: 'db2',
      clientId: 'c1',
      name: 'pgdb',
      databaseType: 'postgresql',
      port: 5432,
      status: 'active',
    };

    const db = createMockDb({ selectResults: [[], [created]] });

    const result = await createDatabase(db, 'c1', { name: 'pgdb', db_type: 'postgresql' }, 'actor1');
    expect(result.record.port).toBe(5432);
  });

  it('should throw DUPLICATE_ENTRY when name already exists', async () => {
    const existing = { id: 'db1', name: 'existing' };
    const db = createMockDb({ selectResults: [[existing]] });

    try {
      await createDatabase(db, 'c1', { name: 'existing', db_type: 'mysql' }, 'actor1');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe('DUPLICATE_ENTRY');
      expect((err as ApiError).status).toBe(409);
    }
  });
});

describe('deleteDatabase', () => {
  it('should delete an existing database', async () => {
    const database = { id: 'db1', clientId: 'c1', name: 'mydb' };
    const db = createMockDb({ selectResults: [[database]] });

    await expect(deleteDatabase(db, 'c1', 'db1')).resolves.toBeUndefined();
    expect(db.delete).toHaveBeenCalled();
  });

  it('should throw DATABASE_NOT_FOUND when database does not exist', async () => {
    const db = createMockDb({ selectResults: [[]] });

    await expect(deleteDatabase(db, 'c1', 'missing')).rejects.toMatchObject({
      code: 'DATABASE_NOT_FOUND',
      status: 404,
    });
  });
});

describe('rotateCredentials', () => {
  it('should return new password after rotation', async () => {
    const database = { id: 'db1', clientId: 'c1', name: 'mydb' };
    const updated = { ...database, passwordHash: 'new-hash' };
    const db = createMockDb({ selectResults: [[database], [updated]] });

    const result = await rotateCredentials(db, 'c1', 'db1');
    expect(result.record).toEqual(updated);
    expect(result.password).toBeDefined();
    expect(typeof result.password).toBe('string');
  });

  it('should throw DATABASE_NOT_FOUND for non-existent database', async () => {
    const db = createMockDb({ selectResults: [[]] });

    await expect(rotateCredentials(db, 'c1', 'missing')).rejects.toMatchObject({
      code: 'DATABASE_NOT_FOUND',
      status: 404,
    });
  });
});
