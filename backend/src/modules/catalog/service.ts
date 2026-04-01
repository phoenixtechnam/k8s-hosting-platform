/**
 * Unified catalog service.
 *
 * Manages catalog repositories and entries (applications, runtimes, databases, services).
 * Replaces the old application-repos and workload-repos modules.
 */

import { eq, and, like, sql, desc, asc, lt, gt, or } from 'drizzle-orm';
import { catalogRepositories, catalogEntries, catalogEntryVersions } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { join } from 'node:path';
import {
  parseRepoUrl, buildCatalogFileUrl, fetchJson,
  downloadCatalogRepo, readLocalJson, fileExists, persistCatalogCache,
  type RepoSource,
} from '../../shared/github-catalog.js';
import { encodeCursor, decodeCursor } from '../../shared/pagination.js';
import type { Database } from '../../db/index.js';
import type { CreateCatalogRepoInput, UpdateCatalogRepoInput } from './schema.js';
import type { PaginationMeta } from '../../shared/response.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_CATALOG_URL = 'https://github.com/phoenixtechnam/k8s-application-catalog';
const VALID_ENTRY_NAME = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

// ─── Types ──────────────────────────────────────────────────────────────────

interface CatalogJson {
  readonly entries: readonly string[];
}

interface SupportedVersion {
  readonly version: string;
  readonly components: readonly { name: string; image: string }[];
  readonly upgradeFrom?: readonly string[];
  readonly eolDate?: string;
  readonly breakingChanges?: string;
  readonly envChanges?: readonly { key: string; action: string; oldKey?: string; default?: unknown }[];
  readonly migrationNotes?: string;
  readonly minResources?: { cpu?: string; memory?: string; storage?: string };
  readonly isDefault?: boolean;
}

interface EntryManifest {
  readonly name: string;
  readonly code: string;
  readonly type?: 'application' | 'runtime' | 'database' | 'service';
  readonly version?: string;
  readonly description?: string;
  readonly category?: string;
  readonly min_plan?: string;
  readonly tenancy?: string[];
  readonly components?: readonly Record<string, unknown>[];
  readonly networking?: Record<string, unknown>;
  readonly volumes?: readonly Record<string, unknown>[];
  readonly resources?: Record<string, unknown>;
  readonly health_check?: Record<string, unknown>;
  readonly parameters?: readonly Record<string, unknown>[];
  readonly tags?: readonly string[];
  readonly url?: string;
  readonly documentation?: string;
  readonly runtime?: string;
  readonly web_server?: string;
  readonly image?: string;
  readonly has_dockerfile?: boolean;
  readonly deployment_strategy?: string;
  readonly services?: Record<string, unknown>;
  readonly provides?: Record<string, unknown>;
  readonly env_vars?: Record<string, unknown>;
  readonly supportedVersions?: readonly SupportedVersion[];
}

interface ListCatalogEntriesParams {
  readonly limit: number;
  readonly cursor?: string;
  readonly sort: { field: string; direction: 'asc' | 'desc' };
  readonly type?: string;
  readonly category?: string;
  readonly search?: string;
}

// ─── Error Helpers ──────────────────────────────────────────────────────────

const repoNotFound = (id: string) =>
  new ApiError('CATALOG_REPO_NOT_FOUND', `Catalog repository '${id}' not found`, 404, { repo_id: id });

const entryNotFound = (id: string) =>
  new ApiError('CATALOG_ENTRY_NOT_FOUND', `Catalog entry '${id}' not found`, 404, { entry_id: id });

// ─── JSON Field Parser ──────────────────────────────────────────────────────

function parseJsonField(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return value; }
  }
  return value;
}

function normalizeEntryRow(row: typeof catalogEntries.$inferSelect) {
  return {
    ...row,
    tags: parseJsonField(row.tags),
    components: parseJsonField(row.components),
    networking: parseJsonField(row.networking),
    volumes: parseJsonField(row.volumes),
    resources: parseJsonField(row.resources),
    healthCheck: parseJsonField(row.healthCheck),
    parameters: parseJsonField(row.parameters),
    tenancy: parseJsonField(row.tenancy),
    services: parseJsonField(row.services),
    provides: parseJsonField(row.provides),
    envVars: parseJsonField(row.envVars),
  };
}

// ─── Version Helpers ────────────────────────────────────────────────────────

