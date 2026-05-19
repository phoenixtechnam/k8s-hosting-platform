/**
 * Cluster-wide WAF events hook.
 *
 *   GET /admin/security/waf-events?ruleId=&severity=&host=&scope=&sinceSeconds=&limit=
 *
 * Surfaces ModSecurity/CRS events from the existing waf_logs table —
 * both per-tenant routes AND admin/api/client-host events (the latter
 * had no UI surface before the 2026-05-19 WAF Events tab).
 *
 * 30s refetch is the same cadence as the waf-log-scraper itself —
 * polling faster wouldn't surface anything new.
 */

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { WafEventsResponse, WafEventsQuery } from '@k8s-hosting/api-contracts';

interface Envelope<T> {
  readonly data: T;
}

export function useWafEvents(query: WafEventsQuery) {
  // Build a stable URLSearchParams (no `undefined` values, no `?` if empty).
  const params = new URLSearchParams();
  if (query.ruleId) params.set('ruleId', query.ruleId);
  if (query.severity) params.set('severity', query.severity);
  if (query.host) params.set('host', query.host);
  if (query.scope) params.set('scope', query.scope);
  if (typeof query.sinceSeconds === 'number') params.set('sinceSeconds', String(query.sinceSeconds));
  if (typeof query.limit === 'number') params.set('limit', String(query.limit));
  const qs = params.toString();
  const url = qs ? `/api/v1/admin/security/waf-events?${qs}` : '/api/v1/admin/security/waf-events';

  return useQuery<Envelope<WafEventsResponse>>({
    queryKey: ['waf-events', query],
    queryFn: () => apiFetch(url),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}
