import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export type DnsStatus = 'resolved' | 'unresolved' | 'timeout' | 'error' | 'not-configured';
export type SslStatus = 'ready' | 'pending' | 'failed' | 'missing' | 'unknown' | 'not-configured';

export interface PanelUrlHealth {
  readonly host: string | null;
  readonly dns: {
    readonly status: DnsStatus;
    readonly addresses?: ReadonlyArray<string>;
    readonly reason?: string;
  };
  readonly ssl: {
    readonly status: SslStatus;
    readonly reason?: string | null;
    readonly secretName?: string;
    readonly notAfter?: string | null;
    readonly daysUntilExpiry?: number;
    readonly expiringSoon?: boolean;
  };
  readonly checkedAt: string;
}

export interface UrlHealthResponse {
  readonly admin: PanelUrlHealth;
  readonly client: PanelUrlHealth;
}

/**
 * Polls the health endpoint every 30s (server caches 60s, so this is a safe
 * cadence). Refetches eagerly when the user returns to the tab so the badge
 * doesn't go stale during a long idle.
 */
export function useUrlHealth() {
  return useQuery({
    queryKey: ['url-health'],
    queryFn: () => apiFetch<{ data: UrlHealthResponse }>('/api/v1/admin/system-settings/url-health'),
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    staleTime: 15_000,
    select: (res) => res.data,
  });
}
