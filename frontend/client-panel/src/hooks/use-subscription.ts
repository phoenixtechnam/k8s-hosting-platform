/**
 * Round-4 Phase C: client-panel subscription viewing hook.
 *
 * Backend endpoint: `GET /api/v1/clients/:id/subscription` — now
 * accessible to client_admin + client_user (scoped to the
 * authenticated client's own id via requireClientAccess).
 *
 * PATCH remains admin/billing-only, so there is no mutation hook
 * here.
 */

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface SubscriptionPlan {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly cpuLimit: string;
  readonly memoryLimit: string;
  readonly storageLimit: string;
  readonly monthlyPriceUsd: string;
  readonly maxSubUsers: number;
  readonly maxMailboxes: number;
  readonly status: string;
}

export interface Subscription {
  readonly client_id: string;
  readonly plan: SubscriptionPlan | null;
  readonly status: string;
  readonly subscription_expires_at: string | null;
  readonly created_at: string;
}

export function useSubscription(clientId: string | undefined) {
  return useQuery({
    queryKey: ['subscription', clientId],
    queryFn: () =>
      apiFetch<{ data: Subscription }>(`/api/v1/clients/${clientId}/subscription`),
    enabled: Boolean(clientId),
    staleTime: 60_000,
  });
}
