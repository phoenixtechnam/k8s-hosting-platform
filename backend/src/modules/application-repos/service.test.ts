import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock dependencies ──────────────────────────────────────────────────────

vi.mock('../../shared/github-catalog.js', () => ({
  parseGithubUrl: vi.fn().mockReturnValue({ owner: 'phoenixtechnam', repo: 'hosting-platform-application-catalog' }),
  buildRawUrl: vi.fn().mockReturnValue('https://raw.githubusercontent.com/phoenixtechnam/hosting-platform-application-catalog/main/catalog.json'),
  fetchJson: vi.fn().mockResolvedValue({ applications: ['wordpress'] }),
}));

vi.mock('./sync-versions.js', () => ({
  buildVersionRecords: vi.fn().mockReturnValue([]),
}));

vi.mock('./version-utils.js', () => ({
  resolveDefaultVersion: vi.fn().mockReturnValue('1.0.0'),
}));

vi.mock('../../shared/errors.js', () => ({
  ApiError: class ApiError extends Error {
    code: string;
    statusCode: number;
    details?: Record<string, unknown>;
    constructor(code: string, message: string, statusCode: number, details?: Record<string, unknown>) {
      super(message);
      this.code = code;
      this.statusCode = statusCode;
      this.details = details;
    }
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((_col: unknown, value: unknown) => ({ _type: 'eq', value })),
  and: vi.fn((...args: unknown[]) => ({ _type: 'and', args })),
}));

vi.mock('../../db/schema.js', () => ({
  applicationRepositories: {
    id: 'applicationRepositories.id',
    url: 'applicationRepositories.url',
  },
  applicationCatalog: {
    id: 'applicationCatalog.id',
    code: 'applicationCatalog.code',
    sourceRepoId: 'applicationCatalog.sourceRepoId',
  },
  applicationVersions: {
    applicationCatalogId: 'applicationVersions.applicationCatalogId',
  },
}));

// ─── Data Store ─────────────────────────────────────────────────────────────

const mockRepo = {
  id: 'repo-1',
  name: 'Official Catalog',
  url: 'https://github.com/phoenixtechnam/hosting-platform-application-catalog',
  branch: 'main',
  authToken: 'secret-token-123',
  syncIntervalMinutes: 60,
  status: 'active',
  lastSyncedAt: null,
  lastError: null,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};

const mockCatalogEntry = {
  id: 'cat-1',
  code: 'wordpress',
  name: 'WordPress',
  version: '6.4.0',
  latestVersion: '6.4.0',
  defaultVersion: '6.4.0',
  description: 'A CMS',
  url: null,
  documentation: null,
  category: 'cms',
  minPlan: null,
  tenancy: null,
  components: JSON.stringify([{ name: 'web', image: 'wordpress:6.4' }]),
  networking: null,
  volumes: null,
  resources: null,
  healthCheck: null,
  parameters: null,
  tags: JSON.stringify(['cms', 'blog']),
  featured: 0,
  popular: 0,
  status: 'available',
  sourceRepoId: 'repo-1',
  manifestUrl: 'https://raw.example.com/wordpress/manifest.json',
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};

let repoStore: Array<typeof mockRepo> = [];
let catalogStore: Array<typeof mockCatalogEntry> = [];
let versionStore: Array<{ id: string; applicationCatalogId: string }> = [];

// ─── DB Mock ────────────────────────────────────────────────────────────────

function createMockDb() {
  return {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation((table: { id: string }) => {
        if (table.id === 'applicationRepositories.id') {
          return {
            where: vi.fn().mockImplementation((condition: { _type: string; value: string }) => {
              if (condition._type === 'eq') {
                const val = condition.value;
                return Promise.resolve(repoStore.filter(r => r.id === val || r.url === val));
              }
              return Promise.resolve(repoStore);
            }),
            then: (fn: (v: unknown) => unknown) => fn(repoStore),
          };
        }
        if (table.id === 'applicationCatalog.id') {
          return {
            where: vi.fn().mockImplementation((condition: { _type: string; value: string; args?: unknown[] }) => {
              if (condition._type === 'and') {
                return Promise.resolve([]);
              }
              if (condition._type === 'eq') {
                return Promise.resolve(
                  catalogStore.filter(c => c.id === condition.value || c.code === condition.value || c.sourceRepoId === condition.value),
                );
              }
              return Promise.resolve(catalogStore);
            }),
          };
        }
        if (table.id === 'applicationVersions.applicationCatalogId') {
          return {
            where: vi.fn().mockImplementation((condition: { _type: string; value: string }) => {
              return Promise.resolve(
                versionStore.filter(v => v.applicationCatalogId === condition?.value),
              );
            }),
          };
        }
        // Default: return full store for the table
        return {
          where: vi.fn().mockResolvedValue([]),
        };
      }),
    })),
    insert: vi.fn().mockImplementation(() => ({
      values: vi.fn().mockResolvedValue(undefined),
    })),
    update: vi.fn().mockImplementation(() => ({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    })),
    delete: vi.fn().mockImplementation(() => ({
      where: vi.fn().mockImplementation((condition: { _type: string; value: string }) => {
        const val = condition?.value;
        repoStore = repoStore.filter(r => r.id !== val);
        catalogStore = catalogStore.filter(c => c.sourceRepoId !== val && c.id !== val);
        versionStore = versionStore.filter(v => v.applicationCatalogId !== val);
        return Promise.resolve(undefined);
      }),
    })),
  } as unknown as import('../../db/index.js').Database;
}

