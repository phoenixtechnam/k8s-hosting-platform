import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  ClusterNodeResponse,
  UpdateClusterNodeInput,
} from '@k8s-hosting/api-contracts';

// M1 C4: TanStack Query wrappers for the admin /nodes API. M4 builds
// the Nodes page UI on top of these hooks — this module is purely
// the data layer.

interface ListNodesEnvelope {
  readonly data: readonly ClusterNodeResponse[];
}
interface SingleNodeEnvelope {
  readonly data: ClusterNodeResponse;
}

export function useClusterNodes() {
  return useQuery({
    queryKey: ['cluster-nodes'],
    queryFn: () => apiFetch<ListNodesEnvelope>('/api/v1/admin/nodes'),
  });
}

export function useClusterNode(name: string | undefined) {
  return useQuery({
    queryKey: ['cluster-nodes', name],
    queryFn: () => {
      // `enabled` stops TanStack from running queryFn when name is
      // falsy, but the TS signature doesn't narrow here — do it at
      // runtime so a regression can't silently query "/nodes/".
      if (!name) throw new Error('useClusterNode called without a name');
      return apiFetch<SingleNodeEnvelope>(`/api/v1/admin/nodes/${encodeURIComponent(name)}`);
    },
    enabled: Boolean(name),
  });
}

export function useUpdateClusterNode(name: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateClusterNodeInput) =>
      apiFetch<SingleNodeEnvelope>(`/api/v1/admin/nodes/${encodeURIComponent(name)}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cluster-nodes'] });
    },
  });
}
