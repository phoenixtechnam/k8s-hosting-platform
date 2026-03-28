import { eq, and } from 'drizzle-orm';
import { workloadRepositories, containerImages } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { parseGithubUrl, buildRawUrl, fetchJson } from '../../shared/github-catalog.js';
import type { Database } from '../../db/index.js';
import type { AddRepoInput } from './schema.js';

interface WorkloadManifest {
  readonly name: string;
  readonly code: string;
  /** Catalog manifests use "type", not "image_type" */
  readonly type?: string;
  readonly image_type?: string;
  /** Catalog manifests use "image" (nullable) instead of "registry_url" */
  readonly image?: string | null;
  readonly registry_url?: string | null;
  readonly supported_versions?: string[];
  readonly has_dockerfile?: boolean;
  readonly min_plan?: string;
  readonly resources?: {
    readonly cpu?: string;
    readonly memory?: string;
    readonly storage?: string | null;
  };
  readonly env_vars?: { readonly configurable?: string[]; readonly fixed?: Record<string, string> } | Record<string, string>[];
  readonly tags?: string[];
  // New v3 fields
  readonly runtime?: string;
  readonly web_server?: string | null;
  readonly deployment_strategy?: string;
  readonly container_port?: number;
  readonly mount_path?: string;
  readonly health_check?: {
    readonly path?: string | null;
    readonly command?: string[] | null;
    readonly port?: number | null;
    readonly initial_delay_seconds: number;
    readonly period_seconds: number;
  } | null;
  readonly services?: Record<string, unknown>;
  readonly provides?: Record<string, unknown>;
  readonly version?: string;
  readonly description?: string;
}

export async function listRepos(db: Database) {
  const repos = await db.select().from(workloadRepositories);
  // Strip authToken — never expose stored secrets via API
  return repos.map(({ authToken: _token, ...rest }) => rest);
}

const OFFICIAL_CATALOG_URL = 'https://github.com/phoenixtechnam/hosting-platform-workload-catalog';

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
      'Repository has no catalog.json or it contains no workloads.',
      400,
    );
  }

  if (Array.isArray(catalogData)) {
    if (catalogData.length === 0) {
      throw new ApiError(
        'INVALID_CATALOG',
        'Repository has no catalog.json or it contains no workloads.',
        400,
      );
    }
  } else if (catalogData && typeof catalogData === 'object' && 'workloads' in catalogData) {
    const workloads = (catalogData as { workloads?: readonly string[] }).workloads;
    if (!workloads || workloads.length === 0) {
      throw new ApiError(
        'INVALID_CATALOG',
        'Repository has no catalog.json or it contains no workloads.',
        400,
      );
    }
  } else {
    throw new ApiError(
      'INVALID_CATALOG',
      'Repository has no catalog.json or it contains no workloads.',
      400,
    );
  }
}