// ─── Stub fetch for validateRepoAccess ──────────────────────────────────────

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ applications: ['wordpress'] }),
  });
  repoStore = [{ ...mockRepo }];
  catalogStore = [{ ...mockCatalogEntry }];
  versionStore = [{ id: 'ver-1', applicationCatalogId: 'cat-1' }];
  vi.clearAllMocks();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ─── Import module ──────────────────────────────────────────────────────────

import { afterEach } from 'vitest';

const {
  listRepos,
  addRepo,
  deleteRepo,
  restoreDefaultRepo,
  getCatalogEntry,
  updateBadges,
  listCatalogEntries,
} = await import('./service.js');

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('application-repos service', () => {
  describe('listRepos', () => {
    it('should return repos without authToken', async () => {
      const db = createMockDb();
      // Override to return all repos without where
      db.select = vi.fn().mockImplementation(() => ({
        from: vi.fn().mockResolvedValue(repoStore),
      }));

      const result = await listRepos(db);

      expect(result).toHaveLength(1);
      expect(result[0]).not.toHaveProperty('authToken');
      expect(result[0]).toHaveProperty('id', 'repo-1');
      expect(result[0]).toHaveProperty('name', 'Official Catalog');
    });
  });

  describe('addRepo', () => {
    it('should validate access and insert a new repo', async () => {
      const db = createMockDb();
      // Mock the final select after insert
      let insertCalled = false;
      db.insert = vi.fn().mockImplementation(() => ({
        values: vi.fn().mockImplementation(() => {
          insertCalled = true;
          return Promise.resolve(undefined);
        }),
      }));
      // The function does a select after insert to return the created repo
      db.select = vi.fn().mockImplementation(() => ({
        from: vi.fn().mockImplementation(() => ({
          where: vi.fn().mockResolvedValue([{ ...mockRepo, id: 'new-repo-id', authToken: 'secret' }]),
        })),
      }));

      const input = {
        name: 'My Catalog',
        url: 'https://github.com/org/repo',
        branch: 'main',
      };

      const result = await addRepo(db, input);

      expect(result).not.toHaveProperty('authToken');
      expect(globalThis.fetch).toHaveBeenCalled();
    });
  });

  describe('deleteRepo', () => {
    it('should cascade delete versions, catalog entries, then repo', async () => {
      const db = createMockDb();
      const deleteCalls: string[] = [];

      db.select = vi.fn().mockImplementation(() => ({
        from: vi.fn().mockImplementation((table: { id: string }) => ({
          where: vi.fn().mockImplementation(() => {
            if (table.id === 'applicationRepositories.id') {
              return Promise.resolve([mockRepo]);
            }
            if (table.id === 'applicationCatalog.id') {
              return Promise.resolve([{ id: 'cat-1' }]);
            }
            return Promise.resolve([]);
          }),
        })),
      }));

      db.delete = vi.fn().mockImplementation(() => ({
        where: vi.fn().mockImplementation(() => {
          deleteCalls.push('delete');
          return Promise.resolve(undefined);
        }),
      }));

      await deleteRepo(db, 'repo-1');

      // Should call delete at least 3 times: versions, catalog entries, repo
      expect(db.delete).toHaveBeenCalledTimes(3);
    });

    it('should throw REPO_NOT_FOUND when repo does not exist', async () => {
      const db = createMockDb();
      db.select = vi.fn().mockImplementation(() => ({
        from: vi.fn().mockImplementation(() => ({
          where: vi.fn().mockResolvedValue([]),
        })),
      }));

      await expect(deleteRepo(db, 'nonexistent')).rejects.toThrow('not found');
    });
  });

  describe('restoreDefaultRepo', () => {
    it('should return existing repo if official catalog already exists', async () => {
      const db = createMockDb();
      db.select = vi.fn().mockImplementation(() => ({
        from: vi.fn().mockImplementation(() => ({
          where: vi.fn().mockResolvedValue([mockRepo]),
        })),
      }));

      const result = await restoreDefaultRepo(db);

      expect(result).toHaveProperty('id', 'repo-1');
      expect(result).not.toHaveProperty('authToken');
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('should create the official repo if not found', async () => {
      const db = createMockDb();
      let selectCall = 0;
      db.select = vi.fn().mockImplementation(() => ({
        from: vi.fn().mockImplementation(() => ({
          where: vi.fn().mockImplementation(() => {
            selectCall++;
            if (selectCall === 1) return Promise.resolve([]); // Not found
            return Promise.resolve([{ ...mockRepo, authToken: null }]); // After insert
          }),
        })),
      }));

      const result = await restoreDefaultRepo(db);

      expect(db.insert).toHaveBeenCalled();
      expect(result).not.toHaveProperty('authToken');
    });
  });

  describe('getCatalogEntry', () => {
    it('should return parsed catalog entry', async () => {
      const db = createMockDb();
      db.select = vi.fn().mockImplementation(() => ({
        from: vi.fn().mockImplementation(() => ({
          where: vi.fn().mockResolvedValue([mockCatalogEntry]),
        })),
      }));

      const result = await getCatalogEntry(db, 'wordpress');

      expect(result).toHaveProperty('code', 'wordpress');
      // JSON fields should be parsed
      expect(result.tags).toEqual(['cms', 'blog']);
    });

    it('should throw CATALOG_ENTRY_NOT_FOUND when missing', async () => {
      const db = createMockDb();
      db.select = vi.fn().mockImplementation(() => ({
        from: vi.fn().mockImplementation(() => ({
          where: vi.fn().mockResolvedValue([]),
        })),
      }));

      await expect(getCatalogEntry(db, 'nonexistent')).rejects.toThrow('not found');
    });
  });

  describe('updateBadges', () => {
    it('should update featured and popular flags', async () => {
      const db = createMockDb();
      const updatedEntry = { ...mockCatalogEntry, featured: 1, popular: 1 };
      let selectCall = 0;
      db.select = vi.fn().mockImplementation(() => ({
        from: vi.fn().mockImplementation(() => ({
          where: vi.fn().mockImplementation(() => {
            selectCall++;
            if (selectCall === 1) return Promise.resolve([mockCatalogEntry]);
            return Promise.resolve([updatedEntry]);
          }),
        })),
      }));

      const result = await updateBadges(db, 'cat-1', { featured: true, popular: true });

      expect(db.update).toHaveBeenCalled();
      expect(result).toHaveProperty('featured', 1);
      expect(result).toHaveProperty('popular', 1);
    });

    it('should throw when catalog entry not found', async () => {
      const db = createMockDb();
      db.select = vi.fn().mockImplementation(() => ({
        from: vi.fn().mockImplementation(() => ({
          where: vi.fn().mockResolvedValue([]),
        })),
      }));

      await expect(updateBadges(db, 'nonexistent', { featured: true })).rejects.toThrow('not found');
    });
  });

  describe('listCatalogEntries', () => {
    it('should return all entries with parsed JSON fields', async () => {
      const db = createMockDb();
      db.select = vi.fn().mockImplementation(() => ({
        from: vi.fn().mockResolvedValue([mockCatalogEntry]),
      }));

      const result = await listCatalogEntries(db);

      expect(result).toHaveLength(1);
      expect(result[0].tags).toEqual(['cms', 'blog']);
      expect(result[0].components).toEqual([{ name: 'web', image: 'wordpress:6.4' }]);
    });
  });
});