function resolveDefaultVersion(versions: readonly SupportedVersion[]): string | null {
  if (versions.length === 0) return null;
  const defaultEntry = versions.find(v => v.isDefault);
  return defaultEntry?.version ?? versions[versions.length - 1].version;
}

function resolveVersionStatus(eolDate: string | undefined): 'available' | 'deprecated' | 'eol' {
  if (!eolDate) return 'available';
  const eol = new Date(eolDate);
  if (isNaN(eol.getTime())) return 'available';
  const now = new Date();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  if (now.getTime() >= eol.getTime()) return 'eol';
  if (now.getTime() >= eol.getTime() - thirtyDaysMs) return 'deprecated';
  return 'available';
}

// ─── Repo CRUD ──────────────────────────────────────────────────────────────

export async function listCatalogRepos(db: Database) {
  const repos = await db.select().from(catalogRepositories);
  return repos.map(({ authToken: _token, ...rest }) => rest);
}

export async function getCatalogRepoById(db: Database, id: string) {
  const [repo] = await db
    .select()
    .from(catalogRepositories)
    .where(eq(catalogRepositories.id, id));

  if (!repo) throw repoNotFound(id);

  const { authToken: _token, ...rest } = repo;
  return rest;
}

export async function createCatalogRepo(db: Database, input: CreateCatalogRepoInput) {
  const branch = input.branch ?? 'main';

  await validateRepoAccess(input.url, branch, input.auth_token);

  const id = crypto.randomUUID();

  await db.insert(catalogRepositories).values({
    id,
    name: input.name,
    url: input.url,
    branch,
    authToken: input.auth_token ?? null,
    syncIntervalMinutes: input.sync_interval_minutes ?? 60,
    status: 'active',
  });

  // Trigger initial sync (fire-and-forget)
  syncCatalogRepo(db, id).catch(err => {
    console.error(`[catalog-sync] Initial sync failed for repo ${id}:`, err);
  });

  const [created] = await db
    .select()
    .from(catalogRepositories)
    .where(eq(catalogRepositories.id, id));

  const { authToken: _token, ...rest } = created;
  return rest;
}

export async function updateCatalogRepo(db: Database, id: string, input: UpdateCatalogRepoInput) {
  const [existing] = await db
    .select()
    .from(catalogRepositories)
    .where(eq(catalogRepositories.id, id));

  if (!existing) throw repoNotFound(id);

  const updateValues: Record<string, unknown> = {};
  if (input.name !== undefined) updateValues.name = input.name;
  if (input.url !== undefined) updateValues.url = input.url;
  if (input.branch !== undefined) updateValues.branch = input.branch;
  if (input.auth_token !== undefined) updateValues.authToken = input.auth_token;
  if (input.sync_interval_minutes !== undefined) updateValues.syncIntervalMinutes = input.sync_interval_minutes;

  if (Object.keys(updateValues).length > 0) {
    await db.update(catalogRepositories).set(updateValues).where(eq(catalogRepositories.id, id));
  }

  const [updated] = await db
    .select()
    .from(catalogRepositories)
    .where(eq(catalogRepositories.id, id));

  const { authToken: _token, ...rest } = updated;
  return rest;
}

export async function deleteCatalogRepo(db: Database, id: string) {
  const [repo] = await db
    .select()
    .from(catalogRepositories)
    .where(eq(catalogRepositories.id, id));

  if (!repo) throw repoNotFound(id);

  // Delete version records for entries from this repo
  const entries = await db
    .select({ id: catalogEntries.id })
    .from(catalogEntries)
    .where(eq(catalogEntries.sourceRepoId, id));

  for (const entry of entries) {
    await db
      .delete(catalogEntryVersions)
      .where(eq(catalogEntryVersions.catalogEntryId, entry.id));
  }

  // Delete catalog entries from this repo
  await db.delete(catalogEntries).where(eq(catalogEntries.sourceRepoId, id));

  // Delete the repo itself
  await db.delete(catalogRepositories).where(eq(catalogRepositories.id, id));
}

export async function restoreDefaultRepo(db: Database) {
  // Delete all existing repos and their entries
  const allRepos = await db.select({ id: catalogRepositories.id }).from(catalogRepositories);
  for (const repo of allRepos) {
    await deleteCatalogRepo(db, repo.id);
  }

  // Create the default repo
  const id = crypto.randomUUID();

  await db.insert(catalogRepositories).values({
    id,
    name: 'Official Catalog',
    url: DEFAULT_CATALOG_URL,
    branch: 'main',
    authToken: null,
    syncIntervalMinutes: 60,
    status: 'active',
  });

  const [created] = await db
    .select()
    .from(catalogRepositories)
    .where(eq(catalogRepositories.id, id));

  const { authToken: _token, ...rest } = created;
  return rest;
}

