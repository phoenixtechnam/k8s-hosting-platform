import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  StalwartCredentialsResponse,
  RotateStalwartPasswordResponse,
  RotateWebmailMasterPasswordResponse,
} from '@k8s-hosting/api-contracts';

interface CredentialsEnvelope {
  readonly data: StalwartCredentialsResponse;
}
interface RotateEnvelope {
  readonly data: RotateStalwartPasswordResponse;
}
interface RotateWebmailEnvelope {
  readonly data: RotateWebmailMasterPasswordResponse;
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

/**
 * Rotates the Stalwart `master@master.local` Account password — the
 * credential Roundcube's jwt_auth plugin uses for IMAP master-user
 * impersonation when an admin opens a tenant mailbox via SSO.
 *
 * Different from rotateStalwartPassword in two ways:
 *
 *   1. No CREDS_KEY cache update — those creds are the recovery-admin,
 *      not the master user. The new password is shown ONLY in the
 *      rotation response (admin captures it) and lives in the
 *      `roundcube-secrets` Secret thereafter.
 *   2. Roundcube is rolled by the backend (env-var-driven, no volume
 *      refresh). The mutation may take 30-60s because the backend
 *      waits for the Roundcube rollout to begin before returning. The
 *      caller should communicate this in the confirm modal.
 */
export function useRotateWebmailMasterPassword() {
  return useMutation({
    mutationFn: () =>
      apiFetch<RotateWebmailEnvelope>('/api/v1/admin/mail/rotate-webmail-master-password', { method: 'POST' }),
  });
}
