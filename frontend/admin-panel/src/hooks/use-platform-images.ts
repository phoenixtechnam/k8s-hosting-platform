import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface ImageInventoryEntry {
  readonly component: string;
  readonly namespace: string;
  readonly image: string;
  readonly tag: string;
  readonly running: number;
  readonly desired: number;
  readonly healthy: boolean;
}

interface ImageInventoryResponse {
  readonly data: ReadonlyArray<ImageInventoryEntry>;
}

/**
 * Fetch the inventory of container images currently deployed on the
 * cluster for platform-owned components. Shown on the Settings page
 * so operators can see what's actually running vs what the "current
 * version" string claims.
 */
export function usePlatformImages() {
  return useQuery<ImageInventoryResponse>({
    queryKey: ['platform-images'],
    queryFn: () => apiFetch('/api/v1/admin/platform/images'),
    staleTime: 30_000,
  });
}
