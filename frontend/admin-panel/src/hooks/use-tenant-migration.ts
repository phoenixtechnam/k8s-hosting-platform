import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

interface MigrateResult {
  readonly data: {
    readonly clientId: string;
    readonly previousWorker: string | null;
    readonly currentWorker: string;
    readonly deploymentsRestarted: number;
  };
}

export function useMigrateClientToWorker(clientId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (workerNodeName: string) =>
      apiFetch<MigrateResult>(`/api/v1/admin/clients/${clientId}/migrate-to-worker`, {
        method: 'POST',
        body: JSON.stringify({ worker_node_name: workerNodeName }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['clients', clientId] });
      qc.invalidateQueries({ queryKey: ['clients'] });
      qc.invalidateQueries({ queryKey: ['cluster-nodes'] });
    },
  });
}
