import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface NodeDiskInfo {
  readonly diskKey: string;
  readonly path: string;
  readonly allowScheduling: boolean;
  readonly tags: readonly string[];
  readonly storageMaximum: number;
  readonly storageScheduled: number;
  readonly storageReserved: number;
  readonly storageAvailable: number;
  readonly freeToSchedule: number;
}

interface NodeStorageEnvelope {
  readonly data: {
    readonly nodeName: string;
    readonly disks: readonly NodeDiskInfo[];
  };
}

export function useNodeStorage(name: string | undefined) {
  return useQuery({
    queryKey: ['node-storage', name],
    queryFn: () => {
      if (!name) throw new Error('useNodeStorage called without a name');
      return apiFetch<NodeStorageEnvelope>(
        `/api/v1/admin/nodes/${encodeURIComponent(name)}/storage`,
      );
    },
    enabled: Boolean(name),
    staleTime: 15_000,
  });
}

export interface PatchDiskInput {
  readonly storageReserved?: number;
  readonly allowScheduling?: boolean;
}

export function usePatchNodeDisk(nodeName: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ diskKey, input }: { diskKey: string; input: PatchDiskInput }) =>
      apiFetch<{ data: { nodeName: string; diskKey: string; patched: PatchDiskInput } }>(
        `/api/v1/admin/nodes/${encodeURIComponent(nodeName)}/storage/${encodeURIComponent(diskKey)}`,
        {
          method: 'PATCH',
          body: JSON.stringify(input),
        },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['node-storage', nodeName] });
    },
  });
}
