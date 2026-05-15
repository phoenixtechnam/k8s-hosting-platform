import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  MailPlacementResponse,
  MailPlacementUpdateRequest,
  MailFailoverRequest,
  MailFailbackRequest,
} from '@k8s-hosting/api-contracts';

interface PlacementEnvelope {
  readonly data: MailPlacementResponse;
}
interface RunIdEnvelope {
  readonly data: { readonly runId: string };
}

export const PLACEMENT_KEY = ['mail', 'placement'] as const;

export function useMailPlacement() {
  return useQuery({
    queryKey: PLACEMENT_KEY,
    queryFn: () => apiFetch<PlacementEnvelope>('/api/v1/admin/mail/placement'),
    staleTime: 10_000,
    refetchInterval: 15_000,
    retry: false,
  });
}

// Both placement updates and failover/failback move the active pod
// to a different node, which changes:
//   - what `useMailHealth` sees as the live nodeName
//   - what the haproxy DS / hostPort path resolves to externally
//   - what `useMailPortExposure` reports as daemonSetStatus.ready
// Invalidate all three so the operator's view stays coherent after
// a state-changing mutation instead of waiting out staleTime.
//
// Returns the awaited Promise.all so callers' `onSuccess` can return
// it — TanStack Query then holds the mutation's `isPending` flag
// until the invalidations have queued, preventing the brief "saved"
// flash with stale data still mounted.
function invalidateMailDerivedQueries(
  qc: ReturnType<typeof useQueryClient>,
): Promise<unknown> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: PLACEMENT_KEY }),
    qc.invalidateQueries({ queryKey: ['mail', 'health'] }),
    qc.invalidateQueries({ queryKey: ['mail', 'port-exposure'] }),
  ]);
}

export function useUpdateMailPlacement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: MailPlacementUpdateRequest) =>
      apiFetch<void>('/api/v1/admin/mail/placement', {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => invalidateMailDerivedQueries(qc),
  });
}

export function useMailFailover() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: MailFailoverRequest) =>
      apiFetch<RunIdEnvelope>('/api/v1/admin/mail/failover', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => invalidateMailDerivedQueries(qc),
  });
}

export function useMailFailback() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: MailFailbackRequest) =>
      apiFetch<RunIdEnvelope>('/api/v1/admin/mail/failback', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => invalidateMailDerivedQueries(qc),
  });
}
