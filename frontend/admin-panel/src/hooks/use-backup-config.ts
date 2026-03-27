import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

interface BackupConfig {
  readonly id: string;
  readonly name: string;
  readonly storageType: 'ssh' | 's3';
  readonly sshHost: string | null;
  readonly sshPort: number | null;
  readonly sshUser: string | null;
  readonly sshPath: string | null;
  readonly s3Endpoint: string | null;
  readonly s3Bucket: string | null;
  readonly s3Region: string | null;
  readonly s3Prefix: string | null;
  readonly retentionDays: number;
  readonly scheduleExpression: string | null;
  readonly enabled: number;
  readonly lastTestedAt: string | null;
  readonly lastTestStatus: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface BackupConfigsResponse {
  readonly data: readonly BackupConfig[];
}

interface BackupConfigResponse {
  readonly data: BackupConfig;
}

interface TestResult {
  readonly data: { status: 'ok' | 'error'; message?: string };
}

export function useBackupConfigs() {
  return useQuery({
    queryKey: ['backup-configs'],
    queryFn: () => apiFetch<BackupConfigsResponse>('/api/v1/admin/backup-configs'),
  });
}

export function useCreateBackupConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      apiFetch<BackupConfigResponse>('/api/v1/admin/backup-configs', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['backup-configs'] }),
  });
}

export function useUpdateBackupConfig(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      apiFetch<BackupConfigResponse>(`/api/v1/admin/backup-configs/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['backup-configs'] }),
  });
}

export function useDeleteBackupConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/api/v1/admin/backup-configs/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['backup-configs'] }),
  });
}

export function useTestBackupConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<TestResult>(`/api/v1/admin/backup-configs/${id}/test`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['backup-configs'] }),
  });
}
