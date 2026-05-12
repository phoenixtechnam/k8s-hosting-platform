import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  MailNodeSelectorResponse,
  MailNodeSelectorUpdate,
} from '@k8s-hosting/api-contracts';

interface SelectorEnvelope {
  readonly data: MailNodeSelectorResponse;
}

const SELECTOR_KEY = ['mail', 'node-selector'] as const;

/**
 * Read the current Stalwart pod node-selector config.
 * Returns mode ('any' | 'preferred' | 'required'), the configured
 * nodeName, and the live currentNode where the pod is running.
 */
export function useMailNodeSelector() {
  return useQuery({
    queryKey: SELECTOR_KEY,
    queryFn: () => apiFetch<SelectorEnvelope>('/api/v1/admin/mail/node-selector'),
    staleTime: 10_000,
    retry: false,
  });
}

/**
 * PATCH the node-selector config. Backend reconciles the Stalwart
 * Deployment's nodeAffinity immediately; pod reschedules if the
 * selected node changes.
 *
 * onSuccess invalidates the GET so the card reflects the new config.
 */
export function useUpdateMailNodeSelector() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: MailNodeSelectorUpdate) =>
      apiFetch<SelectorEnvelope>('/api/v1/admin/mail/node-selector', {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: SELECTOR_KEY }),
  });
}
