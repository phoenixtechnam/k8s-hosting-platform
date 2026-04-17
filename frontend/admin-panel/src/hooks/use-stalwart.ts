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
    staleTime: 5 * 60 * 1000, // creds rarely change; cache 5 min
    retry: false,
  });
}

/**
 * Rotates the Stalwart fallback-admin password. Invalidates any cached
 * credentials query so the UI re-fetches the new value after rotation.
 */
export function useRotateStalwartPassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<RotateEnvelope>('/api/v1/admin/mail/rotate-stalwart-password', { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['stalwart-credentials'] });
    },
  });
}
