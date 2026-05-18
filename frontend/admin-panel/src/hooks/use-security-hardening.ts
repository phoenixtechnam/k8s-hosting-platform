/**
 * TanStack Query hooks for the security-hardening admin API.
 *
 *   GET  /admin/security-hardening          → full snapshot envelope
 *   POST /admin/security-hardening/refresh  → bump probe DaemonSet
 *
 * 30s refetch — slow enough to not hammer kube-API, fast enough for
 * the operator to see probe writes after acting on the runbook.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  SecurityHardeningResponse,
  RefreshSecurityHardeningResponse,
} from '@k8s-hosting/api-contracts';

interface Envelope<T> {
  readonly data: T;
}

const SNAPSHOT_KEY = ['security-hardening', 'snapshot'] as const;

export function useSecurityHardeningSnapshot() {
  return useQuery<SecurityHardeningResponse>({
    queryKey: SNAPSHOT_KEY,
    queryFn: () => apiFetch('/api/v1/admin/security-hardening'),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}

export function useRefreshSecurityHardening() {
  const qc = useQueryClient();
  return useMutation<Envelope<RefreshSecurityHardeningResponse>, Error, void>({
    mutationFn: () =>
      apiFetch('/api/v1/admin/security-hardening/refresh', { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: SNAPSHOT_KEY });
    },
  });
}
