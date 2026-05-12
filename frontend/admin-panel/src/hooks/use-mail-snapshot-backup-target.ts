import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  MailSnapshotBackupTargetResponse,
  MailSnapshotBackupTargetUpdate,
  BackupConfigResponse,
} from '@k8s-hosting/api-contracts';

interface BackupTargetEnvelope {
  readonly data: MailSnapshotBackupTargetResponse;
}
interface BackupConfigsEnvelope {
  readonly data: readonly BackupConfigResponse[];
}

const TARGET_KEY = ['mail', 'snapshot', 'backup-target'] as const;
const BACKUP_CONFIGS_KEY = ['backup-configs'] as const;

export function useMailSnapshotBackupTarget() {
  return useQuery({
    queryKey: TARGET_KEY,
    queryFn: () => apiFetch<BackupTargetEnvelope>('/api/v1/admin/mail/snapshot-backup-target'),
    staleTime: 30_000,
    retry: false,
  });
}

/** Reuses the same backup-configs list query as the Backup Settings page. */
export function useBackupConfigs() {
  return useQuery({
    queryKey: BACKUP_CONFIGS_KEY,
    queryFn: () => apiFetch<BackupConfigsEnvelope>('/api/v1/admin/backup-configs'),
    staleTime: 60_000,
    retry: false,
  });
}

export function useUpdateMailSnapshotBackupTarget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: MailSnapshotBackupTargetUpdate) =>
      apiFetch<BackupTargetEnvelope>('/api/v1/admin/mail/snapshot-backup-target', {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: TARGET_KEY });
      void qc.invalidateQueries({ queryKey: ['mail', 'snapshot', 'status'] });
    },
  });
}
