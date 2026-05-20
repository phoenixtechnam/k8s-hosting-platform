/**
 * CrowdSec / Banned IPs admin hooks.
 *
 *   GET    /admin/security/crowdsec/decisions
 *   POST   /admin/security/crowdsec/decisions       — manual ban
 *   DELETE /admin/security/crowdsec/decisions/:id   — unban
 *   GET    /admin/security/crowdsec/status          — coverage + bouncers + capi
 *
 * Decisions are refetched every 15s — bouncer pulls happen every few seconds
 * so 15s is the longest a stale list can persist.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  CrowdsecAddAllowlistRequest,
  CrowdsecAddAllowlistResponse,
  CrowdsecAddBanRequest,
  CrowdsecAddBanResponse,
  CrowdsecAddStaticBanRequest,
  CrowdsecDeleteByIdResponse,
  CrowdsecListAllowlistResponse,
  CrowdsecListDecisionsQuery,
  CrowdsecListDecisionsResponse,
  CrowdsecRemoveAllowlistResponse,
  CrowdsecStatus,
} from '@k8s-hosting/api-contracts';

interface Envelope<T> { readonly data: T; }

const DECISIONS_KEY = ['crowdsec', 'decisions'] as const;
const STATUS_KEY = ['crowdsec', 'status'] as const;

export function useCrowdsecDecisions(query: CrowdsecListDecisionsQuery) {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.scope) params.set('scope', query.scope);
  if (query.manualOnly) params.set('manualOnly', 'true');
  const qs = params.toString();
  const url = qs
    ? `/api/v1/admin/security/crowdsec/decisions?${qs}`
    : '/api/v1/admin/security/crowdsec/decisions';
  return useQuery<Envelope<CrowdsecListDecisionsResponse>>({
    queryKey: [...DECISIONS_KEY, query],
    queryFn: () => apiFetch(url),
    staleTime: 10_000,
    refetchInterval: 15_000,
  });
}

export function useCrowdsecStatus() {
  return useQuery<Envelope<CrowdsecStatus>>({
    queryKey: STATUS_KEY,
    queryFn: () => apiFetch('/api/v1/admin/security/crowdsec/status'),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export function useAddCrowdsecBan() {
  const qc = useQueryClient();
  return useMutation<Envelope<CrowdsecAddBanResponse>, Error, CrowdsecAddBanRequest>({
    mutationFn: (body) =>
      apiFetch('/api/v1/admin/security/crowdsec/decisions', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: DECISIONS_KEY });
    },
  });
}

export function useDeleteCrowdsecDecision() {
  const qc = useQueryClient();
  return useMutation<Envelope<CrowdsecDeleteByIdResponse>, Error, number>({
    mutationFn: (id) =>
      apiFetch(`/api/v1/admin/security/crowdsec/decisions/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: DECISIONS_KEY });
    },
  });
}

// ─── F2 — Allowlist + Static blocklist hooks ──────────────────────────

const ALLOWLIST_KEY = ['crowdsec', 'allowlist'] as const;

export function useCrowdsecAllowlist() {
  return useQuery<Envelope<CrowdsecListAllowlistResponse>>({
    queryKey: ALLOWLIST_KEY,
    queryFn: () => apiFetch('/api/v1/admin/security/crowdsec/allowlist'),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export function useAddCrowdsecAllowlistEntry() {
  const qc = useQueryClient();
  return useMutation<Envelope<CrowdsecAddAllowlistResponse>, Error, CrowdsecAddAllowlistRequest>({
    mutationFn: (body) =>
      apiFetch('/api/v1/admin/security/crowdsec/allowlist', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ALLOWLIST_KEY });
    },
  });
}

export function useRemoveCrowdsecAllowlistEntry() {
  const qc = useQueryClient();
  return useMutation<Envelope<CrowdsecRemoveAllowlistResponse>, Error, string>({
    mutationFn: (value) =>
      apiFetch(`/api/v1/admin/security/crowdsec/allowlist/${encodeURIComponent(value)}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ALLOWLIST_KEY });
    },
  });
}

export function useAddCrowdsecStaticBan() {
  const qc = useQueryClient();
  return useMutation<Envelope<CrowdsecAddBanResponse>, Error, CrowdsecAddStaticBanRequest>({
    mutationFn: (body) =>
      apiFetch('/api/v1/admin/security/crowdsec/static-blocklist', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['crowdsec', 'decisions'] });
    },
  });
}
