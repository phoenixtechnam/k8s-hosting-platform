import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  OrphanedVolumesReport,
  OrphanSnapshotResponse,
  OrphanDeleteResponse,
  OrphanPurgeAllResponse,
} from '@k8s-hosting/api-contracts';

interface Envelope<T> { readonly data: T }

/**
 * List orphaned PVs / Longhorn volumes cluster-wide. Used by the
 * "Manage Orphaned Volumes" modal on the Storage tab. Re-fetched on
 * mount; the inventory tile gets its count from the platform-storage
 * endpoint instead, so this hook is only loaded when the modal opens.
 */
export function useOrphanedVolumes(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['orphaned-volumes'],
    queryFn: () =>
      apiFetch<Envelope<OrphanedVolumesReport>>('/api/v1/admin/orphaned-volumes'),
    enabled: opts.enabled ?? true,
    // Listing iterates every PV + Longhorn volume cluster-wide, so it's
    // not free — keep the cache hot for 30s while the modal is open and
    // fall back to a fresh fetch only when the operator manually refreshes.
    staleTime: 30_000,
  });
}

export function useSnapshotOrphan() {
  return useMutation({
    mutationFn: (volumeName: string) =>
      apiFetch<Envelope<OrphanSnapshotResponse>>(
        `/api/v1/admin/orphaned-volumes/${encodeURIComponent(volumeName)}/snapshot`,
        { method: 'POST', body: JSON.stringify({}) },
      ),
  });
}

/**
 * Delete an orphan row. Two call shapes — pass exactly one of:
 *   - `{ volumeName, pvName }` for PV / Longhorn-backed orphans
 *   - `{ namespace }` for `namespace_orphaned` rows (no PV / volume)
 * The route is chosen automatically; passing both throws.
 */
export interface DeleteOrphanInput {
  readonly volumeName?: string;
  readonly pvName?: string | null;
  readonly namespace?: string;
}

export function useDeleteOrphan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: DeleteOrphanInput) => {
      if (input.namespace) {
        return apiFetch<Envelope<OrphanDeleteResponse>>(
          `/api/v1/admin/orphaned-volumes/by-namespace/${encodeURIComponent(input.namespace)}`,
          { method: 'DELETE' },
        );
      }
      if (!input.volumeName) {
        throw new Error('useDeleteOrphan requires either `volumeName` or `namespace`');
      }
      const qs = input.pvName ? `?pvName=${encodeURIComponent(input.pvName)}` : '';
      return apiFetch<Envelope<OrphanDeleteResponse>>(
        `/api/v1/admin/orphaned-volumes/${encodeURIComponent(input.volumeName)}${qs}`,
        { method: 'DELETE' },
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['orphaned-volumes'] });
      qc.invalidateQueries({ queryKey: ['platform-storage'] });
      qc.invalidateQueries({ queryKey: ['nodes'] });
    },
  });
}

/**
 * Purge every orphan in a single round-trip. Per-row failures come back
 * inside the response payload — the mutation only rejects on transport
 * / auth errors. Surface `failures.length > 0` to the operator.
 *
 * `stalePvThresholdDays` MUST match what the operator currently sees in
 * the list, otherwise the purge classifies a different set of rows than
 * the modal showed (default 7d on the server vs. an active 1d filter
 * means the operator could see one set and purge a wider one).
 */
export function usePurgeAllOrphans() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { stalePvThresholdDays?: number } = {}) => {
      const qs = input.stalePvThresholdDays !== undefined
        ? `?stalePvThresholdDays=${encodeURIComponent(String(input.stalePvThresholdDays))}`
        : '';
      return apiFetch<Envelope<OrphanPurgeAllResponse>>(
        `/api/v1/admin/orphaned-volumes/purge-all${qs}`,
        { method: 'POST' },
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['orphaned-volumes'] });
      qc.invalidateQueries({ queryKey: ['platform-storage'] });
      qc.invalidateQueries({ queryKey: ['nodes'] });
    },
  });
}
