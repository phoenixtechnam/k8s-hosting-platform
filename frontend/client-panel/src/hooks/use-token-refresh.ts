import { useEffect, useRef, useCallback } from 'react';
import { config } from '@/lib/runtime-config';

// Phase 3 split-token auth:
//   access JWT  — 30 min, in localStorage('auth_token')
//   refresh tok — 24 h,  in localStorage('auth_refresh_token')
const REFRESH_CHECK_INTERVAL = 60 * 1000;       // check every 1 min
const ACTIVITY_THRESHOLD = 25 * 60 * 1000;      // proactive only if active in last 25 min
const TOKEN_REFRESH_WINDOW = 5 * 60;            // refresh when <5 min until access expiry (seconds)

function getTokenExp(): number | null {
  const token = localStorage.getItem('auth_token');
  if (!token) return null;
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.exp ?? null;
  } catch {
    return null;
  }
}

/**
 * Proactively rotates the access JWT before expiry while the user is
 * active. Idle users still get one silent rotation when their next
 * request lands a 401 (handled in api-client). After 24h (refresh-token
 * TTL) the silent rotation will fail and the user is sent to /login.
 */
export function useTokenRefresh() {
  const lastActivityRef = useRef(Date.now());

  const onActivity = useCallback(() => {
    lastActivityRef.current = Date.now();
  }, []);

  useEffect(() => {
    const events = ['mousedown', 'keydown', 'touchstart', 'scroll', 'mousemove'];
    let throttled = false;
    const handler = () => {
      if (throttled) return;
      throttled = true;
      onActivity();
      setTimeout(() => { throttled = false; }, 1000);
    };

    for (const evt of events) window.addEventListener(evt, handler, { passive: true });
    return () => { for (const evt of events) window.removeEventListener(evt, handler); };
  }, [onActivity]);

  useEffect(() => {
    const timer = setInterval(async () => {
      const refreshToken = localStorage.getItem('auth_refresh_token');
      if (!refreshToken) return;

      const timeSinceActivity = Date.now() - lastActivityRef.current;
      if (timeSinceActivity > ACTIVITY_THRESHOLD) return;

      const exp = getTokenExp();
      if (!exp) return;

      const now = Math.floor(Date.now() / 1000);
      const timeUntilExpiry = exp - now;
      if (timeUntilExpiry > TOKEN_REFRESH_WINDOW) return;
      if (timeUntilExpiry <= 0) return;

      try {
        const base = config.API_URL || '';
        const res = await fetch(`${base}/api/v1/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ refreshToken }),
        });
        if (res.ok) {
          const body = await res.json();
          const data = body?.data;
          if (data?.token && data?.refreshToken) {
            localStorage.setItem('auth_token', data.token);
            localStorage.setItem('auth_refresh_token', data.refreshToken);
          }
        }
      } catch {
        // Refresh failed — silent retry on next 401 will catch it.
      }
    }, REFRESH_CHECK_INTERVAL);

    return () => clearInterval(timer);
  }, []);
}
