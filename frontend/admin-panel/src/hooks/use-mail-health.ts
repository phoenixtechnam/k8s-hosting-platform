import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { MailHealthResponse } from '@k8s-hosting/api-contracts';

const HEALTH_KEY = ['mail', 'health'] as const;

interface HealthEnvelope {
  readonly data: MailHealthResponse;
}

/**
 * Read /admin/mail/health — real probes (pod + JMAP) of the live mail
 * server, NOT a derived view of system_settings. See
 * backend/src/modules/mail-admin/health.ts.
 *
 * Backend caches the result for 30s; the hook matches the cache window
 * so the page doesn't beat on the API. Banner consumers can fire a
 * manual refresh via `useRefreshMailHealth().mutate()`.
 */
export function useMailHealth() {
  return useQuery({
    queryKey: HEALTH_KEY,
    queryFn: () => apiFetch<HealthEnvelope>('/api/v1/admin/mail/health'),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

/** Bypass the backend cache (operator-initiated "Re-check now"). */
export function useRefreshMailHealth() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<HealthEnvelope>('/api/v1/admin/mail/health?refresh=1'),
    onSuccess: (data) => {
      qc.setQueryData(HEALTH_KEY, data);
    },
  });
}
