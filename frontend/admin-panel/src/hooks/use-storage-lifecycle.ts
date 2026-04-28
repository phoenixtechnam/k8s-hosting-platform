import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface StorageSnapshot {
  readonly id: string;
  readonly clientId: string;
  readonly kind: 'manual' | 'pre-resize' | 'pre-suspend' | 'pre-archive' | 'scheduled';
  readonly status: 'creating' | 'ready' | 'expired' | 'failed';
  readonly archivePath: string;
  readonly sizeBytes: string;
  readonly sha256: string | null;
  readonly expiresAt: string | null;
  readonly label: string | null;
  readonly lastError: string | null;
  readonly createdAt: string;
}

export interface StorageOperation {
  readonly id: string;
  readonly clientId: string;
  readonly opType: 'snapshot' | 'resize' | 'suspend' | 'resume' | 'archive' | 'restore';
  readonly state: 'idle' | 'snapshotting' | 'quiescing' | 'replacing' | 'restoring' | 'unquiescing' | 'failed';
  readonly progressPct: number;
  readonly progressMessage: string | null;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

export interface AuditRow {
  readonly clientId: string;
  readonly namespace: string;
  readonly provisionedGi: number;
  readonly usedBytes: number;
  readonly wastePct: number;
}

export function useSnapshots(clientId: string | undefined) {
  return useQuery<{ data: StorageSnapshot[] }>({
    queryKey: ['snapshots', clientId],
    queryFn: () => apiFetch(`/api/v1/admin/clients/${clientId}/storage/snapshots`),
    enabled: !!clientId,
  });
}

export function useStorageOperations(clientId: string | undefined) {
  return useQuery<{ data: StorageOperation[] }>({
    queryKey: ['storage-operations', clientId],
    queryFn: () => apiFetch(`/api/v1/admin/clients/${clientId}/storage/operations`),
    enabled: !!clientId,
    refetchInterval: (query) => {
      // Poll every 2s while an op is in flight, else stop.
      const data = (query.state.data as { data?: StorageOperation[] } | undefined)?.data;
      return data?.some((o) => o.state !== 'idle' && o.state !== 'failed' && !o.completedAt) ? 2000 : false;
    },
  });
}

export function useStorageAudit() {
  return useQuery<{ data: AuditRow[] }>({
    queryKey: ['storage-audit'],
    queryFn: () => apiFetch('/api/v1/admin/storage/audit'),
    staleTime: 60_000,
  });
}

export function useCreateSnapshot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { clientId: string; label?: string; retentionDays?: number }) => {
      return apiFetch(`/api/v1/admin/clients/${input.clientId}/storage/snapshot`, {
        method: 'POST',
        body: JSON.stringify({ label: input.label, retentionDays: input.retentionDays }),
      });
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['snapshots', vars.clientId] });
      qc.invalidateQueries({ queryKey: ['storage-operations', vars.clientId] });
    },
  });
}

export function useDeleteSnapshot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (snapshotId: string) => {
      return apiFetch(`/api/v1/admin/storage/snapshots/${snapshotId}`, { method: 'DELETE' });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['snapshots'] }),
  });
}

export interface ResizeDryRun {
  readonly currentGi: number;
  readonly currentMib: number;
  readonly requestedGi: number;
  readonly requestedMib: number;
  readonly usedBytes: number;
  readonly willFit: boolean;
  readonly rejectReason: string | null;
  readonly estimatedSeconds: number;
}

export function useResizeDryRun() {
  return useMutation<{ data: ResizeDryRun }, Error, { clientId: string; newMib: number }>({
    mutationFn: async ({ clientId, newMib }) => apiFetch(`/api/v1/admin/clients/${clientId}/storage/resize/dry-run`, {
      method: 'POST',
      body: JSON.stringify({ newMib }),
    }),
  });
}

export function useResizeClient() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ clientId, newMib }: { clientId: string; newMib: number }) =>
      apiFetch<{ data: { operationId: string } }>(`/api/v1/admin/clients/${clientId}/storage/resize`, {
        method: 'POST',
        body: JSON.stringify({ newMib }),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['storage-operations', vars.clientId] });
      qc.invalidateQueries({ queryKey: ['snapshots', vars.clientId] });
    },
  });
}

export function useSuspendClient() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (clientId: string) =>
      apiFetch(`/api/v1/admin/clients/${clientId}/storage/suspend`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries(),
  });
}

export function useResumeClient() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (clientId: string) =>
      apiFetch(`/api/v1/admin/clients/${clientId}/storage/resume`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries(),
  });
}

export function useArchiveClient() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ clientId, retentionDays }: { clientId: string; retentionDays?: number }) =>
      apiFetch(`/api/v1/admin/clients/${clientId}/storage/archive`, {
        method: 'POST',
        body: JSON.stringify({ retentionDays }),
      }),
    onSuccess: () => qc.invalidateQueries(),
  });
}

export function useRestoreClient() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ clientId, newGi }: { clientId: string; newGi?: number }) =>
      apiFetch(`/api/v1/admin/clients/${clientId}/storage/restore`, {
        method: 'POST',
        body: JSON.stringify({ newGi }),
      }),
    onSuccess: () => qc.invalidateQueries(),
  });
}

/**
 * Force-clear a client's stuck 'failed' storage-lifecycle state. Only
 * callable when the client is actually in 'failed' (the backend
 * enforces this — UI should only show this control when the state
 * has the red X badge).
 */
export function useClearFailedState() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (clientId: string) =>
      apiFetch(`/api/v1/admin/clients/${clientId}/storage/clear-failed`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries(),
  });
}

// ─── PVC node placement (Storage Lifecycle node-host column) ───
//
// Backend joins the client's PVC → Longhorn volume → running replicas
// to surface which node currently holds the data. Refreshes on the
// same cadence as the rest of the lifecycle UI.

export interface ClientPvcPlacement {
  readonly namespace: string;
  readonly pvcName: string;
  readonly volumeName: string;
  readonly sizeBytes: number;
  readonly usedBytes: number;
  readonly state: string | null;
  readonly robustness: string | null;
  readonly replicaNodes: readonly string[];
}

export function useClientStoragePlacement(clientId: string | undefined) {
  return useQuery({
    queryKey: ['client-storage-placement', clientId],
    queryFn: async () => {
      if (!clientId) throw new Error('useClientStoragePlacement called without a clientId');
      return apiFetch<{ data: { pvcs: ClientPvcPlacement[] } }>(
        `/api/v1/clients/${encodeURIComponent(clientId)}/storage-placement`,
      );
    },
    enabled: Boolean(clientId),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}
