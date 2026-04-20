import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

/**
 * Storage-lifecycle settings (admin-only). Secrets are never returned
 * by the API — the payload contains `*Set` booleans so the UI can
 * render a "secret configured" indicator without ever learning the
 * plaintext value.
 */
export interface StorageLifecycleSettings {
  readonly backend: 'hostpath' | 's3' | 'azure';
  readonly hostpathRoot: string;
  readonly s3Bucket: string | null;
  readonly s3Region: string | null;
  readonly s3Endpoint: string | null;
  readonly s3AccessKeyId: string | null;
  readonly s3SecretAccessKey: null;
  readonly s3SecretAccessKeySet: boolean;
  readonly azureContainer: string | null;
  readonly azureConnectionString: null;
  readonly azureConnectionStringSet: boolean;
  readonly retentionManualDays: number;
  readonly retentionPreResizeDays: number;
  readonly retentionPreArchiveDays: number;
}

export interface StorageLifecycleSettingsUpdate {
  readonly backend?: 'hostpath' | 's3' | 'azure';
  readonly hostpathRoot?: string;
  readonly s3Bucket?: string | null;
  readonly s3Region?: string | null;
  readonly s3Endpoint?: string | null;
  readonly s3AccessKeyId?: string | null;
  readonly s3SecretAccessKey?: string | null;
  readonly azureContainer?: string | null;
  readonly azureConnectionString?: string | null;
  readonly retentionManualDays?: number;
  readonly retentionPreResizeDays?: number;
  readonly retentionPreArchiveDays?: number;
}

export function useStorageLifecycleSettings() {
  return useQuery({
    queryKey: ['storage-lifecycle-settings'],
    queryFn: () => apiFetch<{ data: StorageLifecycleSettings }>('/api/v1/admin/settings/storage-lifecycle'),
  });
}

export function useUpdateStorageLifecycleSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: StorageLifecycleSettingsUpdate) =>
      apiFetch<{ data: StorageLifecycleSettings }>('/api/v1/admin/settings/storage-lifecycle', {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['storage-lifecycle-settings'] });
    },
  });
}
