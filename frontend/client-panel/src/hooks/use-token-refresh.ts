import { useEffect, useRef, useCallback } from 'react';
import { config } from '@/lib/runtime-config';

const REFRESH_CHECK_INTERVAL = 5 * 60 * 1000; // check every 5 min
const ACTIVITY_THRESHOLD = 5 * 60 * 1000;     // must have activity within 5 min
const TOKEN_REFRESH_WINDOW = 15 * 60;          // refresh when <15 min until expiry (seconds)

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
 * Auto-refreshes the JWT token when the user is active and the token
 * is approaching expiry. Stops refreshing after 60 min of inactivity
 * (token expires naturally).
 */
export function useTokenRefresh() {
  const lastActivityRef = useRef(Date.now());

  // Track user activity
  const onActivity = useCallback(() => {
    lastActivityRef.current = Date.now();
  }, []);

  useEffect(() => {
    const events = ['mousedown', 'keydown', 'touchstart', 'scroll', 'mousemove'];
    // Throttle: only update once per second max
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

  // Periodic refresh check
  useEffect(() => {
    const timer = setInterval(async () => {
      const token = localStorage.getItem('auth_token');
      if (!token) return;

      const timeSinceActivity = Date.now() - lastActivityRef.current;
      if (timeSinceActivity > ACTIVITY_THRESHOLD) return; // inactive — don't refresh

      const exp = getTokenExp();
      if (!exp) return;

      const now = Math.floor(Date.now() / 1000);
      const timeUntilExpiry = exp - now;
      if (timeUntilExpiry > TOKEN_REFRESH_WINDOW) return; // still plenty of time
      if (timeUntilExpiry <= 0) return; // already expired

      // Refresh the token
      try {
        const base = config.API_URL || '';
        const res = await fetch(`${base}/api/v1/auth/refresh`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const data = await res.json();
          if (data.data?.token) {
            localStorage.setItem('auth_token', data.data.token);
          }
        }
      } catch {
        // Refresh failed — token will expire naturally
      }
    }, REFRESH_CHECK_INTERVAL);

    return () => clearInterval(timer);
  }, []);
}
