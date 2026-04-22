import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { config as runtimeConfig } from '@/lib/runtime-config';
import type { PlatformUrlsResponse, UpdatePlatformUrlsInput } from '@k8s-hosting/api-contracts';

// TanStack Query key — a single cache entry shared by every consumer so
// a PATCH invalidation refreshes all pages at once.
const KEY = ['platform-urls'] as const;

interface ApiEnvelope {
  readonly data: PlatformUrlsResponse;
}

/**
 * Fetch the resolved platform URLs. While loading OR if the endpoint
 * returns null values, consumers can fall back to runtimeConfig (populated
 * from ConfigMap via docker-entrypoint). The returned shape includes a
 * `default` hint so the UI can show "Default: <x>" under each field.
 *
 * The fallback keeps cold-boot working — the admin-panel ships with
 * sensible apex-derived URLs baked in via ConfigMap, and the DB path
 * overrides them once the operator edits from System Settings. Once the
 * operator CLEARS a field back to null, the DB row is deleted and the
 * apex-derived default is returned by the backend — no race with the
 * ConfigMap path.
 */
export function usePlatformUrls() {
  return useQuery({
    queryKey: KEY,
    queryFn: async () => {
      const res = await apiFetch<ApiEnvelope>('/api/v1/admin/platform-urls');
      return res.data;
    },
    staleTime: 60_000,
  });
}

export function useUpdatePlatformUrls() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdatePlatformUrlsInput) =>
      apiFetch<ApiEnvelope>('/api/v1/admin/platform-urls', {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

/**
 * Best-effort URL getter. Used in places where the page renders before
 * the query resolves (e.g. the StorageSettings iframe button). Prefers
 * the DB-resolved value, falls back to the runtime-config window global,
 * then to an empty string.
 */
export function resolveLonghornUrl(data: PlatformUrlsResponse | undefined): string {
  return data?.longhornUrl.value || runtimeConfig.LONGHORN_URL || '';
}
export function resolveStalwartAdminUrl(data: PlatformUrlsResponse | undefined): string {
  return data?.stalwartAdminUrl.value || runtimeConfig.STALWART_ADMIN_URL || '';
}
export function resolveWebmailUrl(data: PlatformUrlsResponse | undefined): string {
  return data?.webmailUrl.value || '';
}
export function resolveMailServerHostname(data: PlatformUrlsResponse | undefined): string {
  return data?.mailServerHostname.value || '';
}
