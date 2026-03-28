import { ApiError } from './errors.js';

export function parseGithubUrl(url: string): { owner: string; repo: string } {
  const match = url.match(/github\.com\/([\w.-]+)\/([\w.-]+)/);
  if (!match) {
    throw new ApiError('INVALID_REPO_URL', 'Could not parse GitHub owner/repo from URL', 400);
  }
  return { owner: match[1], repo: match[2] };
}

export function buildRawUrl(owner: string, repo: string, branch: string, path: string): string {
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
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
