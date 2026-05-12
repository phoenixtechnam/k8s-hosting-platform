import { useEffect } from 'react';
import { apiFetch } from '@/lib/api-client';
import { useClientContext } from '@/hooks/use-client-context';

// Ping interval must be well under the backend's 10-minute idle timeout.
const KEEPALIVE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Starts the file manager as soon as the client is authenticated and keeps
 * it alive for the duration of the session by pinging /status every 5 min.
 *
 * Works for both direct client logins and admin impersonation (clientId
 * comes from the JWT via useClientContext). All calls are fire-and-forget —
 * failures are silently ignored so a degraded FM never breaks the rest of
 * the UI.
 */
export function useFileManagerKeepalive() {
  const { clientId } = useClientContext();

  useEffect(() => {
    if (!clientId) return;

    void apiFetch(`/api/v1/clients/${clientId}/files/start`, { method: 'POST' }).catch(() => {});

    const id = setInterval(() => {
      void apiFetch(`/api/v1/clients/${clientId}/files/status`).catch(() => {});
    }, KEEPALIVE_INTERVAL_MS);

    return () => clearInterval(id);
  }, [clientId]);
}
