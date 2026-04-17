import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { WebadminUrlResponse } from '@k8s-hosting/api-contracts';

interface WebadminUrlEnvelope {
  readonly data: WebadminUrlResponse;
}

/**
 * Fetches the Stalwart web-admin URL + suggested username. The admin panel
 * uses this to render a "Open Stalwart Admin" button on EmailManagement.
 */
export function useStalwartWebadminUrl() {
  return useQuery({
    queryKey: ['stalwart-webadmin-url'],
    queryFn: () => apiFetch<WebadminUrlEnvelope>('/api/v1/admin/mail/webadmin-url'),
    // URL is stable per deployment; cache for the session.
    staleTime: Infinity,
    // A missing config returns 503 — don't retry aggressively.
    retry: false,
  });
}
