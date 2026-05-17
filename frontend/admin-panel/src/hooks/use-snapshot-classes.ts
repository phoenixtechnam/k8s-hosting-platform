import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  ListClassesResponse,
  SetAssignmentsInput,
  SetAssignmentsResponse,
  SnapshotClass,
  TestClassResponse,
  TargetSummariesResponse,
} from '@k8s-hosting/api-contracts';

interface ApiEnvelope<T> {
  readonly data: T;
}

const CLASS_KEY = ['snapshot-classes'];
const SUMMARIES_KEY = ['snapshot-target-summaries'];

export function useSnapshotClasses() {
  return useQuery<ApiEnvelope<ListClassesResponse>>({
    queryKey: CLASS_KEY,
    queryFn: () => apiFetch('/api/v1/admin/snapshots/classes'),
    staleTime: 30_000,
  });
}

export function useTargetSummaries() {
  return useQuery<ApiEnvelope<TargetSummariesResponse>>({
    queryKey: SUMMARIES_KEY,
    queryFn: () => apiFetch('/api/v1/admin/snapshots/target-summaries'),
    staleTime: 30_000,
  });
}

export function useSetAssignments() {
  const qc = useQueryClient();
  return useMutation<
    ApiEnvelope<SetAssignmentsResponse>,
    Error,
    { snapshotClass: SnapshotClass; input: SetAssignmentsInput }
  >({
    mutationFn: ({ snapshotClass, input }) =>
      apiFetch(`/api/v1/admin/snapshots/classes/${snapshotClass}/assignments`, {
        method: 'PUT',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: CLASS_KEY });
      qc.invalidateQueries({ queryKey: SUMMARIES_KEY });
    },
  });
}

export function useTestSnapshotClass() {
  return useMutation<ApiEnvelope<TestClassResponse>, Error, SnapshotClass>({
    mutationFn: (snapshotClass) =>
      apiFetch(`/api/v1/admin/snapshots/classes/${snapshotClass}/test`, {
        method: 'POST',
      }),
  });
}
