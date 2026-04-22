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
  // Designates the cluster's current Longhorn backup target. At most
  // one config is active at a time (enforced by DB partial unique index).
  readonly active: boolean;
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

// Response shape of POST /admin/backup-configs/:id/test and
// /admin/backup-configs/test-draft. Mirrors the backend
// TestConnectionResult type (service.ts) so UI components can display
// both latency and structured error codes in a consistent way.
interface TestResult {
  readonly data: {
    readonly ok: boolean;
    readonly latencyMs: number;
    readonly error?: { readonly code: string; readonly message: string };
  };
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

// Update by PATCH. id is part of the mutation args (not a hook param)
// so a single hook instance can edit any row — the parent component
// doesn't need to re-create the hook when the selected row changes.
export function useUpdateBackupConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: Record<string, unknown> }) =>
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

// Test a backup target BEFORE persisting it. Called from the
// Create / Edit form so operators can confirm connectivity before they
// commit a config that wouldn't actually work when RecurringJob fires.
export function useTestBackupDraft() {
  return useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      apiFetch<TestResult>('/api/v1/admin/backup-configs/test-draft', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
  });
}

// Activate this config as the cluster's Longhorn backup target. The
// backend also reconciles the cluster state (BackupTarget CR + Secret)
// so a successful response means the target is actually wired up.
export function useActivateBackupConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<BackupConfigResponse>(`/api/v1/admin/backup-configs/${id}/activate`, {
        method: 'POST',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['backup-configs'] }),
  });
}

export function useDeactivateBackupConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<BackupConfigResponse>(`/api/v1/admin/backup-configs/${id}/deactivate`, {
        method: 'POST',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['backup-configs'] }),
  });
}

// ─── Longhorn Backups (read + manual trigger) ────────────────────────────

interface BackupRecord {
  readonly name: string;
  readonly volumeName: string;
  readonly size: string;
  readonly state: string;
  readonly createdAt: string | null;
  readonly url: string;
}

interface BackupsResponse {
  readonly data: readonly BackupRecord[];
}

interface BackupNowResponse {
  readonly data: { triggered: string[]; message: string };
}

export function useBackupList(configId: string | null) {
  return useQuery({
    queryKey: ['backup-list', configId],
    enabled: !!configId,
    queryFn: () =>
      apiFetch<BackupsResponse>(`/api/v1/admin/backup-configs/${configId}/backups`),
    // Backups take seconds-to-minutes — poll every 30s when operators
    // are watching a Backup-Now trigger land.
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}

export function useBackupNow(configId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<BackupNowResponse>(`/api/v1/admin/backup-configs/${configId}/backup-now`, {
        method: 'POST',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['backup-list', configId] }),
  });
}
