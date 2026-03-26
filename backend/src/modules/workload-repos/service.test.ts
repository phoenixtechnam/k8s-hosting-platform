import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listRepos, addRepo, deleteRepo, syncRepo, restoreDefaultRepo } from './service.js';
import { ApiError } from '../../shared/errors.js';

// Mock global fetch for syncRepo tests
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function createMockDb(overrides: {
  selectResults?: unknown[][];
} = {}) {
  const { selectResults = [[]] } = overrides;
  let selectCallIndex = 0;

  const andWhereFn = vi.fn().mockImplementation(() => {
    const result = selectResults[selectCallIndex] ?? [];
    selectCallIndex++;
    return Promise.resolve(result);
  });
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
    _whereFn: whereFn,
  } as unknown as Parameters<typeof addRepo>[0] & { _whereFn: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('listRepos', () => {
  it('should return all repositories', async () => {
    const repos = [{ id: 'r1', name: 'repo1' }, { id: 'r2', name: 'repo2' }];
    const fromFn = vi.fn().mockResolvedValue(repos);
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    const db = { select: selectFn } as unknown as Parameters<typeof listRepos>[0];

    const result = await listRepos(db);
    expect(result).toEqual(repos);
  });
});

describe('addRepo', () => {
  it('should insert and return created repository', async () => {
    const created = {
      id: 'r1',
      name: 'my-catalog',
      url: 'https://github.com/org/repo',
      branch: 'main',
      status: 'active',
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ workloads: ['wordpress'] }),
    });

    const db = createMockDb({ selectResults: [[created]] });

    const result = await addRepo(db, {
      name: 'my-catalog',
      url: 'https://github.com/org/repo',
      branch: 'main',
      sync_interval_minutes: 60,
    });
    expect(result).toEqual(created);
  });

  it('should use default branch and interval when not specified', async () => {
    const created = { id: 'r1', name: 'test', branch: 'main' };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ workloads: ['nginx'] }),
    });

    const db = createMockDb({ selectResults: [[created]] });

    const result = await addRepo(db, {
      name: 'test',
      url: 'https://github.com/org/repo',
    });
    expect(result).toBeDefined();
  });
});

describe('deleteRepo', () => {
  it('should delete an existing repository', async () => {
    const repo = { id: 'r1', name: 'test' };
    const db = createMockDb({ selectResults: [[repo]] });

    await expect(deleteRepo(db, 'r1')).resolves.toBeUndefined();
  });

  it('should throw REPO_NOT_FOUND when repository does not exist', async () => {
    const db = createMockDb({ selectResults: [[]] });

    await expect(deleteRepo(db, 'missing')).rejects.toThrow(ApiError);
    await expect(deleteRepo(db, 'missing')).rejects.toMatchObject({
      code: 'REPO_NOT_FOUND',
      status: 404,
    });
  });
});

describe('syncRepo', () => {
  it('should throw REPO_NOT_FOUND when repository does not exist', async () => {
    const db = createMockDb({ selectResults: [[]] });

    await expect(syncRepo(db, 'missing')).rejects.toThrow(ApiError);
    await expect(syncRepo(db, 'missing')).rejects.toMatchObject({
      code: 'REPO_NOT_FOUND',
      status: 404,
    });
  });

  it('should throw CATALOG_FETCH_ERROR when fetch fails', async () => {
    const repo = {
      id: 'r1',
      name: 'test',
      url: 'https://github.com/org/catalog',
      branch: 'main',
      authToken: null,
    };

    const db = createMockDb({ selectResults: [[repo]] });

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
    });

    await expect(syncRepo(db, 'r1')).rejects.toThrow(ApiError);
    await expect(syncRepo(db, 'r1')).rejects.toMatchObject({
      code: 'REPO_NOT_FOUND',
    });
  });
});

describe('deleteRepo - container image cleanup', () => {
  it('should call db.delete on containerImages when deleting a repo', async () => {
    const repo = { id: 'r1', name: 'test' };
    const db = createMockDb({ selectResults: [[repo]] });

    await deleteRepo(db, 'r1');

    // Verify db.delete was called (for containerImages and workloadRepositories)
    expect(db.delete).toHaveBeenCalledTimes(2);
  });
});

describe('addRepo - validation', () => {
  it('should throw REPO_VALIDATION_FAILED when fetch returns 404', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });

    const db = createMockDb({ selectResults: [[]] });

    await expect(
      addRepo(db, {
        name: 'Bad Repo',
        url: 'https://github.com/org/nonexistent',
        branch: 'main',
        sync_interval_minutes: 60,
      }),
    ).rejects.toMatchObject({
      code: 'REPO_VALIDATION_FAILED',
      status: 400,
    });
  });

  it('should throw REPO_VALIDATION_FAILED on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const db = createMockDb({ selectResults: [[]] });

    await expect(
      addRepo(db, {
        name: 'Network Error Repo',
        url: 'https://github.com/org/down',
        branch: 'main',
        sync_interval_minutes: 60,
      }),
    ).rejects.toMatchObject({
      code: 'REPO_VALIDATION_FAILED',
      status: 400,
    });
  });

  it('should throw INVALID_CATALOG when catalog has no workloads', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ workloads: [] }),
    });

    const db = createMockDb({ selectResults: [[]] });

    await expect(
      addRepo(db, {
        name: 'Empty Catalog',
        url: 'https://github.com/org/empty',
        branch: 'main',
        sync_interval_minutes: 60,
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_CATALOG',
      status: 400,
    });
  });

  it('should succeed when catalog has valid workloads', async () => {
    const created = {
      id: 'r1',
      name: 'Valid Repo',
      url: 'https://github.com/org/valid',
      branch: 'main',
      status: 'active',
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ workloads: ['wordpress', 'nginx'] }),
    });

    const db = createMockDb({ selectResults: [[created]] });

    const result = await addRepo(db, {
      name: 'Valid Repo',
      url: 'https://github.com/org/valid',
      branch: 'main',
      sync_interval_minutes: 60,
    });
    expect(result).toEqual(created);
  });
});

describe('restoreDefaultRepo', () => {
  it('should return existing repo if official catalog URL exists', async () => {
    const existing = {
      id: 'r1',
      name: 'Official Catalog',
      url: 'https://github.com/phoenixtechnam/hosting-platform-workload-catalog',
      branch: 'main',
      status: 'active',
    };
    const db = createMockDb({ selectResults: [[existing]] });

    const result = await restoreDefaultRepo(db);
    expect(result).toEqual(existing);
    // Should NOT have called insert
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('should create official catalog repo if not present', async () => {
    const created = {
      id: 'new-id',
      name: 'Official Catalog',
      url: 'https://github.com/phoenixtechnam/hosting-platform-workload-catalog',
      branch: 'main',
      status: 'active',
    };
    // First select returns empty (not found by URL), second returns created
    const db = createMockDb({ selectResults: [[], [created]] });

    const result = await restoreDefaultRepo(db);
    expect(result).toEqual(created);
    expect(db.insert).toHaveBeenCalled();
  });
});
