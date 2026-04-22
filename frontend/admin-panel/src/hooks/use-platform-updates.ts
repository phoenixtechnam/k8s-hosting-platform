import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

interface PlatformVersionResponse {
  readonly data: {
    readonly currentVersion: string;
    readonly latestVersion: string | null;
    readonly latestSource: 'releases' | 'tags' | 'none' | 'unreachable';
    readonly updateAvailable: boolean;
    readonly environment: string;
    readonly autoUpdate: boolean;
    readonly imageUpdateStrategy: 'auto' | 'manual';
    readonly pendingVersion: string | null;
    readonly lastCheckedAt: string | null;
  };
}

export type PlatformVersionData = PlatformVersionResponse['data'];

export function usePlatformVersion() {
  return useQuery({
    queryKey: ['platform-version'],
    queryFn: () => apiFetch<PlatformVersionResponse>('/api/v1/admin/platform/version'),
    refetchInterval: 5 * 60 * 1000,
    staleTime: 60 * 1000,
  });
}

export function useUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (autoUpdate: boolean) =>
      apiFetch('/api/v1/admin/platform/update-settings', {
        method: 'PUT',
        body: JSON.stringify({ autoUpdate }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['platform-version'] }),
  });
}

export function useTriggerUpdate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch('/api/v1/admin/platform/update', { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['platform-version'] }),
  });
}
