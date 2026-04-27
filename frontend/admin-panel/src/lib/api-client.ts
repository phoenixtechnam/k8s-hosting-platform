import { config } from './runtime-config';

export const API_BASE = config.API_URL;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// Phase 3 split-token auth: when the access JWT expires (30 min), the
// API returns 401 INVALID_TOKEN. We silently POST /auth/refresh with
// the long-lived refresh token, store the rotated pair, and replay the
// original request. If the refresh itself fails, we fall back to the
// "Access Token Expired" overlay + redirect to /login.
//
// All concurrent 401s coalesce onto a single in-flight refresh promise
// so we don't issue N parallel /auth/refresh calls (which would also
// trip the rotation reuse-detection heuristic on the backend).
let refreshInFlight: Promise<boolean> | null = null;

async function attemptRefresh(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const refreshToken = localStorage.getItem('auth_refresh_token');
    if (!refreshToken) return false;

    try {
      const res = await fetch(`${API_BASE}/api/v1/auth/refresh`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) return false;
      const body = await res.json();
      const data = body?.data;
      if (!data?.token || !data?.refreshToken) return false;
      localStorage.setItem('auth_token', data.token);
      localStorage.setItem('auth_refresh_token', data.refreshToken);
      if (data.user) localStorage.setItem('auth_user', JSON.stringify(data.user));
      return true;
    } catch {
      return false;
    }
  })();

  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

export async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  return apiFetchWithRetry<T>(path, options, true);
}

async function apiFetchWithRetry<T>(
  path: string,
  options: RequestInit,
  allowRetry: boolean,
): Promise<T> {
  const token = localStorage.getItem('auth_token');

  const headers: Record<string, string> = {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  // Only set Content-Type for requests with a body
  if (options.body) {
    headers['Content-Type'] = 'application/json';
  }

  // Default `credentials: 'same-origin'` is correct here — the admin
  // panel and its /api/v1/* proxy both live on admin.<apex>, so cookies
  // flow without `include`. State-changing routes use Bearer-only auth
  // server-side regardless, so cookie handling is orthogonal.
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...headers,
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: { code: 'UNKNOWN', message: res.statusText } }));
    const code = body.error?.code ?? 'UNKNOWN';

    // Phase 3: silent refresh on access-token expiry. Skip for the
    // login + refresh endpoints themselves to avoid recursion.
    const isAuthEndpoint = path.includes('/auth/login') || path.includes('/auth/refresh');
    if (
      res.status === 401
      && code === 'INVALID_TOKEN'
      && !isAuthEndpoint
      && allowRetry
    ) {
      const refreshed = await attemptRefresh();
      if (refreshed) {
        // Retry once with the new access token.
        return apiFetchWithRetry<T>(path, options, false);
      }
      // Refresh failed — fall through to the expired overlay.
      showTokenExpiredAndRedirect();
    } else if (res.status === 401 && code === 'INVALID_TOKEN' && !isAuthEndpoint) {
      showTokenExpiredAndRedirect();
    }

    throw new ApiError(res.status, code, body.error?.message ?? res.statusText);
  }

  if (res.status === 204) return undefined as T;

  return res.json();
}

let tokenExpiredShown = false;

function showTokenExpiredAndRedirect(): void {
  if (tokenExpiredShown) return;
  tokenExpiredShown = true;

  // Clear auth state
  localStorage.removeItem('auth_token');
  localStorage.removeItem('auth_refresh_token');
  localStorage.removeItem('auth_user');

  // Show full-screen overlay
  const overlay = document.createElement('div');
  overlay.id = 'token-expired-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.7)';
  overlay.innerHTML = `
    <div style="background:white;border-radius:16px;padding:48px;text-align:center;max-width:400px;box-shadow:0 25px 50px rgba(0,0,0,0.25)">
      <div style="font-size:48px;margin-bottom:16px">🔒</div>
      <h2 style="font-size:20px;font-weight:700;color:#111;margin:0 0 8px">Session Expired</h2>
      <p style="font-size:14px;color:#666;margin:0">Redirecting to login...</p>
    </div>
  `;
  document.body.appendChild(overlay);

  setTimeout(() => {
    window.location.href = '/login';
  }, 2000);
}
