import { mkdtemp, rm, readdir, readFile, access, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ApiError } from './errors.js';

const execFileAsync = promisify(execFile);

// ─── Repo Source ────────────────────────────────────────────────────────────

export interface RepoSource {
  readonly type: 'github' | 'http';
  readonly owner?: string;
  readonly repo?: string;
  readonly baseUrl?: string;
}

export function parseRepoUrl(url: string): RepoSource {
  const match = url.match(/github\.com\/([\w.-]+)\/([\w.-]+)/);
  if (match) {
    return { type: 'github', owner: match[1], repo: match[2] };
  }
  return { type: 'http', baseUrl: url.replace(/\/$/, '') };
}

export function buildCatalogFileUrl(source: RepoSource, branch: string, path: string): string {
  if (source.type === 'github') {
    return `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${branch}/${path}`;
  }
  return `${source.baseUrl}/${path}`;
}

// ─── JSON Fetch (for non-tarball fallback) ──────────────────────────────────

export async function fetchJson<T>(url: string, authToken?: string | null): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (authToken) {
    headers['Authorization'] = `token ${authToken}`;
  }

  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    throw new ApiError(
      'CATALOG_FETCH_ERROR',
      `Failed to fetch ${url}: ${response.status} ${response.statusText}`,
      502,
    );
  }

  return response.json() as Promise<T>;
}

// ─── Tarball Download & Extract ─────────────────────────────────────────────

/**
 * Downloads the repo as a tarball and extracts to a local directory.
 * Returns the path to the extracted catalog root.
 *
 * GitHub tarballs contain a single top-level directory like `owner-repo-sha/`.
 * We flatten this so the returned path contains the catalog files directly.
 */
export async function downloadCatalogRepo(
  source: RepoSource,
  branch: string,
  authToken?: string | null,
): Promise<string> {
  let tarballUrl: string;

  if (source.type === 'github') {
    // GitHub API tarball endpoint — single request, no rate limiting on raw files
    tarballUrl = `https://api.github.com/repos/${source.owner}/${source.repo}/tarball/${branch}`;
  } else {
    // For HTTP sources, there's no standard tarball. Fall back to per-file fetch.
    throw new ApiError(
      'TARBALL_NOT_SUPPORTED',
      'Tarball download is only supported for GitHub repositories. HTTP sources use per-file fetch.',
      400,
    );
  }

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'k8s-hosting-platform/1.0',
  };
  if (authToken) {
    headers['Authorization'] = `token ${authToken}`;
  }

  // Download tarball
  const response = await fetch(tarballUrl, {
    headers,
    signal: AbortSignal.timeout(30_000),
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new ApiError(
      'CATALOG_FETCH_ERROR',
      `Failed to download tarball from ${tarballUrl}: ${response.status} ${response.statusText}`,
      502,
    );
  }

  // Create temp directory for extraction
  const tempBase = join(tmpdir(), 'catalog-sync-');
  const tempDir = await mkdtemp(tempBase);

  try {
    // Write tarball to temp file and extract
    const tarballPath = join(tempDir, 'repo.tar.gz');
    const buffer = Buffer.from(await response.arrayBuffer());
    await import('node:fs/promises').then(fs => fs.writeFile(tarballPath, buffer));

    // Extract
    await execFileAsync('tar', ['xzf', tarballPath, '-C', tempDir]);

    // Remove tarball
    await rm(tarballPath);

    // GitHub tarballs have a top-level dir like `owner-repo-sha/`
    // Find it and move contents up (or just return the nested path)
    const entries = await readdir(tempDir);
    const subdirs = entries.filter(e => !e.startsWith('.'));

    if (subdirs.length === 1) {
      // Single top-level directory — this is the GitHub pattern
      const nestedDir = join(tempDir, subdirs[0]);
      // Check if catalog.json exists inside
      try {
        await access(join(nestedDir, 'catalog.json'));
        return nestedDir;
      } catch {
        // catalog.json not in nested dir, check temp root
      }
    }

    // Check if catalog.json is at the root level
    try {
      await access(join(tempDir, 'catalog.json'));
      return tempDir;
    } catch {
      throw new ApiError(
        'INVALID_CATALOG',
        'Downloaded tarball does not contain a catalog.json',
        400,
      );
    }
  } catch (err) {
    // Clean up on error
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

// ─── Local File Helpers ─────────────────────────────────────────────────────

export async function readLocalJson<T>(filePath: string): Promise<T> {
  const content = await readFile(filePath, 'utf8');
  return JSON.parse(content) as T;
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Persist the extracted catalog to a stable cache directory.
 * Replaces the previous cache if it exists.
 */
export async function persistCatalogCache(
  extractedPath: string,
  repoId: string,
): Promise<string> {
  const cacheDir = join(tmpdir(), `catalog-cache-${repoId}`);
  // Remove old cache
  await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
  // Move extracted to cache location
  await rename(extractedPath, cacheDir);
  return cacheDir;
}
