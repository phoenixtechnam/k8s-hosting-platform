// R-X10: TanStack Query hooks for the backup-rclone-shim admin
// surface (R-X5 endpoints).

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  BackupShimClass,
  DrainNowRequest,
  DrainNowResponse,
  ListShimAssignmentsResponse,
  PutShimAssignmentRequest,
  PutShimAssignmentResponse,
  ShimStatusResponse,
} from '@k8s-hosting/api-contracts';

const ASSIGN_KEY = ['backup-rclone-shim', 'assignments'];
const STATUS_KEY = ['backup-rclone-shim', 'status'];

export function useShimAssignments() {
  return useQuery<ListShimAssignmentsResponse>({
    queryKey: ASSIGN_KEY,
    queryFn: () => apiFetch('/api/v1/admin/backup-rclone-shim/assignments'),
    staleTime: 30_000,
  });
}

export function useShimStatus() {
  return useQuery<ShimStatusResponse>({
    queryKey: STATUS_KEY,
    queryFn: () => apiFetch('/api/v1/admin/backup-rclone-shim/status'),
    staleTime: 15_000,
    refetchInterval: 60_000,
  });
}

export function usePutShimAssignment() {
  const qc = useQueryClient();
  return useMutation<
    PutShimAssignmentResponse,
    Error,
    { className: BackupShimClass; input: PutShimAssignmentRequest }
  >({
    mutationFn: ({ className, input }) =>
      apiFetch(`/api/v1/admin/backup-rclone-shim/assignments/${className}`, {
        method: 'PUT',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ASSIGN_KEY });
      qc.invalidateQueries({ queryKey: STATUS_KEY });
    },
  });
}

export function useShimDrainNow() {
  const qc = useQueryClient();
  return useMutation<DrainNowResponse, Error, DrainNowRequest>({
    mutationFn: (input) =>
      apiFetch('/api/v1/admin/backup-rclone-shim/drain-now', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: STATUS_KEY });
    },
  });
}
