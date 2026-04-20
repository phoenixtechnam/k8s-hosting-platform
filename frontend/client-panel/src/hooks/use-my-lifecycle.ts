import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

/**
 * My lifecycle state — what's the owning client's status + storage op?
 *
 * Polls /api/v1/auth/me every 10s so the banner reacts quickly when an
 * admin takes action (suspend / resize / archive) from the other panel.
 * Server-side the query reads `clients.status` + `.storage_lifecycle_state`
 * via the already-authenticated user, no extra auth gate needed.
 */

// Enum types come from the shared contracts package so a change to
// `statusEnum` or `storageLifecycleStateEnum` flows through without
// silent drift in this hook.
import type { Status as ClientStatus, StorageLifecycleState } from '@k8s-hosting/api-contracts';
export type { ClientStatus, StorageLifecycleState };

export interface MyLifecycleInfo {
  readonly clientStatus: ClientStatus | null;
  readonly storageLifecycleState: StorageLifecycleState | null;
  readonly clientId: string | null;
}

interface AuthMeResponse {
  readonly data: {
    readonly id: string;
    readonly clientId: string | null;
    readonly clientStatus?: ClientStatus | null;
    readonly storageLifecycleState?: StorageLifecycleState | null;
  };
}

export function useMyLifecycle(): { readonly data: MyLifecycleInfo | null; readonly isLoading: boolean } {
  const q = useQuery({
    queryKey: ['me-lifecycle'],
    queryFn: () => apiFetch<AuthMeResponse>('/api/v1/auth/me'),
    // Poll faster while an op is in flight; slow down when idle so the
    // banner doesn't hammer the API in normal usage.
    refetchInterval: (query) => {
      const state = query.state.data?.data?.storageLifecycleState;
      const status = query.state.data?.data?.clientStatus;
      if (state && state !== 'idle') return 3000;
      if (status === 'suspended' || status === 'archived') return 10000;
      return 30000;
    },
  });

  return {
    isLoading: q.isLoading,
    data: q.data
      ? {
          clientStatus: q.data.data.clientStatus ?? null,
          storageLifecycleState: q.data.data.storageLifecycleState ?? null,
          clientId: q.data.data.clientId,
        }
      : null,
  };
}
