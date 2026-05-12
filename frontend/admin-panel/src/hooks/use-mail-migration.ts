import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  MailMigrationStartRequest,
  MailMigrationStatusResponse,
} from '@k8s-hosting/api-contracts';

const TERMINAL_STATES = new Set(['done', 'failed', 'rolled-back']);

interface MigrationStatusEnvelope {
  readonly data: MailMigrationStatusResponse;
}
interface RunIdEnvelope {
  readonly data: { readonly runId: string };
}

export function useMailMigrationStatus(runId: string | null) {
  return useQuery({
    queryKey: ['mail', 'migration', runId],
    queryFn: () =>
      apiFetch<MigrationStatusEnvelope>(`/api/v1/admin/mail/migrate/${runId}`),
    enabled: runId != null,
    refetchInterval: (query) => {
      const state = query.state.data?.data.state;
      if (state && TERMINAL_STATES.has(state)) return false;
      return 3_000;
    },
    retry: false,
  });
}

export function useStartMailMigration() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: MailMigrationStartRequest) =>
      apiFetch<RunIdEnvelope>('/api/v1/admin/mail/migrate', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['mail', 'placement'] });
      void qc.invalidateQueries({ queryKey: ['mail', 'pvc', 'storage'] });
    },
  });
}