export async function addRepo(db: Database, input: AddRepoInput) {
  const branch = input.branch ?? 'main';

  await validateRepoAccess(input.url, branch, input.auth_token);

  const id = crypto.randomUUID();

  await db.insert(workloadRepositories).values({
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
    .from(workloadRepositories)
    .where(eq(workloadRepositories.id, id));

  // Strip authToken — never expose stored secrets via API
  const { authToken: _token, ...rest } = created;
  return rest;
}

export async function deleteRepo(db: Database, id: string) {
  const [repo] = await db
    .select()
    .from(workloadRepositories)
    .where(eq(workloadRepositories.id, id));

  if (!repo) {
    throw new ApiError('REPO_NOT_FOUND', `Workload repository '${id}' not found`, 404);
  }

  // Delete container images that came from this repo
  await db
    .delete(containerImages)
    .where(eq(containerImages.sourceRepoId, id));

  await db.delete(workloadRepositories).where(eq(workloadRepositories.id, id));
}

interface CatalogInput {
  readonly workloads?: readonly string[];
}

export async function syncRepo(db: Database, repoId: string) {
  const [repo] = await db
    .select()
    .from(workloadRepositories)
    .where(eq(workloadRepositories.id, repoId));

  if (!repo) {
    throw new ApiError('REPO_NOT_FOUND', `Workload repository '${repoId}' not found`, 404);
  }

  // Mark as syncing
  await db
    .update(workloadRepositories)
    .set({ status: 'syncing', lastError: null })
    .where(eq(workloadRepositories.id, repoId));

  try {
    const { owner, repo: repoName } = parseGithubUrl(repo.url);

    // Fetch catalog.json — supports both array-of-objects and {workloads:[...]} formats
    const catalogUrl = buildRawUrl(owner, repoName, repo.branch, 'catalog.json');
    const catalogRaw = await fetchJson<CatalogInput | readonly { name: string }[]>(catalogUrl, repo.authToken);

    const entries: readonly { readonly name: string }[] = Array.isArray(catalogRaw)
      ? catalogRaw
      : ((catalogRaw as CatalogInput).workloads ?? []).map((name: string) => ({ name }));

    const VALID_ENTRY_NAME = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
    const manifestErrors: string[] = [];

    // Fetch each workload manifest and upsert
    for (const entry of entries) {
      if (!VALID_ENTRY_NAME.test(entry.name)) {
        console.warn(`[workload-sync] Skipping entry with invalid name: "${entry.name}"`);
        manifestErrors.push(`Invalid entry name: "${entry.name}"`);
        continue;
      }

      const manifestUrl = buildRawUrl(owner, repoName, repo.branch, `${entry.name}/manifest.json`);

      let manifest: WorkloadManifest;
      try {
        manifest = await fetchJson<WorkloadManifest>(manifestUrl, repo.authToken);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[workload-sync] Failed to fetch manifest for "${entry.name}": ${msg}`);
        manifestErrors.push(`${entry.name}: ${msg}`);
        continue;
      }

      const code = manifest.code;
      const [existing] = await db
        .select()
        .from(containerImages)
        .where(
          and(
            eq(containerImages.code, code),
            eq(containerImages.sourceRepoId, repoId),
          ),
        );

      const imageValues = {
        name: manifest.name,
        imageType: manifest.image_type ?? manifest.type ?? 'unknown',
        registryUrl: manifest.registry_url ?? manifest.image ?? null,
        supportedVersions: manifest.supported_versions ?? null,
        sourceRepoId: repoId,
        manifestUrl,
        hasDockerfile: manifest.has_dockerfile ? 1 : 0,
        minPlan: manifest.min_plan ?? null,
        resourceCpu: manifest.resources?.cpu ?? null,
        resourceMemory: manifest.resources?.memory ?? null,
        resourceStorage: manifest.resources?.storage ?? null,
        envVars: (manifest.env_vars ?? null) as { configurable: string[]; fixed: Record<string, string> } | Record<string, string>[] | null,
        tags: manifest.tags ?? null,
        status: 'active' as const,
        // New v3 fields
        runtime: manifest.runtime ?? null,
        webServer: manifest.web_server ?? null,
        deploymentStrategy: manifest.deployment_strategy ?? null,
        containerPort: manifest.container_port ?? null,
        mountPath: manifest.mount_path ?? null,
        healthCheck: manifest.health_check ?? null,
        services: manifest.services ?? null,
        provides: manifest.provides ?? null,
        version: manifest.version ?? null,
        description: manifest.description ?? null,
      };

      if (existing) {
        await db
          .update(containerImages)
          .set(imageValues)
          .where(eq(containerImages.id, existing.id));
      } else {
        await db.insert(containerImages).values({
          id: crypto.randomUUID(),
          code,
          ...imageValues,
        });
      }
    }

    // Mark sync complete
    const syncLastError = manifestErrors.length > 0
      ? `${manifestErrors.length} manifest(s) failed to fetch`
      : null;

    await db
      .update(workloadRepositories)
      .set({
        status: 'active',
        lastSyncedAt: new Date(),
        lastError: syncLastError,
      })
      .where(eq(workloadRepositories.id, repoId));
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await db
      .update(workloadRepositories)
      .set({ status: 'error', lastError: errorMessage })
      .where(eq(workloadRepositories.id, repoId));
    throw error;
  }
}

export async function restoreDefaultRepo(db: Database) {
  // Check if the official catalog repo already exists by URL
  const [existing] = await db
    .select()
    .from(workloadRepositories)
    .where(eq(workloadRepositories.url, OFFICIAL_CATALOG_URL));

  if (existing) {
    // Strip authToken — never expose stored secrets via API
    const { authToken: _token, ...rest } = existing;
    return rest;
  }

  const id = crypto.randomUUID();

  await db.insert(workloadRepositories).values({
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
    .from(workloadRepositories)
    .where(eq(workloadRepositories.id, id));

  // Strip authToken — never expose stored secrets via API
  const { authToken: _token2, ...rest } = created;
  return rest;
}
