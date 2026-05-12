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

export function useUpdateMailPlacement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: MailPlacementUpdateRequest) =>
      apiFetch<void>('/api/v1/admin/mail/placement', {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: PLACEMENT_KEY }),
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
    onSuccess: () => qc.invalidateQueries({ queryKey: PLACEMENT_KEY }),
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
    onSuccess: () => qc.invalidateQueries({ queryKey: PLACEMENT_KEY }),
  });
}
