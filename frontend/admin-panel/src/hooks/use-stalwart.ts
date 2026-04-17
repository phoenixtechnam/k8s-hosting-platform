import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
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

const CREDS_KEY = ['stalwart-credentials'] as const;

/**
 * Fetches the Stalwart fallback-admin credentials on demand. `enabled` is
 * controlled by the caller so we only hit the backend when the user
 * explicitly clicks "Show Stalwart Credentials".
 *
 * `staleTime: 0` + `refetchOnMount: 'always'` ensure a fresh fetch every
 * time the reveal is toggled off and back on — important right after a
 * rotation, otherwise the cached value from 10s ago would be reused.
 */
export function useStalwartCredentials(enabled: boolean) {
  return useQuery({
    queryKey: CREDS_KEY,
    queryFn: () => apiFetch<CredentialsEnvelope>('/api/v1/admin/mail/stalwart-credentials'),
    enabled,
    staleTime: 0,
    refetchOnMount: 'always',
    retry: false,
  });
}

/**
 * Rotates the Stalwart fallback-admin password.
 *
 * Platform-api is NOT restarted on rotation — it reads the cleartext from
 * a mounted Secret volume which kubelet refreshes automatically. So the
 * rotation response comes back intact, and onSuccess seeds the React
 * Query cache with the new value.
 */
export function useRotateStalwartPassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<RotateEnvelope>('/api/v1/admin/mail/rotate-stalwart-password', { method: 'POST' }),
    onSuccess: (resp) => {
      qc.setQueryData<CredentialsEnvelope>(CREDS_KEY, {
        data: { username: resp.data.username, password: resp.data.password },
      });
    },
  });
}
