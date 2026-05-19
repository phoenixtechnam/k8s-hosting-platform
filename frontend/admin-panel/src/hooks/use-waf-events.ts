/**
 * Cluster-wide WAF events hook.
 *
 *   GET  /admin/security/waf-events            — list events + stats + scraperStatus
 *   POST /admin/security/waf-events/refresh    — force one immediate scrape cycle
 *
 * Surfaces ModSecurity/CRS events from the existing waf_logs table —
 * both per-tenant routes AND admin/api/client-host events (the latter
 * had no UI surface before the 2026-05-19 WAF Events tab).
 *
 * Default refetch is 30s (matches the scraper's own cadence — polling
 * faster surfaces nothing new). Pass `live=true` for 3s polling when
 * the operator wants a live tail.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  WafEventsResponse,
  WafEventsQuery,
  WafRefreshResponse,
} from '@k8s-hosting/api-contracts';

interface Envelope<T> {
  readonly data: T;
}

const LIVE_REFETCH_MS = 3_000;
const IDLE_REFETCH_MS = 30_000;

export function useWafEvents(query: WafEventsQuery, opts: { live: boolean } = { live: false }) {
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
    // staleTime mirrors refetch cadence so live-tail doesn't keep hitting the cache.
    staleTime: opts.live ? LIVE_REFETCH_MS - 100 : IDLE_REFETCH_MS / 2,
    refetchInterval: opts.live ? LIVE_REFETCH_MS : IDLE_REFETCH_MS,
  });
}

/**
 * Force one immediate scrape cycle. Server rate-limits to 1/3s and
 * returns 429 if the operator clicks too fast — we just swallow the
 * 429 and rely on the next normal refetch.
 */
export function useRefreshWafScraper() {
  const qc = useQueryClient();
  return useMutation<Envelope<WafRefreshResponse>, Error, void>({
    mutationFn: () => apiFetch('/api/v1/admin/security/waf-events/refresh', { method: 'POST' }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['waf-events'] });
    },
  });
}
