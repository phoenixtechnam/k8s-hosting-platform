import { describe, it, expect, vi } from 'vitest';
import { listDirectories, createDirectory, deleteDirectory, listDirectoryUsers, createDirectoryUser, toggleDirectoryUser, deleteDirectoryUser } from './service.js';
import { ApiError } from '../../shared/errors.js';

const DOMAIN = { id: 'd1', clientId: 'c1', domainName: 'example.com' };
const DIR = { id: 'dir1', domainId: 'd1', path: '/admin', realm: 'Admin Area', createdAt: new Date(), updatedAt: new Date() };
const USER = { id: 'u1', directoryId: 'dir1', username: 'admin', enabled: 1, createdAt: new Date() };

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
  const deleteWhere = vi.fn().mockResolvedValue(undefined);
  const deleteFn = vi.fn().mockReturnValue({ where: deleteWhere });

  return {
    select: selectFn,
    insert: insertFn,
    update: updateFn,
    delete: deleteFn,
    _whereFn: whereFn,
  } as unknown as Parameters<typeof listDirectories>[0] & { _whereFn: ReturnType<typeof vi.fn> };
}

describe('listDirectories', () => {
  it('should return directories for valid domain', async () => {
    const db = createMockDb([[DOMAIN], [DIR]]);
    const result = await listDirectories(db, 'c1', 'd1');
    expect(result).toBeDefined();
  });

  it('should throw DOMAIN_NOT_FOUND for invalid domain', async () => {
    const db = createMockDb([[]]);
    await expect(listDirectories(db, 'c1', 'missing')).rejects.toMatchObject({
      code: 'DOMAIN_NOT_FOUND',
      status: 404,
    });
  });
});

describe('createDirectory', () => {
  it('should insert and return directory', async () => {
    const db = createMockDb([[DOMAIN], [DIR]]);
    const result = await createDirectory(db, 'c1', 'd1', { path: '/admin', realm: 'Admin' });
    expect(result).toEqual(DIR);
  });
});

describe('deleteDirectory', () => {
  it('should delete directory and its users', async () => {
    const db = createMockDb([[DOMAIN], [DIR]]);
    await deleteDirectory(db, 'c1', 'd1', 'dir1');
    // delete called twice: users first, then directory
    expect((db as any).delete).toHaveBeenCalledTimes(2);
  });

  it('should throw when directory not found', async () => {
    const db = createMockDb([[DOMAIN], []]);
    await expect(deleteDirectory(db, 'c1', 'd1', 'missing')).rejects.toMatchObject({
      code: 'PROTECTED_DIR_NOT_FOUND',
      status: 404,
    });
  });
});

describe('listDirectoryUsers', () => {
  it('should convert enabled field to boolean', async () => {
    // Mock select with specific columns
    const selectObj = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([USER]),
      }),
    });
    let callCount = 0;
    const whereFn = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve([DOMAIN]);
      if (callCount === 2) return Promise.resolve([DIR]);
      return Promise.resolve([USER]);
    });
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });

    const db = {
      select: vi.fn().mockImplementation((cols) => {
        if (cols) return { from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([USER]) }) };
        return { from: fromFn };
      }),
    } as unknown as Parameters<typeof listDirectoryUsers>[0];

    const result = await listDirectoryUsers(db, 'c1', 'd1', 'dir1');
    expect(result[0].enabled).toBe(true);
  });
});

describe('toggleDirectoryUser', () => {
  it('should throw DIR_USER_NOT_FOUND when user missing', async () => {
    const db = createMockDb([[DOMAIN], [DIR], []]);
    await expect(toggleDirectoryUser(db, 'c1', 'd1', 'dir1', 'missing', false)).rejects.toMatchObject({
      code: 'DIR_USER_NOT_FOUND',
      status: 404,
    });
  });
});

describe('deleteDirectoryUser', () => {
  it('should throw DIR_USER_NOT_FOUND when user missing', async () => {
    const db = createMockDb([[DOMAIN], [DIR], []]);
    await expect(deleteDirectoryUser(db, 'c1', 'd1', 'dir1', 'missing')).rejects.toMatchObject({
      code: 'DIR_USER_NOT_FOUND',
      status: 404,
    });
  });
});
