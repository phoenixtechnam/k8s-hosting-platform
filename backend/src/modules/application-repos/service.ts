import { eq, and } from 'drizzle-orm';
import { applicationRepositories, applicationCatalog } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { parseGithubUrl, buildRawUrl, fetchJson } from '../../shared/github-catalog.js';
import type { Database } from '../../db/index.js';
import type { AddAppRepoInput } from './schema.js';

interface CatalogFile {
  readonly applications?: readonly string[];
}

type CatalogInput = CatalogFile | readonly CatalogEntry[];

interface CatalogEntry {
  readonly name: string;
}

interface ApplicationManifest {
  readonly name: string;
  readonly code: string;
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
}

const OFFICIAL_CATALOG_URL = 'https://github.com/phoenixtechnam/hosting-platform-application-catalog';

async function validateRepoAccess(url: string, branch: string, authToken?: string | null): Promise<void> {
  const { owner, repo } = parseGithubUrl(url);
  const catalogUrl = buildRawUrl(owner, repo, branch, 'catalog.json');

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
      'Repository has no catalog.json or it contains no applications.',
      400,
    );
  }

  if (Array.isArray(catalogData)) {
    if (catalogData.length === 0) {
      throw new ApiError(
        'INVALID_CATALOG',
        'Repository has no catalog.json or it contains no applications.',
        400,
      );
    }
  } else if (catalogData && typeof catalogData === 'object' && 'applications' in catalogData) {
    const applications = (catalogData as CatalogFile).applications;
    if (!applications || applications.length === 0) {
      throw new ApiError(
        'INVALID_CATALOG',
        'Repository has no catalog.json or it contains no applications.',
        400,
      );
    }
  } else {
    throw new ApiError(
      'INVALID_CATALOG',
      'Repository has no catalog.json or it contains no applications.',
      400,
    );
  }
}

export async function listRepos(db: Database) {
  const repos = await db.select().from(applicationRepositories);
  // Strip authToken — never expose stored secrets via API
  return repos.map(({ authToken: _token, ...rest }) => rest);
}

export async function addRepo(db: Database, input: AddAppRepoInput) {
  const branch = input.branch ?? 'main';

  await validateRepoAccess(input.url, branch, input.auth_token);

  const id = crypto.randomUUID();

  await db.insert(applicationRepositories).values({
    id,
    name: input.name,
    url: input.url,
    branch: input.branch ?? 'main',
    authToken: input.auth_token ?? null,
    syncIntervalMinutes: input.sync_interval_minutes ?? 60,
    status: 'active',
  });

  const [created] = await db
    .select()
    .from(applicationRepositories)
    .where(eq(applicationRepositories.id, id));

  // Strip authToken — never expose stored secrets via API
  const { authToken: _token, ...rest } = created;
  return rest;
}

export async function deleteRepo(db: Database, id: string) {
  const [repo] = await db
    .select()
    .from(applicationRepositories)
    .where(eq(applicationRepositories.id, id));

  if (!repo) {
    throw new ApiError('REPO_NOT_FOUND', `Application repository '${id}' not found`, 404);
  }

  // Delete catalog entries that came from this repo
  await db
    .delete(applicationCatalog)
    .where(eq(applicationCatalog.sourceRepoId, id));

  await db.delete(applicationRepositories).where(eq(applicationRepositories.id, id));
}

