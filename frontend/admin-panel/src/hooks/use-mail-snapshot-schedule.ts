import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  MailSnapshotScheduleResponse,
  MailSnapshotScheduleUpdate,
} from '@k8s-hosting/api-contracts';

interface ScheduleEnvelope {
  readonly data: MailSnapshotScheduleResponse;
}

const SCHEDULE_KEY = ['mail', 'snapshot', 'schedule'] as const;

export function useMailSnapshotSchedule() {
  return useQuery({
    queryKey: SCHEDULE_KEY,
    queryFn: () => apiFetch<ScheduleEnvelope>('/api/v1/admin/mail/snapshot-schedule'),
    staleTime: 30_000,
    retry: false,
  });
}

export function useUpdateMailSnapshotSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: MailSnapshotScheduleUpdate) =>
      apiFetch<ScheduleEnvelope>('/api/v1/admin/mail/snapshot-schedule', {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: SCHEDULE_KEY });
      void qc.invalidateQueries({ queryKey: ['mail', 'snapshot', 'status'] });
    },
  });
}
