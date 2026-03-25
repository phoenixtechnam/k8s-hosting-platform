import { eq, and } from 'drizzle-orm';
import { workloadRepositories, containerImages } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import type { Database } from '../../db/index.js';
import type { AddRepoInput } from './schema.js';

interface CatalogEntry {
  readonly name: string;
}

interface WorkloadManifest {
  readonly name: string;
  readonly code: string;
  readonly image_type: string;
  readonly registry_url: string;
  readonly supported_versions?: string[];
  readonly has_dockerfile?: boolean;
  readonly min_plan?: string;
  readonly resources?: {
    readonly cpu?: string;
    readonly memory?: string;
  };
  readonly env_vars?: Record<string, string>[];
  readonly tags?: string[];
}

function parseGithubUrl(url: string): { owner: string; repo: string } {
  const match = url.match(/github\.com\/([\w.-]+)\/([\w.-]+)/);
  if (!match) {
    throw new ApiError('INVALID_REPO_URL', 'Could not parse GitHub owner/repo from URL', 400);
  }
  return { owner: match[1], repo: match[2] };
}

function buildRawUrl(owner: string, repo: string, branch: string, path: string): string {
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
}

async function fetchJson<T>(url: string, authToken?: string | null): Promise<T> {
  const headers: Record<string, string> = { 'Accept': 'application/json' };
  if (authToken) {
    headers['Authorization'] = `token ${authToken}`;
  }

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new ApiError(
      'CATALOG_FETCH_ERROR',
      `Failed to fetch ${url}: ${response.status} ${response.statusText}`,
      502,
    );
  }

  return response.json() as Promise<T>;
}

export async function listRepos(db: Database) {
  return db.select().from(workloadRepositories);
}

export async function addRepo(db: Database, input: AddRepoInput) {
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

  return created;
}

export async function deleteRepo(db: Database, id: string) {
  const [repo] = await db
    .select()
    .from(workloadRepositories)
    .where(eq(workloadRepositories.id, id));

  if (!repo) {
    throw new ApiError('REPO_NOT_FOUND', `Workload repository '${id}' not found`, 404);
  }

  // Unlink container images that came from this repo
  await db
    .update(containerImages)
    .set({ sourceRepoId: null })
    .where(eq(containerImages.sourceRepoId, id));

  await db.delete(workloadRepositories).where(eq(workloadRepositories.id, id));
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

    // Fetch catalog.json
    const catalogUrl = buildRawUrl(owner, repoName, repo.branch, 'catalog.json');
    const catalog = await fetchJson<CatalogEntry[]>(catalogUrl, repo.authToken);

    // Fetch each workload manifest and upsert
    for (const entry of catalog) {
      const manifestUrl = buildRawUrl(owner, repoName, repo.branch, `${entry.name}/manifest.json`);

      let manifest: WorkloadManifest;
      try {
        manifest = await fetchJson<WorkloadManifest>(manifestUrl, repo.authToken);
      } catch {
        // Skip workloads whose manifests fail to fetch
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
        imageType: manifest.image_type,
        registryUrl: manifest.registry_url,
        supportedVersions: manifest.supported_versions ?? null,
        sourceRepoId: repoId,
        manifestUrl,
        hasDockerfile: manifest.has_dockerfile ? 1 : 0,
        minPlan: manifest.min_plan ?? null,
        resourceCpu: manifest.resources?.cpu ?? null,
        resourceMemory: manifest.resources?.memory ?? null,
        envVars: manifest.env_vars ?? null,
        tags: manifest.tags ?? null,
        status: 'active' as const,
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
    await db
      .update(workloadRepositories)
      .set({
        status: 'active',
        lastSyncedAt: new Date(),
        lastError: null,
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