export async function syncRepo(db: Database, repoId: string) {
  const [repo] = await db
    .select()
    .from(applicationRepositories)
    .where(eq(applicationRepositories.id, repoId));

  if (!repo) {
    throw new ApiError('REPO_NOT_FOUND', `Application repository '${repoId}' not found`, 404);
  }

  // Mark as syncing
  await db
    .update(applicationRepositories)
    .set({ status: 'syncing', lastError: null })
    .where(eq(applicationRepositories.id, repoId));

  try {
    const { owner, repo: repoName } = parseGithubUrl(repo.url);

    // Fetch catalog.json — expects { applications: [...] } or array-of-objects format
    const catalogUrl = buildRawUrl(owner, repoName, repo.branch, 'catalog.json');
    const catalogRaw = await fetchJson<CatalogInput>(catalogUrl, repo.authToken);

    const entries: readonly CatalogEntry[] = Array.isArray(catalogRaw)
      ? catalogRaw
      : ((catalogRaw as CatalogFile).applications ?? []).map((name: string) => ({ name }));

    const VALID_ENTRY_NAME = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
    const manifestErrors: string[] = [];

    // Fetch each application manifest and upsert
    for (const entry of entries) {
      if (!VALID_ENTRY_NAME.test(entry.name)) {
        console.warn(`[application-sync] Skipping entry with invalid name: "${entry.name}"`);
        manifestErrors.push(`Invalid entry name: "${entry.name}"`);
        continue;
      }

      const manifestUrl = buildRawUrl(owner, repoName, repo.branch, `${entry.name}/manifest.json`);

      let manifest: ApplicationManifest;
      try {
        manifest = await fetchJson<ApplicationManifest>(manifestUrl, repo.authToken);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[application-sync] Failed to fetch manifest for "${entry.name}": ${msg}`);
        manifestErrors.push(`${entry.name}: ${msg}`);
        continue;
      }

      const code = manifest.code;
      const [existing] = await db
        .select()
        .from(applicationCatalog)
        .where(
          and(
            eq(applicationCatalog.code, code),
            eq(applicationCatalog.sourceRepoId, repoId),
          ),
        );

      const catalogValues = {
        name: manifest.name,
        version: manifest.version ?? null,
        description: manifest.description ?? null,
        url: manifest.url ?? null,
        documentation: manifest.documentation ?? null,
        category: manifest.category ?? null,
        minPlan: manifest.min_plan ?? null,
        tenancy: (manifest.tenancy as unknown as Record<string, unknown> | null) ?? null,
        components: (manifest.components as unknown as Record<string, unknown> | null) ?? null,
        networking: (manifest.networking as unknown as Record<string, unknown> | null) ?? null,
        volumes: (manifest.volumes as unknown as Record<string, unknown> | null) ?? null,
        resources: (manifest.resources as unknown as Record<string, unknown> | null) ?? null,
        healthCheck: (manifest.health_check as unknown as Record<string, unknown> | null) ?? null,
        parameters: (manifest.parameters as unknown as Record<string, unknown> | null) ?? null,
        tags: (manifest.tags as unknown as string[] | null) ?? null,
        status: 'available' as const,
        sourceRepoId: repoId,
        manifestUrl,
      };

      if (existing) {
        await db
          .update(applicationCatalog)
          .set(catalogValues)
          .where(eq(applicationCatalog.id, existing.id));
      } else {
        await db.insert(applicationCatalog).values({
          id: crypto.randomUUID(),
          code,
          ...catalogValues,
        });
      }
    }

    // Mark sync complete
    const syncLastError = manifestErrors.length > 0
      ? `${manifestErrors.length} manifest(s) failed to fetch`
      : null;

    await db
      .update(applicationRepositories)
      .set({
        status: 'active',
        lastSyncedAt: new Date(),
        lastError: syncLastError,
      })
      .where(eq(applicationRepositories.id, repoId));
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await db
      .update(applicationRepositories)
      .set({ status: 'error', lastError: errorMessage })
      .where(eq(applicationRepositories.id, repoId));
    throw error;
  }
}

export async function restoreDefaultRepo(db: Database) {
  // Check if the official catalog repo already exists by URL
  const [existing] = await db
    .select()
    .from(applicationRepositories)
    .where(eq(applicationRepositories.url, OFFICIAL_CATALOG_URL));

  if (existing) {
    // Strip authToken — never expose stored secrets via API
    const { authToken: _token, ...rest } = existing;
    return rest;
  }

  const id = crypto.randomUUID();

  await db.insert(applicationRepositories).values({
    id,
    name: 'Official Catalog',
    url: OFFICIAL_CATALOG_URL,
    branch: 'main',
    authToken: null,
    syncIntervalMinutes: 60,
    status: 'active',
  });

  const [created] = await db
    .select()
    .from(applicationRepositories)
    .where(eq(applicationRepositories.id, id));

  // Strip authToken — never expose stored secrets via API
  const { authToken: _token2, ...rest } = created;
  return rest;
}

function parseJsonField(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return value; }
  }
  return value;
}

export async function getCatalogEntry(db: Database, code: string) {
  const rows = await db
    .select()
    .from(applicationCatalog)
    .where(eq(applicationCatalog.code, code));

  if (rows.length === 0) {
    throw new ApiError('CATALOG_ENTRY_NOT_FOUND', `Application catalog entry '${code}' not found`, 404, { code });
  }

  const row = rows[0];
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
  };
}

export async function updateBadges(db: Database, id: string, badges: { featured?: boolean; popular?: boolean }) {
  const [entry] = await db.select().from(applicationCatalog).where(eq(applicationCatalog.id, id));
  if (!entry) {
    throw new ApiError('CATALOG_ENTRY_NOT_FOUND', `Application catalog entry '${id}' not found`, 404);
  }

  const updateValues: Record<string, unknown> = {};
  if (badges.featured !== undefined) updateValues.featured = badges.featured ? 1 : 0;
  if (badges.popular !== undefined) updateValues.popular = badges.popular ? 1 : 0;

  if (Object.keys(updateValues).length > 0) {
    await db.update(applicationCatalog).set(updateValues).where(eq(applicationCatalog.id, id));
  }

  const [updated] = await db.select().from(applicationCatalog).where(eq(applicationCatalog.id, id));
  return {
    ...updated,
    tags: parseJsonField(updated.tags),
    components: parseJsonField(updated.components),
    networking: parseJsonField(updated.networking),
    volumes: parseJsonField(updated.volumes),
    resources: parseJsonField(updated.resources),
    healthCheck: parseJsonField(updated.healthCheck),
    parameters: parseJsonField(updated.parameters),
    tenancy: parseJsonField(updated.tenancy),
  };
}

export async function listCatalogEntries(db: Database) {
  const rows = await db.select().from(applicationCatalog);
  return rows.map(row => ({
    ...row,
    tags: parseJsonField(row.tags),
    components: parseJsonField(row.components),
    networking: parseJsonField(row.networking),
    volumes: parseJsonField(row.volumes),
    resources: parseJsonField(row.resources),
    healthCheck: parseJsonField(row.healthCheck),
    parameters: parseJsonField(row.parameters),
    tenancy: parseJsonField(row.tenancy),
  }));
}