// ─── Repo Validation ────────────────────────────────────────────────────────

async function validateRepoAccess(url: string, branch: string, authToken?: string | null): Promise<void> {
  const source = parseRepoUrl(url);
  const catalogUrl = buildCatalogFileUrl(source, branch, 'catalog.json');

  let response: Response;
  try {
    const headers: Record<string, string> = { 'Accept': 'application/json' };
    if (authToken) {
      headers['Authorization'] = `token ${authToken}`;
    }
    response = await fetch(catalogUrl, { headers, signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new ApiError(
      'REPO_VALIDATION_FAILED',
      `Cannot access repository: ${errorMessage}. Verify the URL and auth token.`,
      400,
    );
  }

  if (!response.ok) {
    throw new ApiError(
      'REPO_VALIDATION_FAILED',
      `Cannot access repository: ${response.status} ${response.statusText}. Verify the URL and auth token.`,
      400,
    );
  }

  let catalogData: unknown;
  try {
    catalogData = await response.json();
  } catch {
    throw new ApiError(
      'INVALID_CATALOG',
      'Repository has no valid catalog.json.',
      400,
    );
  }

  const data = catalogData as Record<string, unknown>;
  if (!data || !Array.isArray(data.entries) || data.entries.length === 0) {
    throw new ApiError(
      'INVALID_CATALOG',
      'Repository catalog.json has no entries.',
      400,
    );
  }
}

// ─── Sync ───────────────────────────────────────────────────────────────────

interface SyncResult {
  readonly synced: number;
  readonly errors: readonly string[];
  readonly message: string;
}

export async function syncCatalogRepo(db: Database, repoId: string): Promise<SyncResult> {
  const [repo] = await db
    .select()
    .from(catalogRepositories)
    .where(eq(catalogRepositories.id, repoId));

  if (!repo) throw repoNotFound(repoId);

  // Mark as syncing
  await db
    .update(catalogRepositories)
    .set({ status: 'syncing', lastError: null })
    .where(eq(catalogRepositories.id, repoId));

  try {
    const source = parseRepoUrl(repo.url);
    let localRoot: string;
    let usedTarball = false;

    // Strategy: download tarball for GitHub repos (1 request), fallback to per-file for HTTP
    if (source.type === 'github') {
      console.log(`[catalog-sync] Downloading tarball for ${source.owner}/${source.repo}@${repo.branch}`);
      const extracted = await downloadCatalogRepo(source, repo.branch, repo.authToken);
      localRoot = await persistCatalogCache(extracted, repoId);
      usedTarball = true;
      console.log(`[catalog-sync] Tarball extracted to ${localRoot}`);
    } else {
      // HTTP source: no tarball, fall back to per-file fetch
      // Create a temporary local cache by fetching catalog.json + each manifest
      localRoot = await syncViaPerFileFetch(source, repo.branch, repo.authToken);
    }

    // Read catalog.json from local files
    const catalogRaw = await readLocalJson<CatalogJson>(join(localRoot, 'catalog.json'));
    const entryCodes: readonly string[] = catalogRaw.entries ?? [];
    const manifestErrors: string[] = [];
    let syncedCount = 0;

    for (const code of entryCodes) {
      if (!VALID_ENTRY_NAME.test(code)) {
        manifestErrors.push(`Invalid entry code: "${code}"`);
        continue;
      }

      const manifestPath = join(localRoot, code, 'manifest.json');
      if (!(await fileExists(manifestPath))) {
        manifestErrors.push(`${code}: manifest.json not found`);
        continue;
      }

      let manifest: EntryManifest;
      try {
        manifest = await readLocalJson<EntryManifest>(manifestPath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        manifestErrors.push(`${code}: Invalid JSON — ${msg}`);
        continue;
      }

      // Build the remote manifestUrl for display (even though we read locally)
      const manifestUrl = buildCatalogFileUrl(source, repo.branch, `${code}/manifest.json`);

      const entryCode = manifest.code ?? code;
      const [existing] = await db
        .select()
        .from(catalogEntries)
        .where(
          and(
            eq(catalogEntries.code, entryCode),
            eq(catalogEntries.sourceRepoId, repoId),
          ),
        );

      const latestVersion = manifest.version ?? null;
      const defaultVersion = manifest.supportedVersions
        ? resolveDefaultVersion(manifest.supportedVersions)
        : latestVersion;

      const catalogValues = {
        name: manifest.name,
        type: (manifest.type ?? 'application') as 'application' | 'runtime' | 'database' | 'service',
        version: manifest.version ?? null,
        latestVersion,
        defaultVersion,
        description: manifest.description ?? null,
        url: manifest.url ?? null,
        documentation: manifest.documentation ?? null,
        category: manifest.category ?? null,
        minPlan: manifest.min_plan ?? null,
        tenancy: (manifest.tenancy ?? null) as typeof catalogEntries.$inferInsert['tenancy'],
        components: (manifest.components ?? null) as typeof catalogEntries.$inferInsert['components'],
        networking: (manifest.networking ?? null) as typeof catalogEntries.$inferInsert['networking'],
        volumes: (manifest.volumes ?? null) as typeof catalogEntries.$inferInsert['volumes'],
        resources: (manifest.resources ?? null) as typeof catalogEntries.$inferInsert['resources'],
        healthCheck: (manifest.health_check ?? null) as typeof catalogEntries.$inferInsert['healthCheck'],
        parameters: (manifest.parameters ?? null) as typeof catalogEntries.$inferInsert['parameters'],
        tags: (manifest.tags as unknown as string[] | null) ?? null,
        runtime: manifest.runtime ?? null,
        webServer: manifest.web_server ?? null,
        image: manifest.image ?? null,
        hasDockerfile: manifest.has_dockerfile ? 1 : 0,
        deploymentStrategy: manifest.deployment_strategy ?? null,
        services: (manifest.services ?? null) as typeof catalogEntries.$inferInsert['services'],
        provides: (manifest.provides ?? null) as typeof catalogEntries.$inferInsert['provides'],
        envVars: (manifest.env_vars ?? null) as typeof catalogEntries.$inferInsert['envVars'],
        status: 'available' as const,
        sourceRepoId: repoId,
        manifestUrl,
      };

      let catalogId: string;

      if (existing) {
        catalogId = existing.id;
        await db.update(catalogEntries).set(catalogValues).where(eq(catalogEntries.id, existing.id));
      } else {
        catalogId = crypto.randomUUID();
        await db.insert(catalogEntries).values({ id: catalogId, code: entryCode, ...catalogValues });
      }

      // Sync entry versions
      await db.delete(catalogEntryVersions).where(eq(catalogEntryVersions.catalogEntryId, catalogId));

      if (manifest.supportedVersions && manifest.supportedVersions.length > 0) {
        for (const sv of manifest.supportedVersions) {
          await db.insert(catalogEntryVersions).values({
            id: crypto.randomUUID(),
            catalogEntryId: catalogId,
            version: sv.version,
            isDefault: sv.isDefault ? 1 : 0,
            eolDate: sv.eolDate ?? null,
            components: sv.components ?? null,
            upgradeFrom: sv.upgradeFrom && sv.upgradeFrom.length > 0 ? [...sv.upgradeFrom] : null,
            breakingChanges: sv.breakingChanges ?? null,
            envChanges: sv.envChanges && sv.envChanges.length > 0 ? [...sv.envChanges] : null,
            migrationNotes: sv.migrationNotes ?? null,
            minResources: sv.minResources ?? null,
            status: resolveVersionStatus(sv.eolDate),
          });
        }
      } else if (manifest.version) {
        await db.insert(catalogEntryVersions).values({
          id: crypto.randomUUID(),
          catalogEntryId: catalogId,
          version: manifest.version,
          isDefault: 1,
          eolDate: null, components: null, upgradeFrom: null,
          breakingChanges: null, envChanges: null, migrationNotes: null,
          minResources: null, status: 'available',
        });
      }

      syncedCount++;
    }

    // Store the local cache path for icon serving
    await db
      .update(catalogRepositories)
      .set({
        status: 'active',
        lastSyncedAt: new Date(),
        lastError: manifestErrors.length > 0 ? `${manifestErrors.length} entry error(s)` : null,
        localCachePath: localRoot,
      })
      .where(eq(catalogRepositories.id, repoId));

    console.log(`[catalog-sync] Synced ${syncedCount}/${entryCodes.length} entries${usedTarball ? ' (tarball)' : ' (per-file)'}`);

    return {
      synced: syncedCount,
      errors: manifestErrors,
      message: manifestErrors.length > 0
        ? `Synced ${syncedCount} entries with ${manifestErrors.length} error(s)`
        : `Synced ${syncedCount} entries successfully`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await db
      .update(catalogRepositories)
      .set({ status: 'error', lastError: errorMessage })
      .where(eq(catalogRepositories.id, repoId));
    throw error;
  }
}

// ─── Per-File Fetch Fallback (HTTP sources) ──────────────────────────────────

async function syncViaPerFileFetch(
  source: RepoSource,
  branch: string,
  authToken?: string | null,
): Promise<string> {
  const { mkdtemp, writeFile, mkdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');

  const tempDir = await mkdtemp(join(tmpdir(), 'catalog-http-'));
  const catalogUrl = buildCatalogFileUrl(source, branch, 'catalog.json');
  const catalogRaw = await fetchJson<CatalogJson>(catalogUrl, authToken);

  await writeFile(join(tempDir, 'catalog.json'), JSON.stringify(catalogRaw));

  for (const code of (catalogRaw.entries ?? [])) {
    const manifestUrl = buildCatalogFileUrl(source, branch, `${code}/manifest.json`);
    try {
      const manifest = await fetchJson<Record<string, unknown>>(manifestUrl, authToken);
      await mkdir(join(tempDir, code), { recursive: true });
      await writeFile(join(tempDir, code, 'manifest.json'), JSON.stringify(manifest));
    } catch {
      // Skip entries that fail
    }
  }

  return tempDir;
}

// ─── Catalog Entry Queries ──────────────────────────────────────────────────

export async function listCatalogEntries(
  db: Database,
  params: ListCatalogEntriesParams,
): Promise<{ data: ReturnType<typeof normalizeEntryRow>[]; pagination: PaginationMeta }> {
  const { limit, cursor, sort, type, category, search } = params;

  const conditions = [];

  if (type) {
    conditions.push(eq(catalogEntries.type, type as 'application' | 'runtime' | 'database' | 'service'));
  }
  if (category) {
    conditions.push(eq(catalogEntries.category, category));
  }
  if (search) {
    conditions.push(
      or(
        like(catalogEntries.name, `%${search}%`),
        sql`JSON_CONTAINS(${catalogEntries.tags}, JSON_QUOTE(${search}))`,
      ),
    );
  }

  if (cursor) {
    const decoded = decodeCursor(cursor);
    conditions.push(
      sort.direction === 'desc'
        ? lt(catalogEntries.createdAt, new Date(decoded.sort))
        : gt(catalogEntries.createdAt, new Date(decoded.sort)),
    );
  }

  const orderBy = sort.direction === 'desc' ? desc(catalogEntries.createdAt) : asc(catalogEntries.createdAt);
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select()
    .from(catalogEntries)
    .where(where)
    .orderBy(orderBy)
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const data = rows.slice(0, limit).map(normalizeEntryRow);

  let nextCursor: string | null = null;
  if (hasMore && data.length > 0) {
    const last = rows[data.length - 1];
    nextCursor = encodeCursor({
      resource: 'catalog_entry',
      sort: last.createdAt.toISOString(),
      id: last.id,
    });
  }

  const [countResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(catalogEntries)
    .where(where);

  return {
    data,
    pagination: {
      cursor: nextCursor,
      has_more: hasMore,
      page_size: data.length,
      total_count: Number(countResult?.count ?? 0),
    },
  };
}

export async function getCatalogEntryById(db: Database, id: string) {
  const [row] = await db
    .select()
    .from(catalogEntries)
    .where(eq(catalogEntries.id, id));

  if (!row) throw entryNotFound(id);
  return normalizeEntryRow(row);
}

export async function getCatalogEntryByCode(db: Database, code: string) {
  const [row] = await db
    .select()
    .from(catalogEntries)
    .where(eq(catalogEntries.code, code));

  if (!row) throw entryNotFound(code);
  return normalizeEntryRow(row);
}

export async function listVersionsForEntry(db: Database, catalogEntryId: string) {
  const versions = await db
    .select()
    .from(catalogEntryVersions)
    .where(eq(catalogEntryVersions.catalogEntryId, catalogEntryId));

  return versions.map(row => ({
    ...row,
    components: parseJsonField(row.components),
    upgradeFrom: parseJsonField(row.upgradeFrom),
    envChanges: parseJsonField(row.envChanges),
    minResources: parseJsonField(row.minResources),
  }));
}
