import { ApiError } from './errors.js';

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
  // Treat as a direct HTTP base URL (for local dev, self-hosted catalogs)
  return { type: 'http', baseUrl: url.replace(/\/$/, '') };
}

/** @deprecated Use parseRepoUrl instead */
export function parseGithubUrl(url: string): { owner: string; repo: string } {
  const source = parseRepoUrl(url);
  if (source.type !== 'github') {
    throw new ApiError('INVALID_REPO_URL', 'Could not parse GitHub owner/repo from URL', 400);
  }
  return { owner: source.owner!, repo: source.repo! };
}

export function buildRawUrl(owner: string, repo: string, branch: string, path: string): string {
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
}

export function buildCatalogFileUrl(source: RepoSource, branch: string, path: string): string {
  if (source.type === 'github') {
    return `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${branch}/${path}`;
  }
  return `${source.baseUrl}/${path}`;
}

export async function fetchJson<T>(url: string, authToken?: string | null): Promise<T> {
  const headers: Record<string, string> = { 'Accept': 'application/json' };
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
