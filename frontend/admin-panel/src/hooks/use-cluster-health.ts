import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface ComponentReadiness {
  readonly name: string;
  readonly namespace: string;
  readonly kind: 'Deployment' | 'DaemonSet';
  readonly desired: number;
  readonly ready: number;
  readonly healthy: boolean;
  readonly message?: string;
}

export function useClusterHealth() {
  return useQuery({
    queryKey: ['cluster-health'],
    queryFn: () => apiFetch<{ data: { components: readonly ComponentReadiness[] } }>('/api/v1/admin/cluster-health'),
    refetchInterval: 30_000,
  });
}

export type NodeSubsystemStatus = 'healthy' | 'degraded' | 'missing';

export interface NodeSubsystemReport {
  readonly nodeName: string;
  readonly calico: NodeSubsystemStatus;
  readonly calicoMessage?: string;
  readonly longhornCsi: NodeSubsystemStatus;
  readonly longhornCsiMessage?: string;
  readonly csiDriverRegistered: boolean;
}

export function useNodeSubsystemHealth() {
  return useQuery({
    queryKey: ['cluster-health', 'nodes'],
    queryFn: () => apiFetch<{ data: { nodes: readonly NodeSubsystemReport[] } }>('/api/v1/admin/cluster-health/nodes'),
    refetchInterval: 60_000,
  });
}
