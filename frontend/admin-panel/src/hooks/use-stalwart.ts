import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api-client';
import type {
  StalwartCredentialsResponse,
  RotateStalwartPasswordResponse,
} from '@k8s-hosting/api-contracts';

interface CredentialsEnvelope {
  readonly data: StalwartCredentialsResponse;
}
interface RotateEnvelope {
  readonly data: RotateStalwartPasswordResponse;
}

/**
 * Fetches the Stalwart fallback-admin credentials. `enabled` is controlled
 * by the caller so we only hit the backend on explicit user action (click
 * on "SHOW STALWART CREDENTIALS").
 */
export function useStalwartCredentials(enabled: boolean) {
  return useQuery({
    queryKey: ['stalwart-credentials'],
    queryFn: () => apiFetch<CredentialsEnvelope>('/api/v1/admin/mail/stalwart-credentials'),
    enabled,
    // Short staleTime: credentials may change from "Rotate Password" even
    // without our explicit invalidation, and the value is cheap to refetch.
    staleTime: 10_000,
    retry: false,
  });
}

/**
 * Rotates the Stalwart fallback-admin password.
 *
 * Because the rotation endpoint restarts platform-api as its last step,
 * the HTTP response of *this* request is typically killed by the rollout
 * before it reaches the browser (client sees connection reset / 502).
 * We therefore cannot rely on the mutation's `onSuccess` firing.
 *
 * Instead `onSettled` (fires on success OR error) drops the cached
 * credentials and polls until the endpoint returns a password different
 * from the one the caller passed in — proof that the new pod is up and
 * reading the rotated Secret. Timeout after ~60s.
 */
export function useRotateStalwartPassword() {
  const qc = useQueryClient();

  async function waitForNewPassword(priorPassword: string | null): Promise<string | null> {
    const deadline = Date.now() + 60_000;
    let delay = 1_500;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 1.25, 4_000);
      try {
        const res = await apiFetch<CredentialsEnvelope>('/api/v1/admin/mail/stalwart-credentials');
        if (res.data.password && res.data.password !== priorPassword) {
          // Seed the query cache so subscribed components re-render.
          qc.setQueryData(['stalwart-credentials'], res);
          return res.data.password;
        }
      } catch (err: unknown) {
        // 502/connection errors are expected while platform-api is rolling.
        // Keep polling. Only bail on explicit 4xx.
        if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
          throw err;
        }
      }
    }
    return null;
  }

  return useMutation({
    mutationFn: async () => {
      const prior = qc.getQueryData<CredentialsEnvelope>(['stalwart-credentials'])?.data?.password ?? null;
      try {
        // The response usually dies mid-flight; swallow that and rely on
        // the post-settle poll. If by some chance we do get the response,
        // prime the cache with it.
        const resp = await apiFetch<RotateEnvelope>('/api/v1/admin/mail/rotate-stalwart-password', { method: 'POST' });
        qc.setQueryData(['stalwart-credentials'], {
          data: { username: resp.data.username, password: resp.data.password },
        });
        return resp;
      } catch (err: unknown) {
        // Swallow connection-reset class errors; wait for the new pod.
        if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
          throw err;  // a genuine 4xx (e.g. 403, 409) — surface to user
        }
        const newPw = await waitForNewPassword(null);
        if (!newPw) {
          throw new Error(
            'Rotation was sent but the new password could not be confirmed within 60s. Check the server logs; the cluster may still be rolling.',
          );
        }
        return { data: { username: 'admin', password: newPw, rotatedAt: new Date().toISOString() } };
      }
    },
    onSettled: async () => {
      // Whatever happened, make sure any subscribed component re-renders
      // against the latest cached value.
      qc.invalidateQueries({ queryKey: ['stalwart-credentials'] });
    },
  });
}
