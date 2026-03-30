import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  ApplicationInstanceResponse,
  AvailableUpgrade,
  ApplicationUpgradeResponse,
} from '@k8s-hosting/api-contracts';

interface InstanceListResponse {
  readonly data: readonly ApplicationInstanceResponse[];
}

interface AvailableUpgradesResponse {
  readonly data: readonly AvailableUpgrade[];
}

interface UpgradeListResponse {
  readonly data: readonly ApplicationUpgradeResponse[];
}

export function useApplicationInstances(clientId: string | null) {
  return useQuery({
    queryKey: ['application-instances', clientId],
    queryFn: () => apiFetch<InstanceListResponse>(`/api/v1/clients/${clientId}/application-instances`),
    enabled: !!clientId,
    staleTime: 30_000,
  });
}

export function useClientAvailableUpgrades(clientId: string | null, instanceId: string | null) {
  return useQuery({
    queryKey: ['client-available-upgrades', clientId, instanceId],
    queryFn: () =>
      apiFetch<AvailableUpgradesResponse>(
        `/api/v1/clients/${clientId}/application-instances/${instanceId}/available-upgrades`,
      ),
    enabled: !!clientId && !!instanceId,
    staleTime: 60_000,
  });
}

export function useClientUpgradeHistory(clientId: string | null) {
  return useQuery({
    queryKey: ['client-upgrade-history', clientId],
    queryFn: () => apiFetch<UpgradeListResponse>(`/api/v1/clients/${clientId}/application-upgrades`),
    enabled: !!clientId,
    staleTime: 30_000,
  });
}
